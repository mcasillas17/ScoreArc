// Package migrations owns the SQL schema files and the version the binary
// expects the database to be at.
//
// The expected version is derived from the embedded filenames rather than
// declared as a constant, so it cannot drift: adding 0022_foo.up.sql moves it
// automatically, and there is no second place to remember to update.
package migrations

import (
	"embed"
	"fmt"
	"strconv"
	"strings"
)

//go:embed *.up.sql
var files embed.FS

// Latest is the highest migration version present in this binary.
//
// Deploys ship code; migrations are applied by hand (docs/backend/SETUP.md §5).
// That gap is real: on 2026-08-18 a deploy shipped an ingester expecting
// match_final_capture_status against a database still at version 15, and the
// only symptom was a per-competition warning on every tick that read like a
// transient fault. Comparing this against schema_migrations turns that into one
// unambiguous line at startup.
func Latest() (int, error) {
	entries, err := files.ReadDir(".")
	if err != nil {
		return 0, fmt.Errorf("read embedded migrations: %w", err)
	}
	highest := 0
	for _, entry := range entries {
		name := entry.Name()
		underscore := strings.IndexByte(name, '_')
		if underscore <= 0 {
			continue
		}
		version, err := strconv.Atoi(name[:underscore])
		if err != nil {
			// A file that is not `NNNN_name.up.sql` is not a migration; the
			// numbering is the contract golang-migrate enforces, so anything
			// else is ignored rather than guessed at.
			continue
		}
		if version > highest {
			highest = version
		}
	}
	if highest == 0 {
		return 0, fmt.Errorf("no migrations embedded")
	}
	return highest, nil
}
