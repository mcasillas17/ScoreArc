package main

import (
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

const (
	minTrustedKeyLength = 32
	defaultDBMaxConns   = 12
	defaultMaxInFlight  = 24
)

// Config contains the reader's process configuration. DatabaseURL must use the
// SELECT-only scorearc_reader login in production.
type Config struct {
	DatabaseURL               string
	Port                      string
	TrustedCallerKey          string
	RequireTrustedSeasonScope bool
	CORSOrigins               []string
	DBMaxConns                int32
	MaxInFlight               int
}

func loadConfig() (Config, error) { return loadConfigFrom(os.Getenv) }

func loadConfigFrom(getenv func(string) string) (Config, error) {
	databaseURL := getenv("DATABASE_URL")
	if databaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}

	port := getenv("PORT")
	if port == "" {
		port = "8080"
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return Config{}, fmt.Errorf("PORT must be an integer between 1 and 65535")
	}

	trustedKey := getenv("READER_TRUSTED_KEY")
	if trustedKey != "" {
		if len(trustedKey) < minTrustedKeyLength || strings.IndexFunc(trustedKey, unicode.IsSpace) != -1 {
			return Config{}, fmt.Errorf("READER_TRUSTED_KEY must be at least %d non-whitespace characters", minTrustedKeyLength)
		}
	}

	requireTrustedSeason, err := parseBoolEnv("READER_REQUIRE_TRUSTED_SEASON_SCOPE", getenv("READER_REQUIRE_TRUSTED_SEASON_SCOPE"))
	if err != nil {
		return Config{}, err
	}
	if requireTrustedSeason && trustedKey == "" {
		return Config{}, fmt.Errorf("READER_REQUIRE_TRUSTED_SEASON_SCOPE requires READER_TRUSTED_KEY")
	}

	corsOrigins, err := parseCORSOrigins(getenv("READER_CORS_ORIGINS"))
	if err != nil {
		return Config{}, err
	}

	dbMaxConns, err := parseBoundedInt("READER_DB_MAX_CONNS", getenv("READER_DB_MAX_CONNS"), defaultDBMaxConns, 2, 64)
	if err != nil {
		return Config{}, err
	}

	maxInFlight, err := parseBoundedInt("READER_MAX_IN_FLIGHT", getenv("READER_MAX_IN_FLIGHT"), defaultMaxInFlight, 4, 256)
	if err != nil {
		return Config{}, err
	}

	return Config{
		DatabaseURL:               databaseURL,
		Port:                      port,
		TrustedCallerKey:          trustedKey,
		RequireTrustedSeasonScope: requireTrustedSeason,
		CORSOrigins:               corsOrigins,
		DBMaxConns:                int32(dbMaxConns),
		MaxInFlight:               maxInFlight,
	}, nil
}

func parseBoolEnv(name, raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "false", "0":
		return false, nil
	case "true", "1":
		return true, nil
	default:
		return false, fmt.Errorf("%s must be a boolean", name)
	}
}

func parseBoundedInt(name, raw string, fallback, minVal, maxVal int) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return fallback, nil
	}
	val, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || val < minVal || val > maxVal {
		return 0, fmt.Errorf("%s must be an integer between %d and %d", name, minVal, maxVal)
	}
	return val, nil
}

func parseCORSOrigins(raw string) ([]string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "*" {
		return nil, nil
	}
	if strings.EqualFold(trimmed, "none") {
		return []string{}, nil
	}
	parts := strings.Split(trimmed, ",")
	origins := make([]string, 0, len(parts))
	for _, part := range parts {
		candidate := strings.TrimSpace(part)
		if candidate == "" {
			return nil, fmt.Errorf("READER_CORS_ORIGINS contains an empty entry")
		}
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("READER_CORS_ORIGINS must contain plain origins (got %q)", candidate)
		}
		host := parsed.Hostname()
		isLoopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
		if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback) {
			return nil, fmt.Errorf("READER_CORS_ORIGINS requires https (or loopback http) origin (got %q)", candidate)
		}
		normalized := parsed.Scheme + "://" + strings.ToLower(parsed.Host)
		if !slices.Contains(origins, normalized) {
			origins = append(origins, normalized)
		}
	}
	return origins, nil
}
