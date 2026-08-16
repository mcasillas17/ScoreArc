package assets

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const archiveOperationTimeout = 60 * time.Second

// Archive writes raw payloads to the PRIVATE R2 bucket.
//
// It is a separate type from Mirror, not a method on it, because the two have
// opposite requirements. Mirror exists to put an image where a browser can
// fetch it: it needs a public base URL, it validates content types, it refuses
// hosts outside espncdn.com, and it HEADs first so an asset already mirrored is
// not downloaded twice. Archive exists to keep bytes nobody can fetch again: it
// has no public URL by design, it reshapes nothing, and it always overwrites,
// because a re-archive of a live match is a LONGER stream and skipping it would
// freeze the object at first-half length.
//
// The bucket name arrives from the environment and is never a literal in this
// package. R2_RAW_BUCKET names the ROLE; the secret names the RESOURCE. A
// bucket rename is then `fly secrets set`, not a code change and a redeploy.
type Archive struct {
	client objectClient
	bucket string
}

// ArchiveFromEnv builds the raw-archive client, or reports that it is not
// configured.
//
// Deliberately does NOT read R2_PUBLIC_BASE_URL. The raw bucket has no public
// access, no r2.dev URL and no custom domain; requiring one would be requiring
// a value that does not and should not exist.
func ArchiveFromEnv() (*Archive, bool, error) {
	creds := credentialsFromEnv()
	bucket := os.Getenv("R2_RAW_BUCKET")
	if !creds.complete() || bucket == "" {
		return nil, false, nil
	}
	archive, err := NewArchive(creds, bucket)
	return archive, true, err
}

func NewArchive(creds Credentials, bucket string) (*Archive, error) {
	if bucket == "" {
		return nil, fmt.Errorf("R2 archive requires a bucket name")
	}
	if !creds.complete() {
		return nil, fmt.Errorf("R2 archive requires account id, access key and secret")
	}
	return &Archive{client: newS3Client(creds), bucket: bucket}, nil
}

// Put stores a gzipped payload and returns the COMPRESSED size, which is what
// gets billed and what match_play_archive.bytes records.
//
// Nothing here inspects or reshapes the body. The entire value of the archive
// is that a better parser can be run over it later, and a parser can only
// improve on bytes that were stored exactly as they arrived.
func (a *Archive) Put(ctx context.Context, key string, body []byte) (int, error) {
	if a == nil || a.client == nil || a.bucket == "" {
		return 0, fmt.Errorf("put archive: client is not configured")
	}
	if key == "" {
		return 0, fmt.Errorf("put archive: object key is required")
	}

	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(body); err != nil {
		return 0, fmt.Errorf("gzip archive %s: %w", key, err)
	}
	if err := writer.Close(); err != nil {
		return 0, fmt.Errorf("gzip archive %s: %w", key, err)
	}
	compressed := buffer.Bytes()

	// A longer timeout than the asset mirror's 15s: a full match is ~2 MB raw
	// and the write happens once, not on a request path.
	putCtx, cancel := context.WithTimeout(ctx, archiveOperationTimeout)
	defer cancel()
	if _, err := a.client.PutObject(putCtx, &s3.PutObjectInput{
		Bucket:          aws.String(a.bucket),
		Key:             aws.String(key),
		Body:            bytes.NewReader(compressed),
		ContentType:     aws.String("application/x-ndjson"),
		ContentEncoding: aws.String("gzip"),
	}); err != nil {
		return 0, fmt.Errorf("put archive %s: %w", key, err)
	}
	return len(compressed), nil
}

// PlayArchiveKey is the object layout:
//
//	plays/{source}/{competition}/{season}/{providerEventID}.ndjson.gz
//
// Source first prevents providers from colliding. Competition and season make
// a whole season one listable, re-processable prefix. The provider event id,
// rather than the canonical match UUID, keeps an object identifiable without
// the database that indexed it. One object per match keeps pagination as an
// internal transport detail; its raw pages are joined as NDJSON.
func PlayArchiveKey(source, competitionID, seasonID, providerEventID string) string {
	return fmt.Sprintf("plays/%s/%s/%s/%s.ndjson.gz",
		url.PathEscape(source), url.PathEscape(competitionID),
		url.PathEscape(seasonID), url.PathEscape(providerEventID))
}
