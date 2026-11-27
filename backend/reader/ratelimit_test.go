package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientIP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		remoteAddr string
		flyIP      string
		xff        string
		want       string
	}{
		{name: "IPv4 peer", remoteAddr: "192.0.2.10:4321", want: "192.0.2.10"},
		{name: "IPv6 peer", remoteAddr: "[2001:db8::10]:4321", want: "2001:db8::10"},
		{name: "peer without port", remoteAddr: "192.0.2.11", want: "192.0.2.11"},
		{name: "valid Fly client IPv4", remoteAddr: "172.16.0.1:1234", flyIP: "198.51.100.4", want: "198.51.100.4"},
		{name: "valid Fly client IPv6", remoteAddr: "172.16.0.1:1234", flyIP: "2001:db8::20", want: "2001:db8::20"},
		{name: "malformed Fly header falls back", remoteAddr: "192.0.2.12:1234", flyIP: "spoofed", want: "192.0.2.12"},
		{name: "X-Forwarded-For is ignored", remoteAddr: "192.0.2.13:1234", xff: "203.0.113.1, 203.0.113.2", want: "192.0.2.13"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest("GET", "/", nil)
			request.RemoteAddr = tt.remoteAddr
			request.Header.Set("Fly-Client-IP", tt.flyIP)
			request.Header.Set("X-Forwarded-For", tt.xff)
			if got := clientIP(request); got != tt.want {
				t.Fatalf("clientIP() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestIPRateLimiterTokenBucketAndEviction(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	limiter := newIPRateLimiter(1, 2)
	limiter.now = func() time.Time { return now }

	if !limiter.Allow("192.0.2.1") || !limiter.Allow("192.0.2.1") {
		t.Fatal("initial burst was not allowed")
	}
	if limiter.Allow("192.0.2.1") {
		t.Fatal("request beyond burst was allowed")
	}
	now = now.Add(time.Second)
	if !limiter.Allow("192.0.2.1") {
		t.Fatal("token did not refill")
	}

	if !limiter.Allow("192.0.2.2") {
		t.Fatal("independent IP was not allowed")
	}
	if len(limiter.clients) != 2 {
		t.Fatalf("clients = %d, want 2", len(limiter.clients))
	}
	now = now.Add(4 * time.Minute)
	if !limiter.Allow("192.0.2.3") {
		t.Fatal("new IP was not allowed")
	}
	if len(limiter.clients) != 1 {
		t.Fatalf("clients after idle eviction = %d, want 1", len(limiter.clients))
	}
}

func TestIPRateLimiterBoundsUniqueClients(t *testing.T) {
	t.Parallel()
	limiter := newIPRateLimiter(1, 1)
	limiter.maxClients = 2

	limiter.Allow("192.0.2.1")
	limiter.Allow("192.0.2.2")
	limiter.Allow("192.0.2.1") // refresh client 1; client 2 is now least recent
	limiter.Allow("192.0.2.3")
	if len(limiter.clients) != 2 {
		t.Fatalf("clients = %d, want hard limit 2", len(limiter.clients))
	}
	if _, exists := limiter.clients["192.0.2.2"]; exists {
		t.Fatal("least-recently-used client was not evicted")
	}
}

func TestIPRateLimiterBucketsIPv6BySlash64AndUnmapsIPv4(t *testing.T) {
	t.Parallel()
	limiter := newIPRateLimiter(0, 2)

	if !limiter.Allow("2001:db8:1:2::1") || !limiter.Allow("2001:db8:1:2::abcd") {
		t.Fatal("requests within the same /64 burst were not allowed")
	}
	if limiter.Allow("2001:db8:1:2::9999") {
		t.Fatal("third request from same IPv6 /64 bypassed shared bucket")
	}
	if len(limiter.clients) != 1 {
		t.Fatalf("clients = %d, want 1 bucket for the /64 prefix", len(limiter.clients))
	}

	// Separate /64 gets its own bucket.
	if !limiter.Allow("2001:db8:1:3::1") {
		t.Fatal("separate /64 was unexpectedly limited")
	}
	if len(limiter.clients) != 2 {
		t.Fatalf("clients = %d, want 2 buckets across distinct /64 prefixes", len(limiter.clients))
	}

	// IPv4-mapped IPv6 shares the IPv4 bucket.
	v4Limiter := newIPRateLimiter(0, 1)
	if !v4Limiter.Allow("192.0.2.10") {
		t.Fatal("first IPv4 request failed")
	}
	if v4Limiter.Allow("::ffff:192.0.2.10") {
		t.Fatal("IPv4-mapped IPv6 bypassed the IPv4 bucket")
	}
	if len(v4Limiter.clients) != 1 {
		t.Fatalf("clients = %d, want 1", len(v4Limiter.clients))
	}
}

func TestIPRateLimiterGlobalCeilingDoesNotChurnLRU(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 11, 0, 0, 0, 0, time.UTC)
	limiter := newIPRateLimiterWithGlobal(5, 5, 1, 2)
	limiter.now = func() time.Time { return now }

	if !limiter.Allow("192.0.2.1") || !limiter.Allow("192.0.2.2") {
		t.Fatal("initial global burst failed")
	}
	if limiter.Allow("192.0.2.3") {
		t.Fatal("third distinct IP bypassed global burst")
	}
	if len(limiter.clients) != 2 {
		t.Fatalf("clients = %d, want 2 (global denial must not insert into LRU)", len(limiter.clients))
	}
}
