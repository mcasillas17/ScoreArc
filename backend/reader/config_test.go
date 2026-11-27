package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestLoadConfigFrom(t *testing.T) {
	t.Parallel()

	validKey := strings.Repeat("k", 32)
	tests := []struct {
		name    string
		env     map[string]string
		want    Config
		wantErr bool
	}{
		{name: "requires database URL", wantErr: true},
		{
			name: "defaults port and hardening bounds",
			env:  map[string]string{"DATABASE_URL": "postgres://reader@example/db"},
			want: Config{
				DatabaseURL: "postgres://reader@example/db",
				Port:        "8080",
				DBMaxConns:  defaultDBMaxConns,
				MaxInFlight: defaultMaxInFlight,
			},
		},
		{
			name: "accepts valid port and hardening configuration",
			env: map[string]string{
				"DATABASE_URL":                        "postgres://reader@example/db",
				"PORT":                                "9090",
				"READER_TRUSTED_KEY":                  validKey,
				"READER_REQUIRE_TRUSTED_SEASON_SCOPE": "true",
				"READER_CORS_ORIGINS":                 "https://www.scorearc.futbol, https://scorearc.futbol, http://localhost:3000, https://www.scorearc.futbol",
				"READER_DB_MAX_CONNS":                 "20",
				"READER_MAX_IN_FLIGHT":                "32",
			},
			want: Config{
				DatabaseURL:               "postgres://reader@example/db",
				Port:                      "9090",
				TrustedCallerKey:          validKey,
				RequireTrustedSeasonScope: true,
				CORSOrigins:               []string{"https://www.scorearc.futbol", "https://scorearc.futbol", "http://localhost:3000"},
				DBMaxConns:                20,
				MaxInFlight:               32,
			},
		},
		{
			name: "accepts none CORS mode",
			env: map[string]string{
				"DATABASE_URL":        "postgres://reader@example/db",
				"READER_CORS_ORIGINS": "none",
			},
			want: Config{
				DatabaseURL: "postgres://reader@example/db",
				Port:        "8080",
				CORSOrigins: []string{},
				DBMaxConns:  defaultDBMaxConns,
				MaxInFlight: defaultMaxInFlight,
			},
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
		{
			name: "rejects short trusted key",
			env: map[string]string{
				"DATABASE_URL":       "postgres://reader@example/db",
				"READER_TRUSTED_KEY": "too-short",
			},
			wantErr: true,
		},
		{
			name: "rejects trusted key with whitespace",
			env: map[string]string{
				"DATABASE_URL":       "postgres://reader@example/db",
				"READER_TRUSTED_KEY": strings.Repeat("a", 31) + " ",
			},
			wantErr: true,
		},
		{
			name: "requires trusted key when season scope gate is enabled",
			env: map[string]string{
				"DATABASE_URL":                        "postgres://reader@example/db",
				"READER_REQUIRE_TRUSTED_SEASON_SCOPE": "true",
			},
			wantErr: true,
		},
		{
			name: "rejects invalid boolean for season scope gate",
			env: map[string]string{
				"DATABASE_URL":                        "postgres://reader@example/db",
				"READER_REQUIRE_TRUSTED_SEASON_SCOPE": "maybe",
			},
			wantErr: true,
		},
		{
			name: "rejects non-https non-loopback CORS origin",
			env: map[string]string{
				"DATABASE_URL":        "postgres://reader@example/db",
				"READER_CORS_ORIGINS": "http://scorearc.futbol",
			},
			wantErr: true,
		},
		{
			name: "rejects CORS origin with path",
			env: map[string]string{
				"DATABASE_URL":        "postgres://reader@example/db",
				"READER_CORS_ORIGINS": "https://scorearc.futbol/en",
			},
			wantErr: true,
		},
		{
			name: "rejects out-of-bounds READER_DB_MAX_CONNS",
			env: map[string]string{
				"DATABASE_URL":        "postgres://reader@example/db",
				"READER_DB_MAX_CONNS": "1",
			},
			wantErr: true,
		},
		{
			name: "rejects out-of-bounds READER_MAX_IN_FLIGHT",
			env: map[string]string{
				"DATABASE_URL":         "postgres://reader@example/db",
				"READER_MAX_IN_FLIGHT": "999",
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
			if !reflect.DeepEqual(got, tt.want) {
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
