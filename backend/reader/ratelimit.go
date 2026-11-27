package main

import (
	"container/list"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// ponytail: separate trusted-caller and anonymous-client limits so the website
// and watchdog keep high headroom via READER_TRUSTED_KEY while public callers
// stay bounded (and IPv6 /64 prefixes share one bucket). When READER_TRUSTED_KEY
// is unset, anonymous callers keep the transition limit so existing deploys do
// not break before secrets are provisioned.
const (
	trustedRequestsPerSecond  = 50
	trustedBurst              = 200
	publicRequestsPerSecond   = 5
	publicBurst               = 15
	clientRequestsPerSecond   = 50
	clientBurst               = 200
	globalAnonymousRPS        = 200
	globalAnonymousBurst      = 400
	trustedCallerHeader       = "X-ScoreArc-Client-Key"
)

type clientLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
	element  *list.Element
}

// ipRateLimiter owns no background goroutine. Idle clients are swept at most
// once per minute by the next request that reaches Allow.
type ipRateLimiter struct {
	mu         sync.Mutex
	clients    map[string]*clientLimiter
	rps        rate.Limit
	burst      int
	global     *rate.Limiter
	maxClients int
	lru        *list.List
	now        func() time.Time
	lastSweep  time.Time
}

func newIPRateLimiter(requestsPerSecond float64, burst int) *ipRateLimiter {
	return &ipRateLimiter{
		clients:    make(map[string]*clientLimiter),
		rps:        rate.Limit(requestsPerSecond),
		burst:      burst,
		maxClients: 10_000,
		lru:        list.New(),
		now:        time.Now,
	}
}

func newIPRateLimiterWithGlobal(requestsPerSecond float64, burst int, globalRPS float64, globalBurst int) *ipRateLimiter {
	limiter := newIPRateLimiter(requestsPerSecond, burst)
	limiter.global = rate.NewLimiter(rate.Limit(globalRPS), globalBurst)
	return limiter
}

// rateLimitKey groups IPv6 clients by /64 prefix and unmaps IPv4-mapped IPv6
// addresses so a single /64 allocation cannot multiply buckets or churn the LRU.
func rateLimitKey(ip string) string {
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap()
	if addr.Is4() {
		return addr.String()
	}
	return netip.PrefixFrom(addr, 64).Masked().String()
}

func (l *ipRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if l.global != nil && !l.global.AllowN(now, 1) {
		return false
	}

	if l.lastSweep.IsZero() || now.Sub(l.lastSweep) >= time.Minute {
		for key, client := range l.clients {
			if now.Sub(client.lastSeen) > 3*time.Minute {
				delete(l.clients, key)
				l.lru.Remove(client.element)
			}
		}
		l.lastSweep = now
	}

	key := rateLimitKey(ip)
	client, exists := l.clients[key]
	if !exists {
		if len(l.clients) >= l.maxClients {
			oldest := l.lru.Front()
			if oldest != nil {
				delete(l.clients, oldest.Value.(string))
				l.lru.Remove(oldest)
			}
		}
		element := l.lru.PushBack(key)
		client = &clientLimiter{limiter: rate.NewLimiter(l.rps, l.burst), element: element}
		l.clients[key] = client
	} else {
		l.lru.MoveToBack(client.element)
	}
	client.lastSeen = now
	return client.limiter.AllowN(now, 1)
}

// clientIP trusts Fly-Client-IP only when it contains exactly one valid IP.
// Fly's HTTP handler supplies this header in production. X-Forwarded-For is
// intentionally ignored because arbitrary forwarding chains are spoofable.
func clientIP(request *http.Request) string {
	if raw := strings.TrimSpace(request.Header.Get("Fly-Client-IP")); raw != "" {
		if ip := net.ParseIP(raw); ip != nil {
			return ip.String()
		}
	}

	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	host = strings.TrimSpace(host)
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	return host
}
