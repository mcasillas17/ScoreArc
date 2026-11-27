package assets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

const (
	testPNG  = "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
	testJPEG = "\xff\xd8\xff\xe0\x00\x10JFIF"
	testGIF  = "GIF89a\x01\x00\x01\x00"
	testWebP = "RIFF\x18\x00\x00\x00WEBPVP8 "
)

type fakeObjects struct {
	headErr         error
	putErr          error
	puts            int
	headBounded     bool
	putBounded      bool
	lastContentType string
}

func (f *fakeObjects) HeadObject(
	ctx context.Context,
	_ *s3.HeadObjectInput,
	_ ...func(*s3.Options),
) (*s3.HeadObjectOutput, error) {
	_, f.headBounded = ctx.Deadline()
	return &s3.HeadObjectOutput{}, f.headErr
}

func (f *fakeObjects) PutObject(
	ctx context.Context,
	input *s3.PutObjectInput,
	_ ...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	f.puts++
	_, f.putBounded = ctx.Deadline()
	if input != nil && input.ContentType != nil {
		f.lastContentType = *input.ContentType
	}
	return &s3.PutObjectOutput{}, f.putErr
}

type fakeHTTP struct {
	calls       int
	err         error
	status      int
	contentType string
	body        string
}

func (f *fakeHTTP) Do(*http.Request) (*http.Response, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &http.Response{
		StatusCode: f.status,
		Header: http.Header{
			"Content-Type": []string{f.contentType},
		},
		Body: io.NopCloser(strings.NewReader(f.body)),
	}, nil
}

func TestMirrorPropagatesDownloadAndUploadFailures(t *testing.T) {
	for _, test := range []struct {
		name       string
		httpClient *fakeHTTP
		objects    *fakeObjects
	}{
		{
			name:       "download transport",
			httpClient: &fakeHTTP{err: errors.New("connection reset")},
			objects:    &fakeObjects{headErr: &smithy.GenericAPIError{Code: "NotFound"}},
		},
		{
			name:       "download status",
			httpClient: &fakeHTTP{status: http.StatusBadGateway},
			objects:    &fakeObjects{headErr: &smithy.GenericAPIError{Code: "NotFound"}},
		},
		{
			name:       "upload",
			httpClient: &fakeHTTP{status: http.StatusOK, contentType: "image/png", body: testPNG},
			objects: &fakeObjects{
				headErr: &smithy.GenericAPIError{Code: "NotFound"},
				putErr:  errors.New("write failed"),
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			mirror := testMirror(test.objects, test.httpClient)
			if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo"); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func testMirror(objects *fakeObjects, httpClient *fakeHTTP) *Mirror {
	return &Mirror{
		client:  objects,
		bucket:  "crests",
		baseURL: "https://assets.example",
		http:    httpClient,
	}
}

func TestMirrorCacheHitSkipsDownload(t *testing.T) {
	objects := &fakeObjects{}
	httpClient := &fakeHTTP{}
	mirror := testMirror(objects, httpClient)

	got, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo.png")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://assets.example/teams/123" || httpClient.calls != 0 || objects.puts != 0 {
		t.Fatalf("url=%q gets=%d puts=%d", got, httpClient.calls, objects.puts)
	}
}

func TestMirrorConfirmedMissDownloadsAndPuts(t *testing.T) {
	objects := &fakeObjects{
		headErr: &smithy.GenericAPIError{Code: "NotFound", Message: "missing"},
	}
	httpClient := &fakeHTTP{
		status: http.StatusOK, contentType: "image/png", body: testPNG,
	}
	mirror := testMirror(objects, httpClient)

	if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo.png"); err != nil {
		t.Fatal(err)
	}
	if httpClient.calls != 1 || objects.puts != 1 {
		t.Fatalf("gets=%d puts=%d", httpClient.calls, objects.puts)
	}
	if !objects.headBounded || !objects.putBounded {
		t.Fatalf("head bounded=%v put bounded=%v", objects.headBounded, objects.putBounded)
	}
	if objects.lastContentType != "image/png" {
		t.Fatalf("content type=%q", objects.lastContentType)
	}
}

func TestMirrorHeadAccessFailureDoesNotDownload(t *testing.T) {
	objects := &fakeObjects{headErr: errors.New("access denied")}
	httpClient := &fakeHTTP{}
	mirror := testMirror(objects, httpClient)

	if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo.png"); err == nil {
		t.Fatal("expected error")
	}
	if httpClient.calls != 0 || objects.puts != 0 {
		t.Fatalf("gets=%d puts=%d", httpClient.calls, objects.puts)
	}
}

func TestMirrorTreatsWrappedHTTP404AsMiss(t *testing.T) {
	objects := &fakeObjects{headErr: &smithyhttp.ResponseError{
		Response: &smithyhttp.Response{Response: &http.Response{StatusCode: http.StatusNotFound}},
		Err:      errors.New("missing"),
	}}
	httpClient := &fakeHTTP{status: http.StatusOK, contentType: "image/png", body: testPNG}
	mirror := testMirror(objects, httpClient)

	if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo.png"); err != nil {
		t.Fatal(err)
	}
	if objects.puts != 1 {
		t.Fatalf("puts=%d", objects.puts)
	}
}

func TestMirrorRejectsInvalidOrOversizedContent(t *testing.T) {
	for _, test := range []struct {
		name        string
		contentType string
		body        string
	}{
		{name: "not image", contentType: "text/html", body: "nope"},
		{name: "oversized", contentType: "image/png", body: testPNG + strings.Repeat("x", maxAsset)},
		{name: "empty body", contentType: "image/png", body: ""},
		{name: "plain text masquerading as png", contentType: "image/png", body: "png"},
		{name: "html masquerading as png", contentType: "image/png", body: "<html><script>alert(1)</script></html>"},
		{name: "svg masquerading as png", contentType: "image/png", body: `<svg xmlns="http://www.w3.org/2000/svg"></svg>`},
	} {
		t.Run(test.name, func(t *testing.T) {
			objects := &fakeObjects{
				headErr: &smithy.GenericAPIError{Code: "NoSuchKey", Message: "missing"},
			}
			httpClient := &fakeHTTP{
				status: http.StatusOK, contentType: test.contentType, body: test.body,
			}
			mirror := testMirror(objects, httpClient)
			if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo"); !errors.Is(err, ErrAssetRejected) {
				t.Fatalf("error=%v", err)
			}

			if objects.puts != 0 {
				t.Fatalf("puts=%d", objects.puts)
			}
		})
	}
}

func TestMirrorUsesSniffedImageContentType(t *testing.T) {
	for _, tc := range []struct {
		name         string
		headerType   string
		body         string
		wantPutType  string
	}{
		{name: "png", headerType: "image/png", body: testPNG, wantPutType: "image/png"},
		{name: "jpeg", headerType: "image/jpeg", body: testJPEG, wantPutType: "image/jpeg"},
		{name: "gif", headerType: "image/gif", body: testGIF, wantPutType: "image/gif"},
		{name: "webp overrides png header", headerType: "image/png", body: testWebP, wantPutType: "image/webp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			objects := &fakeObjects{headErr: &smithy.GenericAPIError{Code: "NotFound"}}
			mirror := testMirror(objects, &fakeHTTP{status: http.StatusOK, contentType: tc.headerType, body: tc.body})
			if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://a.espncdn.com/logo"); err != nil {
				t.Fatal(err)
			}
			if objects.lastContentType != tc.wantPutType {
				t.Fatalf("lastContentType = %q, want %q", objects.lastContentType, tc.wantPutType)
			}
		})
	}
}

func TestMirrorRejectsUntrustedAssetURLs(t *testing.T) {
	for _, sourceURL := range []string{
		"http://a.espncdn.com/logo.png",
		"https://example.com/logo.png",
		"https://127.0.0.1/logo.png",
		"https://169.254.169.254/latest/meta-data",
	} {
		t.Run(sourceURL, func(t *testing.T) {
			objects := &fakeObjects{
				headErr: &smithy.GenericAPIError{Code: "NotFound", Message: "missing"},
			}

			mirror := testMirror(objects, &fakeHTTP{})
			if _, err := mirror.Mirror(context.Background(), "teams", "123", sourceURL); !errors.Is(err, ErrAssetRejected) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func TestMirrorRedirectPolicyRevalidatesDestination(t *testing.T) {
	mirror, err := New(Config{PublicBaseURL: "https://cdn.example"})
	if err != nil {
		t.Fatal(err)
	}

	client, ok := mirror.http.(*http.Client)
	if !ok {
		t.Fatal("expected HTTP client")
	}

	request, err := http.NewRequest(http.MethodGet, "https://127.0.0.1/logo.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	via, err := http.NewRequest(http.MethodGet, "https://a.espncdn.com/logo.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(request, []*http.Request{via}); err == nil {
		t.Fatal("expected redirect destination rejection")
	}
}

func TestNewRejectsUnsafePublicBaseURL(t *testing.T) {
	for _, baseURL := range []string{
		"http://cdn.example",
		"https://user@cdn.example",
		"https://cdn.example?query=1",
		"https://cdn.example:8443",
	} {
		if _, err := New(Config{PublicBaseURL: baseURL}); err == nil {
			t.Fatalf("expected invalid base URL error for %q", baseURL)
		}
	}
}

func TestFromEnvRequiresCompletePublicConfiguration(t *testing.T) {
	keys := []string{
		"R2_ACCOUNT_ID",
		"R2_ACCESS_KEY_ID",
		"R2_SECRET_ACCESS_KEY",
		"R2_BUCKET",
		"R2_PUBLIC_BASE_URL",
	}
	for _, missing := range keys {
		t.Run(missing, func(t *testing.T) {
			for _, key := range keys {
				t.Setenv(key, "configured")
			}
			t.Setenv("R2_PUBLIC_BASE_URL", "https://cdn.example")
			t.Setenv(missing, "")
			mirror, ok, err := FromEnv()
			if err != nil || ok || mirror != nil {
				t.Fatalf("mirror=%v ok=%v err=%v, want unconfigured", mirror, ok, err)
			}
		})
	}
}

func TestFromEnvBuildsConfiguredPublicMirror(t *testing.T) {
	t.Setenv("R2_ACCOUNT_ID", "account")
	t.Setenv("R2_ACCESS_KEY_ID", "access")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("R2_BUCKET", "assets")
	t.Setenv("R2_PUBLIC_BASE_URL", "https://cdn.example")

	mirror, ok, err := FromEnv()
	if err != nil || !ok || mirror == nil {
		t.Fatalf("mirror=%v ok=%v err=%v", mirror, ok, err)
	}
	if mirror.bucket != "assets" || mirror.BaseURL() != "https://cdn.example" {
		t.Fatalf("mirror bucket/base = %q/%q", mirror.bucket, mirror.BaseURL())
	}
}

func TestCrestHTTPHealthIsIndependentOfStorageAndValidation(t *testing.T) {
	var buf bytes.Buffer
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.Header().Set("Content-Type", "image/png")
			_, _ = io.WriteString(w, testPNG)
		default:
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, "private-body")
		}
	}))
	defer server.Close()
	mirror := &Mirror{http: server.Client(), HTTPLog: slog.New(slog.NewJSONHandler(&buf, nil))}
	for _, tc := range []struct{ path, outcome string }{{"/ok", "success"}, {"/private-id", "body"}} {
		buf.Reset()
		u, err := url.Parse(server.URL + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		data, _, err := mirror.download(context.Background(), u)
		if tc.outcome == "success" && (err != nil || string(data) != testPNG) {
			t.Fatalf("data=%q err=%v", data, err)
		}
		if tc.outcome == "body" && !errors.Is(err, ErrAssetRejected) {
			t.Fatalf("want original error, got %v", err)
		}
		var record map[string]any
		if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record["dependency"] != "espn" || record["endpoint"] != "crest" || record["status"] != float64(200) || record["outcome"] != tc.outcome || strings.Contains(buf.String(), "private") {
			t.Fatalf("event %s", buf.String())
		}
	}
}
