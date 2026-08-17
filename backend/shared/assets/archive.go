package assets

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const archiveOperationTimeout = 60 * time.Second

const (
	archivePlaysMetadataKey     = "plays"
	archiveTouchTierMetadataKey = "touch-tier"
)

// PlayArchiveMetadata is the stream truth stored with an immutable object.
type PlayArchiveMetadata struct {
	Plays     int
	TouchTier bool
}

// ArchivePutResult describes the object that now exists. On a conditional-put
// conflict, Metadata and Bytes describe the existing object, not the retry
// payload that was refused.
type ArchivePutResult struct {
	Bytes    int
	Metadata PlayArchiveMetadata
	Created  bool
}

// Archive writes raw payloads to the PRIVATE R2 bucket.
//
// It is a separate type from Mirror, not a method on it, because the two have
// opposite requirements. Mirror exists to put an image where a browser can
// fetch it: it needs a public base URL, it validates content types, it refuses
// hosts outside espncdn.com, and it HEADs first so an asset already mirrored is
// not downloaded twice. Archive exists to keep bytes nobody can fetch again: it
// has no public URL by design, it reshapes nothing, and it uses an atomic
// create-only put so a retry can never replace a complete stream with a later
// pruned or empty response.
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
func (a *Archive) Put(
	ctx context.Context,
	key string,
	body []byte,
	metadata PlayArchiveMetadata,
) (ArchivePutResult, error) {
	if a == nil || a.client == nil || a.bucket == "" {
		return ArchivePutResult{}, fmt.Errorf("put archive: client is not configured")
	}
	if key == "" {
		return ArchivePutResult{}, fmt.Errorf("put archive: object key is required")
	}
	if metadata.Plays < 0 {
		return ArchivePutResult{}, fmt.Errorf("put archive: play count must be non-negative")
	}

	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(body); err != nil {
		return ArchivePutResult{}, fmt.Errorf("gzip archive %s: %w", key, err)
	}
	if err := writer.Close(); err != nil {
		return ArchivePutResult{}, fmt.Errorf("gzip archive %s: %w", key, err)
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
		IfNoneMatch:     aws.String("*"),
		Metadata: map[string]string{
			archivePlaysMetadataKey:     strconv.Itoa(metadata.Plays),
			archiveTouchTierMetadataKey: strconv.FormatBool(metadata.TouchTier),
		},
	}); err != nil {
		if !isPreconditionFailed(err) {
			return ArchivePutResult{}, fmt.Errorf("put archive %s: %w", key, err)
		}
		return a.existing(ctx, key, err)
	}
	return ArchivePutResult{
		Bytes: len(compressed), Metadata: metadata, Created: true,
	}, nil
}

func (a *Archive) existing(
	ctx context.Context,
	key string,
	putErr error,
) (ArchivePutResult, error) {
	headCtx, cancel := context.WithTimeout(ctx, archiveOperationTimeout)
	defer cancel()
	output, err := a.client.HeadObject(headCtx, &s3.HeadObjectInput{
		Bucket: aws.String(a.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return ArchivePutResult{}, fmt.Errorf(
			"read existing archive %s after conditional put: %w",
			key, errors.Join(putErr, err))
	}
	if output == nil || output.ContentLength == nil || *output.ContentLength < 0 {
		return ArchivePutResult{}, fmt.Errorf(
			"read existing archive %s: missing content length", key)
	}
	maxInt := int64(^uint(0) >> 1)
	if *output.ContentLength > maxInt {
		return ArchivePutResult{}, fmt.Errorf(
			"read existing archive %s: content length exceeds int", key)
	}
	metadata, err := parsePlayArchiveMetadata(output.Metadata)
	if err != nil {
		return ArchivePutResult{}, fmt.Errorf(
			"read existing archive %s metadata: %w", key, err)
	}
	return ArchivePutResult{
		Bytes: int(*output.ContentLength), Metadata: metadata, Created: false,
	}, nil
}

func parsePlayArchiveMetadata(values map[string]string) (PlayArchiveMetadata, error) {
	playsValue, ok := values[archivePlaysMetadataKey]
	if !ok {
		return PlayArchiveMetadata{}, fmt.Errorf("missing %q", archivePlaysMetadataKey)
	}
	plays, err := strconv.Atoi(playsValue)
	if err != nil || plays < 0 {
		return PlayArchiveMetadata{}, fmt.Errorf(
			"invalid %q metadata", archivePlaysMetadataKey)
	}
	touchValue, ok := values[archiveTouchTierMetadataKey]
	if !ok {
		return PlayArchiveMetadata{}, fmt.Errorf(
			"missing %q", archiveTouchTierMetadataKey)
	}
	touchTier, err := strconv.ParseBool(touchValue)
	if err != nil {
		return PlayArchiveMetadata{}, fmt.Errorf(
			"invalid %q metadata", archiveTouchTierMetadataKey)
	}
	return PlayArchiveMetadata{Plays: plays, TouchTier: touchTier}, nil
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
