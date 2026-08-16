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

var ErrAssetRejected = errors.New("asset rejected")

// Credentials are the parts shared by every R2 bucket: one account, one API
// token with Object Read & Write scoped to both buckets, one S3 endpoint. Only
// the bucket name differs between them.
type Credentials struct {
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
}

// Config is a PUBLIC bucket: one that is served from a CDN origin. The public
// base URL is required here and only here.
type Config struct {
	Credentials
	Bucket        string
	PublicBaseURL string
}

func (c Credentials) complete() bool {
	return c.AccountID != "" && c.AccessKeyID != "" && c.SecretAccessKey != ""
}

// newS3Client builds the R2 client. It knows nothing about public URLs, which
// is the point: the raw archive bucket is private -- no public access, no
// r2.dev URL, no custom domain -- and before this split the only way to
// construct a client was assets.New, whose validator rejects an empty
// PublicBaseURL. Passing a dummy URL to get past that would leave a
// plausible-looking CDN origin in the config for someone to later serve from.
func newS3Client(creds Credentials) *s3.Client {
	return s3.New(s3.Options{
		Region:       "auto",
		BaseEndpoint: aws.String(fmt.Sprintf("https://%s.r2.cloudflarestorage.com", creds.AccountID)),
		Credentials: credentials.NewStaticCredentialsProvider(
			creds.AccessKeyID, creds.SecretAccessKey, ""),
		UsePathStyle: true,
	})
}

func credentialsFromEnv() Credentials {
	return Credentials{
		AccountID:       os.Getenv("R2_ACCOUNT_ID"),
		AccessKeyID:     os.Getenv("R2_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
	}
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
		Credentials:   credentialsFromEnv(),
		Bucket:        os.Getenv("R2_BUCKET"),
		PublicBaseURL: os.Getenv("R2_PUBLIC_BASE_URL"),
	}
	if !config.Credentials.complete() || config.Bucket == "" ||
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
	client := newS3Client(config.Credentials)
	httpClient := &http.Client{Timeout: 20 * time.Second}
	httpClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("%w: redirect limit exceeded", ErrAssetRejected)
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
		return "", fmt.Errorf("%w: parse asset URL: %v", ErrAssetRejected, err)
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
		if response.StatusCode >= 400 && response.StatusCode < 500 &&
			response.StatusCode != http.StatusRequestTimeout &&
			response.StatusCode != http.StatusTooEarly &&
			response.StatusCode != http.StatusTooManyRequests {
			return "", fmt.Errorf(
				"%w: download asset: status %d",
				ErrAssetRejected,
				response.StatusCode,
			)
		}
		return "", fmt.Errorf("download asset: status %d", response.StatusCode)
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
	default:
		return "", fmt.Errorf(
			"%w: download asset: unsupported content type %q",
			ErrAssetRejected,
			contentType,
		)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAsset+1))
	if err != nil {
		return "", fmt.Errorf("read asset: %w", err)
	}
	if len(body) > maxAsset {
		return "", fmt.Errorf("%w: download asset exceeds %d bytes", ErrAssetRejected, maxAsset)
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
		return fmt.Errorf("%w: asset URL must use HTTPS", ErrAssetRejected)
	}
	host := strings.ToLower(candidate.Hostname())
	if candidate.User != nil || (candidate.Port() != "" && candidate.Port() != "443") {
		return fmt.Errorf(
			"%w: asset URL credentials and non-HTTPS ports are not allowed",
			ErrAssetRejected,
		)
	}
	if ip := net.ParseIP(host); ip != nil {
		return fmt.Errorf("%w: asset URL IP hosts are not allowed", ErrAssetRejected)
	}
	if host != "espncdn.com" && !strings.HasSuffix(host, ".espncdn.com") {
		return fmt.Errorf("%w: asset URL host %q is not allowed", ErrAssetRejected, host)
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
