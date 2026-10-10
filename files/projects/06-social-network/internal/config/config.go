// internal/config/config.go
package config

import (
	"os"
	"strconv"
	"time"

	"github.com/example/social-network/internal/database"
)

// Config holds all application configuration.
type Config struct {
	Environment string
	Port        int
	JWTSecret   string
	Database    database.Config
}

// Load reads configuration from environment variables with sensible defaults.
func Load() (*Config, error) {
	port, _ := strconv.Atoi(getEnv("PORT", "8080"))
	dbPort, _ := strconv.Atoi(getEnv("DB_PORT", "5432"))
	maxOpen, _ := strconv.Atoi(getEnv("DB_MAX_OPEN_CONNS", "100"))
	maxIdle, _ := strconv.Atoi(getEnv("DB_MAX_IDLE_CONNS", "25"))

	return &Config{
		Environment: getEnv("APP_ENV", "development"),
		Port:        port,
		JWTSecret:   getEnv("JWT_SECRET", "change-me-in-production"),
		Database: database.Config{
			Host:            getEnv("DB_HOST", "localhost"),
			Port:            dbPort,
			User:            getEnv("DB_USER", "postgres"),
			Password:        getEnv("DB_PASSWORD", ""),
			Database:        getEnv("DB_NAME", "social_network"),
			SSLMode:         getEnv("DB_SSLMODE", "disable"),
			MaxOpenConns:    maxOpen,
			MaxIdleConns:    maxIdle,
			ConnMaxLifetime: time.Hour,
			ConnMaxIdleTime: 10 * time.Minute,
		},
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
