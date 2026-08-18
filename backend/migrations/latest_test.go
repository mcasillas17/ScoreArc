package migrations

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// Latest() must agree with what is actually on disk. If it does not, the
// startup guard would compare the database against a version this binary does
// not really carry.
func TestLatestMatchesTheHighestFileOnDisk(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read migrations dir: %v", err)
	}
	highest := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		version, err := strconv.Atoi(name[:strings.IndexByte(name, '_')])
		if err != nil {
			continue
		}
		if version > highest {
			highest = version
		}
	}
	got, err := Latest()
	if err != nil {
		t.Fatalf("Latest: %v", err)
	}
	if got != highest {
		t.Fatalf("Latest() = %d, highest file on disk = %d", got, highest)
	}
}

// The sequence is deliberately non-contiguous — 0008 and 0009 were renumbered
// to 0014/0015 after being merged below the watermark. Latest() must take the
// maximum, not the count, or it would report 13 for a tree holding 0021.
func TestLatestTakesTheMaximumNotTheCount(t *testing.T) {
	got, err := Latest()
	if err != nil {
		t.Fatalf("Latest: %v", err)
	}
	entries, _ := files.ReadDir(".")
	if got == len(entries) && got != 0 {
		t.Fatalf("Latest() = %d equals the file count; it must be the max version", got)
	}
}
