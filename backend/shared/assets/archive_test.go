package assets

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type recordingPutter struct {
	bucket, key     string
	body            []byte
	contentEncoding string
	calls           int
	putErr          error
}

func (r *recordingPutter) HeadObject(
	context.Context,
	*s3.HeadObjectInput,
	...func(*s3.Options),
) (*s3.HeadObjectOutput, error) {
	return nil, errors.New("archive must not HEAD; it always overwrites")
}

func (r *recordingPutter) PutObject(
	_ context.Context,
	in *s3.PutObjectInput,
	_ ...func(*s3.Options),
) (*s3.PutObjectOutput, error) {
	r.calls++
	r.bucket, r.key = *in.Bucket, *in.Key
	if in.ContentEncoding != nil {
		r.contentEncoding = *in.ContentEncoding
	}
	body, err := io.ReadAll(in.Body)
	if err != nil {
		return nil, err
	}
	r.body = body
	if r.putErr != nil {
		return nil, r.putErr
	}
	return &s3.PutObjectOutput{}, nil
}

// The requirement this whole refactor exists for: a PRIVATE bucket has no
// public base URL, and constructing its client must not demand one. Before the
// split, the only way to build an R2 client at all was assets.New, which
// rejects an empty or non-HTTPS R2_PUBLIC_BASE_URL.
func TestArchiveNeedsNoPublicBaseURL(t *testing.T) {
	archive, err := NewArchive(Credentials{
		AccountID: "acct", AccessKeyID: "key", SecretAccessKey: "secret",
	}, "some-private-bucket")
	if err != nil {
		t.Fatalf("NewArchive: %v", err)
	}
	if archive == nil {
		t.Fatal("NewArchive returned nil")
	}
}

func TestArchiveFromEnvNeedsNoPublicBaseURL(t *testing.T) {
	t.Setenv("R2_ACCOUNT_ID", "account")
	t.Setenv("R2_ACCESS_KEY_ID", "access")
	t.Setenv("R2_SECRET_ACCESS_KEY", "secret")
	t.Setenv("R2_RAW_BUCKET", "private")
	t.Setenv("R2_PUBLIC_BASE_URL", "")

	archive, ok, err := ArchiveFromEnv()
	if err != nil || !ok || archive == nil {
		t.Fatalf("archive=%v ok=%v err=%v", archive, ok, err)
	}
}

func TestArchiveFromEnvReportsIncompleteConfiguration(t *testing.T) {
	t.Setenv("R2_ACCOUNT_ID", "")
	t.Setenv("R2_ACCESS_KEY_ID", "")
	t.Setenv("R2_SECRET_ACCESS_KEY", "")
	t.Setenv("R2_RAW_BUCKET", "")

	archive, ok, err := ArchiveFromEnv()
	if err != nil || ok || archive != nil {
		t.Fatalf("archive=%v ok=%v err=%v, want unconfigured", archive, ok, err)
	}
}

func TestNewArchiveRequiresConfiguration(t *testing.T) {
	complete := Credentials{
		AccountID: "acct", AccessKeyID: "key", SecretAccessKey: "secret",
	}
	for _, test := range []struct {
		name   string
		creds  Credentials
		bucket string
	}{
		{name: "bucket", creds: complete},
		{
			name:   "credentials",
			creds:  Credentials{AccountID: "acct", AccessKeyID: "key"},
			bucket: "private",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := NewArchive(test.creds, test.bucket); err == nil {
				t.Fatal("want incomplete archive configuration to fail")
			}
		})
	}
}

func TestArchivePutsGzippedBytesUnderTheGivenKey(t *testing.T) {
	putter := &recordingPutter{}
	archive := &Archive{client: putter, bucket: "raw-bucket"}

	payload := []byte(`{"count":1542}` + "\n" + `{"count":1542}`)
	size, err := archive.Put(context.Background(), "plays/espn/mex/2026/1.ndjson.gz", payload)
	if err != nil {
		t.Fatal(err)
	}
	if putter.bucket != "raw-bucket" {
		t.Fatalf("bucket = %q, want the raw bucket", putter.bucket)
	}
	if putter.key != "plays/espn/mex/2026/1.ndjson.gz" {
		t.Fatalf("key = %q", putter.key)
	}
	if putter.contentEncoding != "gzip" {
		t.Fatalf("contentEncoding = %q, want gzip", putter.contentEncoding)
	}
	if size != len(putter.body) {
		t.Fatalf("reported size %d, actually wrote %d", size, len(putter.body))
	}
	// Round-trip: an archive we cannot read back is not an archive.
	reader, err := gzip.NewReader(bytes.NewReader(putter.body))
	if err != nil {
		t.Fatalf("stored bytes are not gzip: %v", err)
	}
	defer reader.Close()
	restored, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(payload) {
		t.Fatal("round-trip changed the payload")
	}
}

func TestArchivePutRejectsAnEmptyKey(t *testing.T) {
	archive := &Archive{client: &recordingPutter{}, bucket: "raw-bucket"}
	if _, err := archive.Put(context.Background(), "", []byte(`{}`)); err == nil {
		t.Fatal("want an empty object key to fail")
	}
}

func TestArchivePutPropagatesUploadFailure(t *testing.T) {
	putter := &recordingPutter{putErr: errors.New("write failed")}
	archive := &Archive{client: putter, bucket: "raw-bucket"}
	if _, err := archive.Put(
		context.Background(),
		"plays/espn/mex/2026/1.ndjson.gz",
		[]byte(`{}`),
	); err == nil || !strings.Contains(err.Error(), "put archive") {
		t.Fatalf("err = %v, want upload context", err)
	}
}

// The key must be derivable from ESPN's own ids alone, so an object is
// identifiable without the database that indexed it.
func TestPlayArchiveKeyLayout(t *testing.T) {
	got := PlayArchiveKey("espn", "premier-league", "2026-27", "401877018")
	want := "plays/espn/premier-league/2026-27/401877018.ndjson.gz"
	if got != want {
		t.Fatalf("PlayArchiveKey = %q, want %q", got, want)
	}
	// A competition or season id with a slash in it would silently create a
	// nested prefix and break the one-prefix-per-season listing.
	if strings.Contains(PlayArchiveKey("espn", "a/b", "c", "1"), "a/b") {
		t.Fatal("path separators in an id must be escaped, not interpolated")
	}
}
