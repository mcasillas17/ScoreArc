// Package cdnurl holds the one rule for provider media URLs that we fetch
// (asset mirroring) or serve to browsers (player headshots). It has no
// dependencies so the provider mappers can use it without the AWS SDK.
package cdnurl

import (
	"net/url"
	"strings"
)

var articleDomains = []string{
	"espn.com",
	"espn.co.uk",
	"espn.com.mx",
	"espn.com.ar",
	"espn.com.br",
	"espn.com.co",
	"espn.com.au",
	"espn.cl",
	"espn.in",
	"espndeportes.com",
	"espnfc.com",
	"andscape.com",
}

func isPlainHTTPS(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.Host != "" &&
		u.User == nil && (u.Port() == "" || u.Port() == "443")
}

func hostMatches(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// ProviderMedia reports whether u is an https URL on ESPN's CDN with no
// credentials and no non-default port. IP literals never match the host rule.
func ProviderMedia(u *url.URL) bool {
	if !isPlainHTTPS(u) {
		return false
	}
	return hostMatches(strings.ToLower(u.Hostname()), "espncdn.com")
}

// ProviderArticle reports whether u is an https URL on an editorial ESPN
// property with no credentials and no non-default port.
func ProviderArticle(u *url.URL) bool {
	if !isPlainHTTPS(u) {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, domain := range articleDomains {
		if hostMatches(host, domain) {
			return true
		}
	}
	return false
}

// ProviderContentMedia reports whether u is an https URL on an allowed ESPN
// image or video host with no credentials and no non-default port.
func ProviderContentMedia(u *url.URL) bool {
	if !isPlainHTTPS(u) {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return hostMatches(host, "espncdn.com") ||
		hostMatches(host, "espn.com") ||
		host == "espnmedia-cdn.akamaized.net"
}

// ValidArticleURL returns raw unchanged when it satisfies ProviderArticle, or "".
func ValidArticleURL(raw string) string {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || !ProviderArticle(u) {
		return ""
	}
	return raw
}

// ValidContentMediaURL returns raw unchanged when it satisfies ProviderContentMedia, or "".
func ValidContentMediaURL(raw string) string {
	if raw == "" || strings.TrimSpace(raw) != raw {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || !ProviderContentMedia(u) {
		return ""
	}
	return raw
}
