package main

import (
	"strings"
	"testing"
)

func TestLoadConfigFrom(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		env     map[string]string
		want    Config
		wantErr bool
	}{
		{name: "requires database URL", wantErr: true},
		{
			name: "defaults port",
			env:  map[string]string{"DATABASE_URL": "postgres://reader@example/db"},
			want: Config{DatabaseURL: "postgres://reader@example/db", Port: "8080"},
		},
		{
			name: "accepts valid port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "9090",
			},
			want: Config{DatabaseURL: "postgres://reader@example/db", Port: "9090"},
		},
		{
			name: "rejects non-numeric port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "http",
			},
			wantErr: true,
		},
		{
			name: "rejects out-of-range port",
			env: map[string]string{
				"DATABASE_URL": "postgres://reader@example/db",
				"PORT":         "65536",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			getenv := func(key string) string { return tt.env[key] }
			got, err := loadConfigFrom(getenv)
			if (err != nil) != tt.wantErr {
				t.Fatalf("loadConfigFrom() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("loadConfigFrom() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// The check needs only the DSN it reads the ledger over: PORT configures a
// listener check mode never opens.
func TestCheckSchemaOnlyNeedsOnlyTheDatabaseURL(t *testing.T) {
	t.Setenv("PORT", "not-a-port")
	t.Setenv("DATABASE_URL", "")
	var out strings.Builder
	if code := checkSchemaOnly(&out); code != 1 || out.String() != "database schema not checked: DATABASE_URL is required\n" {
		t.Fatalf("exit %d output %q", code, out.String())
	}
	// Unreachable on purpose: the invalid PORT was ignored, and the failure
	// line keeps no DSN text. The sentinel is the user and database name,
	// which pgx's connect error quotes (it drops only the password).
	t.Setenv("DATABASE_URL", "postgres://must_not_log_user@127.0.0.1:1/must_not_log_db?sslmode=disable&connect_timeout=2")
	out.Reset()
	code := checkSchemaOnly(&out)
	if text := out.String(); code != 1 || strings.Count(text, "\n") != 1 ||
		!strings.HasPrefix(text, "database schema not ready: category=") || strings.Contains(text, "must_not_log") {
		t.Fatalf("exit %d output %q", code, text)
	}
}
