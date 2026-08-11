package main

import (
	"container/list"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
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

func (l *ipRateLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	if l.lastSweep.IsZero() || now.Sub(l.lastSweep) >= time.Minute {
		for key, client := range l.clients {
			if now.Sub(client.lastSeen) > 3*time.Minute {
				delete(l.clients, key)
				l.lru.Remove(client.element)
			}
		}
		l.lastSweep = now
	}

	client, exists := l.clients[ip]
	if !exists {
		if len(l.clients) >= l.maxClients {
			oldest := l.lru.Front()
			if oldest != nil {
				delete(l.clients, oldest.Value.(string))
				l.lru.Remove(oldest)
			}
		}
		element := l.lru.PushBack(ip)
		client = &clientLimiter{limiter: rate.NewLimiter(l.rps, l.burst), element: element}
		l.clients[ip] = client
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
