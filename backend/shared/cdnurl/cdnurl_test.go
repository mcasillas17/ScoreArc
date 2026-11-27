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

func TestProviderArticleAndContentMedia(t *testing.T) {
	articleCases := map[string]bool{
		"https://www.espn.com/soccer/story/_/id/1":           true,
		"https://espn.com/soccer/story":                      true,
		"https://www.espn.co.uk/football/story/_/id/1":       true,
		"https://www.espn.com.mx/futbol/nota/_/id/1":         true,
		"https://www.espndeportes.com/futbol/nota/_/id/1":    true,
		"https://www.andscape.com/features/story":            true,
		"http://www.espn.com/soccer/story":                   false,
		"https://evil.example/story":                         false,
		"https://espn.com.evil.test/story":                   false,
		"https://notespn.com/story":                          false,
		"https://user@www.espn.com/story":                    false,
		"https://www.espn.com:8443/story":                    false,
		"https://127.0.0.1/story":                            false,
		"javascript:alert(1)":                                false,
		"data:text/html,<script>alert(1)</script>":           false,
		" https://www.espn.com/soccer/story":                 false,
		"/soccer/story":                                      false,
	}
	for raw, want := range articleCases {
		got := ValidArticleURL(raw)
		if (got != "") != want {
			t.Errorf("ValidArticleURL(%q) = %q, want valid=%v", raw, got, want)
		}
	}

	mediaCases := map[string]bool{
		"https://a.espncdn.com/photo/2026/img.jpg":                       true,
		"https://media.video-cdn.espn.com/motion/clip.mp4":               true,
		"https://media.video-origin.espn.com/motion/clip.mp4":            true,
		"https://espnmedia-cdn.akamaized.net/espn/media/clip.mp4":        true,
		"http://a.espncdn.com/photo/img.jpg":                             false,
		"http://media.video-cdn.espn.com/motion/clip.mp4":                false,
		"https://evil.akamaized.net/clip.mp4":                            false,
		"https://espnmedia-cdn.akamaized.net.evil.test/clip.mp4":         false,
		"https://user:pass@media.video-cdn.espn.com/motion/clip.mp4":     false,
		"https://a.espncdn.com:8443/photo/img.jpg":                       false,
		"javascript:alert(1)":                                            false,
	}
	for raw, want := range mediaCases {
		got := ValidContentMediaURL(raw)
		if (got != "") != want {
			t.Errorf("ValidContentMediaURL(%q) = %q, want valid=%v", raw, got, want)
		}
	}
}
