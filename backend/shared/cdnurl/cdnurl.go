// Package cdnurl holds the one rule for provider media URLs that we fetch
// (asset mirroring) or serve to browsers (player headshots). It has no
// dependencies so the provider mappers can use it without the AWS SDK.
package cdnurl

import (
	"net/url"
	"strings"
)

// ProviderMedia reports whether u is an https URL on ESPN's CDN with no
// credentials and no non-default port. IP literals never match the host rule.
func ProviderMedia(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "espncdn.com" || strings.HasSuffix(host, ".espncdn.com")
}
