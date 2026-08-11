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
)

type fakeObjects struct {
	headErr error
	puts    int
}

func (f *fakeObjects) HeadObject(
	context.Context,
	*s3.HeadObjectInput,
	...func(*s3.Options),
) (*s3.HeadObjectOutput, error) {
	return &s3.HeadObjectOutput{}, f.headErr
}

func (f *fakeObjects) PutObject(
	context.Context,
	*s3.PutObjectInput,
	...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	f.puts++
	return &s3.PutObjectOutput{}, nil
}

type fakeHTTP struct {
	calls       int
	status      int
	contentType string
	body        string
}

func (f *fakeHTTP) Do(*http.Request) (*http.Response, error) {
	f.calls++
	return &http.Response{
		StatusCode: f.status,
		Header: http.Header{
			"Content-Type": []string{f.contentType},
		},
		Body: io.NopCloser(strings.NewReader(f.body)),
	}, nil
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

	got, err := mirror.Mirror(context.Background(), "teams", "123", "https://source/logo.png")
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

	if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://source/logo.png"); err != nil {
		t.Fatal(err)
	}
	if httpClient.calls != 1 || objects.puts != 1 {
		t.Fatalf("gets=%d puts=%d", httpClient.calls, objects.puts)
	}
}

func TestMirrorHeadAccessFailureDoesNotDownload(t *testing.T) {
	objects := &fakeObjects{headErr: errors.New("access denied")}
	httpClient := &fakeHTTP{}
	mirror := testMirror(objects, httpClient)

	if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://source/logo.png"); err == nil {
		t.Fatal("expected error")
	}
	if httpClient.calls != 0 || objects.puts != 0 {
		t.Fatalf("gets=%d puts=%d", httpClient.calls, objects.puts)
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
			if _, err := mirror.Mirror(context.Background(), "teams", "123", "https://source/logo"); err == nil {
				t.Fatal("expected error")
			}
			if objects.puts != 0 {
				t.Fatalf("puts=%d", objects.puts)
			}
		})
	}
}
