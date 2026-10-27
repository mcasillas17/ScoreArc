package cdnurl

import (
	"net/url"
	"testing"
)

func TestProviderMedia(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://a.espncdn.com/i/headshots/soccer/players/full/1.png": true,
		"https://espncdn.com/logo.png":                                true,
		"https://A.ESPNCDN.COM:443/logo.png":                          true,
		"http://a.espncdn.com/1.png":                                  false,
		"https://evil.example/1.png":                                  false,
		"https://espncdn.com.evil.test/1.png":                         false,
		"https://notespncdn.com/1.png":                                false,
		"https://user@a.espncdn.com/1.png":                            false,
		"https://a.espncdn.com:8443/1.png":                            false,
		"https://127.0.0.1/1.png":                                     false,
		"javascript:alert(1)":                                         false,
		"/relative.png":                                               false,
	} {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := ProviderMedia(parsed); got != want {
			t.Errorf("ProviderMedia(%q) = %v, want %v", raw, got, want)
		}
	}
}
