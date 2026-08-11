package assets

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type fakeObjects struct {
	headErr     error
	putErr      error
	puts        int
	headBounded bool
	putBounded  bool
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
	_ *s3.PutObjectInput,
	_ ...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	f.puts++
	_, f.putBounded = ctx.Deadline()
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
			httpClient: &fakeHTTP{status: http.StatusOK, contentType: "image/png", body: "png"},
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
		status: http.StatusOK, contentType: "image/png", body: "png",
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
	httpClient := &fakeHTTP{status: http.StatusOK, contentType: "image/png", body: "png"}
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
		{name: "oversized", contentType: "image/png", body: strings.Repeat("x", maxAsset+1)},
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
