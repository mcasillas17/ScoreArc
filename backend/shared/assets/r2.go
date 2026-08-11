// Package assets mirrors external images into Cloudflare R2.
package assets

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

const maxAsset = 8 << 20

type Config struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
	Bucket          string
	PublicBaseURL   string
}

type objectClient interface {
	HeadObject(context.Context, *s3.HeadObjectInput, ...func(*s3.Options)) (*s3.HeadObjectOutput, error)
	PutObject(context.Context, *s3.PutObjectInput, ...func(*s3.Options)) (*s3.PutObjectOutput, error)
}

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type Mirror struct {
	client  objectClient
	bucket  string
	baseURL string
	http    httpDoer
}

func FromEnv() (*Mirror, bool) {
	config := Config{
		AccountID:       os.Getenv("R2_ACCOUNT_ID"),
		AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
		Bucket:          os.Getenv("R2_BUCKET"),
		PublicBaseURL:   os.Getenv("R2_PUBLIC_BASE_URL"),
	}
	if config.AccountID == "" || config.AccessKeyID == "" ||
		config.SecretAccessKey == "" || config.Bucket == "" ||
		config.PublicBaseURL == "" {
		return nil, false
	}
	return New(config), true
}

func New(config Config) *Mirror {
	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", config.AccountID)
	client := s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(endpoint),
		Credentials: credentials.NewStaticCredentialsProvider(
			config.AccessKeyID,
			config.SecretAccessKey,
			"",
		),
		UsePathStyle: true,
	})
	return &Mirror{
		client:  client,
		bucket:  config.Bucket,
		baseURL: strings.TrimRight(config.PublicBaseURL, "/"),
		http:    &http.Client{Timeout: 20 * time.Second},
	}
}

func (m *Mirror) BaseURL() string {
	return m.baseURL
}

func (m *Mirror) Mirror(ctx context.Context, kind, id, sourceURL string) (string, error) {
	key := url.PathEscape(kind) + "/" + url.PathEscape(id)
	cdnURL := m.baseURL + "/" + key

	_, err := m.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(m.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return cdnURL, nil
	}
	if !isNotFound(err) {
		return "", fmt.Errorf("head R2 object: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
	if err != nil {
		return "", err
	}
	response, err := m.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("download asset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("download asset: status %d", response.StatusCode)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	if !strings.HasPrefix(contentType, "image/") {
		return "", fmt.Errorf("download asset: unsupported content type %q", contentType)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAsset+1))
	if err != nil {
		return "", fmt.Errorf("read asset: %w", err)
	}
	if len(body) > maxAsset {
		return "", fmt.Errorf("download asset exceeds %d bytes", maxAsset)
	}

	_, err = m.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:       aws.String(m.bucket),
		Key:          aws.String(key),
		Body:         bytes.NewReader(body),
		ContentType:  aws.String(contentType),
		CacheControl: aws.String("public, max-age=31536000, immutable"),
	})
	if err != nil {
		return "", fmt.Errorf("put R2 object: %w", err)
	}
	return cdnURL, nil
}

func isNotFound(err error) bool {
	var apiError smithy.APIError
	if !errors.As(err, &apiError) {
		return false
	}
	switch apiError.ErrorCode() {
	case "NotFound", "NoSuchKey", "404":
		return true
	default:
		return false
	}
}
