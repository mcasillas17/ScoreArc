package espn

import (
	"os"
	"testing"
)

func TestNewsURL(t *testing.T) {
	t.Parallel()
	got := NewsURL("fifa.world")
	want := "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news"
	if got != want {
		t.Fatalf("NewsURL() = %q, want %q", got, want)
	}
}

func TestMapNews(t *testing.T) {
	t.Parallel()
	raw := []byte(`{
      "articles": [
        {
          "id": 49233296,
          "headline": "World Cup headline",
          "description": "Description",
          "published": "2026-08-10T12:00:00Z",
          "byline": "ESPN",
          "images": [{"url": "https://example.com/image.jpg"}],
          "links": {"web": {"href": "https://example.com/article"}}
        },
        {
          "headline": "Fallback identifier",
          "images": [],
          "links": {"web": {"href": "https://example.com/fallback"}}
        },
        {"headline": "No URL"},
        {"links": {"web": {"href": "https://example.com/no-headline"}}}
      ]
    }`)

	articles, err := MapNews(raw)
	if err != nil {
		t.Fatalf("MapNews() error = %v", err)
	}
	if len(articles) != 2 {
		t.Fatalf("len(MapNews()) = %d, want 2", len(articles))
	}
	first := articles[0]
	if first.ID != "49233296" || first.Headline != "World Cup headline" || first.URL != "https://example.com/article" || first.Image == nil || *first.Image != "https://example.com/image.jpg" {
		t.Fatalf("first article = %+v", first)
	}
	second := articles[1]
	if second.ID != "Fallback identifier" || second.Image != nil {
		t.Fatalf("fallback article = %+v", second)
	}
}

func TestMapNewsRejectsMalformedJSON(t *testing.T) {
	t.Parallel()
	if _, err := MapNews([]byte(`{"articles":`)); err == nil {
		t.Fatal("MapNews() error = nil, want malformed JSON error")
	}
}

func TestMapNewsMissingArticlesIsEmptyNotNil(t *testing.T) {
	t.Parallel()
	articles, err := MapNews([]byte(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if articles == nil || len(articles) != 0 {
		t.Fatalf("MapNews() = %#v, want non-nil empty slice", articles)
	}
}

func TestMapNewsNullIDFallsBackToHeadline(t *testing.T) {
	t.Parallel()
	articles, err := MapNews([]byte(`{"articles":[{"id":null,"headline":"Fallback","links":{"web":{"href":"https://example.com/fallback"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(articles) != 1 || articles[0].ID != "Fallback" {
		t.Fatalf("articles = %+v", articles)
	}
}

func TestMapNewsExplicitEmptyIDMatchesNullishFrontendSemantics(t *testing.T) {
	t.Parallel()
	articles, err := MapNews([]byte(`{"articles":[{"id":"","headline":"Headline","links":{"web":{"href":"https://example.com/empty"}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(articles) != 1 || articles[0].ID != "" {
		t.Fatalf("articles = %+v", articles)
	}
}

func TestMapNewsRecordedFixture(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("testdata/espn-news.json")
	if err != nil {
		t.Fatal(err)
	}
	articles, err := MapNews(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(articles) != 6 || articles[0].ID != "49233296" || articles[0].Byline != "ESPN" || articles[0].Image == nil {
		t.Fatalf("fixture articles = %+v", articles)
	}
}
