package espn

import (
	"encoding/json"
	"fmt"
	"strings"
)

func NewsURL(slug string) string { return fmt.Sprintf("%s/%s/news", site, slug) }

type NewsArticle struct {
	ID          string  `json:"id"`
	Headline    string  `json:"headline"`
	Description string  `json:"description"`
	Published   string  `json:"published"`
	Image       *string `json:"image"`
	URL         string  `json:"url"`
	Byline      string  `json:"byline"`
}

type rawNewsDocument struct {
	Articles []rawNewsArticle `json:"articles"`
}

type rawNewsArticle struct {
	ID          json.RawMessage `json:"id"`
	Headline    string          `json:"headline"`
	Description string          `json:"description"`
	Published   string          `json:"published"`
	Byline      string          `json:"byline"`
	Categories  []struct {
		Type     string
		LeagueID json.RawMessage
	} `json:"categories"`
	Images []struct {
		URL string `json:"url"`
	} `json:"images"`
	Links struct {
		Web struct {
			Href string `json:"href"`
		} `json:"web"`
	} `json:"links"`
}

// MapNews ports the frontend news mapper and filters unusable articles.
func MapNews(raw []byte) ([]NewsArticle, error) {
	var document rawNewsDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("decode news: %w", err)
	}

	return mapNewsArticles(document.Articles), nil
}

func mapNewsArticles(supplied []rawNewsArticle) []NewsArticle {
	articles := make([]NewsArticle, 0, len(supplied))
	for _, rawArticle := range supplied {
		if rawArticle.Headline == "" || rawArticle.Links.Web.Href == "" {
			continue
		}
		id := newsArticleID(rawArticle.ID, rawArticle.Headline)
		var image *string
		if len(rawArticle.Images) > 0 && rawArticle.Images[0].URL != "" {
			url := rawArticle.Images[0].URL
			image = &url
		}
		articles = append(articles, NewsArticle{
			ID:          id,
			Headline:    rawArticle.Headline,
			Description: rawArticle.Description,
			Published:   rawArticle.Published,
			Image:       image,
			URL:         rawArticle.Links.Web.Href,
			Byline:      rawArticle.Byline,
		})
	}
	return articles
}

// MapNewsObservation requires a complete, usable articles collection before a
// successful proxy fetch can renew freshness, including an explicit empty feed.
func MapNewsObservation(raw []byte) ([]NewsArticle, error) {
	return MapLeagueNewsObservation(raw, "")
}

func MapLeagueNewsObservation(raw []byte, leagueID string) ([]NewsArticle, error) {
	_, err := validateCollection(raw, "articles")
	if err != nil {
		return nil, err
	}
	var doc rawNewsDocument
	err = json.Unmarshal(raw, &doc)
	if err != nil {
		return nil, err
	}
	if leagueID != "" {
		tagged := make([]rawNewsArticle, 0, len(doc.Articles))
		for _, article := range doc.Articles {
			for _, tag := range article.Categories {
				if tag.Type == "league" && jsonScalarToString(tag.LeagueID) == leagueID {
					tagged = append(tagged, article)
					break
				}
			}
		}
		if len(tagged) == 0 {
			return nil, fmt.Errorf("news feed has no verified league attribution")
		}
		doc.Articles = tagged
	}
	articles := mapNewsArticles(doc.Articles)
	if len(articles) != len(doc.Articles) {
		return nil, fmt.Errorf("incomplete news collection")
	}
	return articles, nil
}

func newsArticleID(raw json.RawMessage, headline string) string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return headline
	}
	return jsonScalarToString(raw)
}
