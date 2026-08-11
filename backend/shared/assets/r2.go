// Package assets mirrors external images into Cloudflare R2.
package assets

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

const (
	maxAsset              = 8 << 20
	assetOperationTimeout = 15 * time.Second
)

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

func FromEnv() (*Mirror, bool, error) {
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
		return nil, false, nil
	}
	mirror, err := New(config)
	return mirror, true, err
}

func New(config Config) (*Mirror, error) {
	publicBase, err := url.Parse(config.PublicBaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse R2 public base URL: %w", err)
	}
	if publicBase.Scheme != "https" || publicBase.Host == "" ||
		publicBase.User != nil || publicBase.RawQuery != "" || publicBase.Fragment != "" ||
		(publicBase.Port() != "" && publicBase.Port() != "443") {
		return nil, fmt.Errorf("R2 public base URL must be a plain HTTPS origin/path")
	}
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
	httpClient := &http.Client{Timeout: 20 * time.Second}
	httpClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("asset redirect limit exceeded")
		}
		return validateAssetURL(request.URL)
	}
	return &Mirror{
		client:  client,
		bucket:  config.Bucket,
		baseURL: strings.TrimRight(config.PublicBaseURL, "/"),
		http:    httpClient,
	}, nil
}

func (m *Mirror) BaseURL() string {
	return m.baseURL
}

func (m *Mirror) Mirror(ctx context.Context, kind, id, sourceURL string) (string, error) {
	key := url.PathEscape(kind) + "/" + url.PathEscape(id)
	cdnURL := m.baseURL + "/" + key

	headCtx, cancelHead := context.WithTimeout(ctx, assetOperationTimeout)
	_, err := m.client.HeadObject(headCtx, &s3.HeadObjectInput{
		Bucket: aws.String(m.bucket),
		Key:    aws.String(key),
	})
	cancelHead()
	if err == nil {
		return cdnURL, nil
	}
	if !isNotFound(err) {
		return "", fmt.Errorf("head R2 object: %w", err)
	}

	parsedSource, err := url.Parse(sourceURL)
	if err != nil {
		return "", fmt.Errorf("parse asset URL: %w", err)
	}
	if err := validateAssetURL(parsedSource); err != nil {
		return "", err
	}
	downloadCtx, cancelDownload := context.WithTimeout(ctx, assetOperationTimeout)
	defer cancelDownload()
	request, err := http.NewRequestWithContext(downloadCtx, http.MethodGet, parsedSource.String(), nil)
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
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return "", fmt.Errorf("download asset: unsupported content type %q", contentType)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAsset+1))
	if err != nil {
		return "", fmt.Errorf("read asset: %w", err)
	}
	if len(body) > maxAsset {
		return "", fmt.Errorf("download asset exceeds %d bytes", maxAsset)
	}

	putCtx, cancelPut := context.WithTimeout(ctx, assetOperationTimeout)
	_, err = m.client.PutObject(putCtx, &s3.PutObjectInput{
		Bucket:       aws.String(m.bucket),
		Key:          aws.String(key),
		Body:         bytes.NewReader(body),
		ContentType:  aws.String(contentType),
		CacheControl: aws.String("public, max-age=31536000, immutable"),
	})
	cancelPut()
	if err != nil {
		return "", fmt.Errorf("put R2 object: %w", err)
	}

	return cdnURL, nil
}

func validateAssetURL(candidate *url.URL) error {
	if candidate.Scheme != "https" {
		return fmt.Errorf("asset URL must use HTTPS")
	}
	host := strings.ToLower(candidate.Hostname())
	if candidate.User != nil || (candidate.Port() != "" && candidate.Port() != "443") {
		return fmt.Errorf("asset URL credentials and non-HTTPS ports are not allowed")
	}
	if ip := net.ParseIP(host); ip != nil {
		return fmt.Errorf("asset URL IP hosts are not allowed")
	}
	if host != "espncdn.com" && !strings.HasSuffix(host, ".espncdn.com") {
		return fmt.Errorf("asset URL host %q is not allowed", host)
	}
	return nil
}

func isNotFound(err error) bool {
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) && responseError.HTTPStatusCode() == http.StatusNotFound {
		return true
	}
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
