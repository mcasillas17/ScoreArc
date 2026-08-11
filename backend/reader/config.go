package main

import (
	"fmt"
	"os"
	"strconv"
)

// Config contains the reader's process configuration. DatabaseURL must use the
// SELECT-only scorearc_reader login in production.
type Config struct {
	DatabaseURL string
	Port        string
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

	return Config{DatabaseURL: databaseURL, Port: port}, nil
}
