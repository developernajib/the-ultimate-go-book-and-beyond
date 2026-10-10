package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/example/cicd-platform/internal/api"
	"github.com/example/cicd-platform/internal/storage"
	"github.com/example/cicd-platform/internal/websocket"
)

func main() {
	// Configure logging
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	// Load configuration from environment
	cfg := loadConfig()

	// Connect to database
	db, err := storage.New(cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer db.Close()

	log.Info().Msg("Connected to database")

	// Create WebSocket hub
	hub := websocket.NewHub()
	go hub.Run()

	// Create HTTP handler
	handler := api.NewHandler(db, cfg.WebhookSecret)
	router := api.NewRouter(handler)

	// Create HTTP server
	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		log.Info().Int("port", cfg.Port).Msg("Starting API server")
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("Server failed")
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("Shutting down server...")

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("Server forced to shutdown")
	}

	log.Info().Msg("Server exited")
}

type Config struct {
	Port          int
	DatabaseURL   string
	RedisURL      string
	WebhookSecret string
	S3Endpoint    string
	S3AccessKey   string
	S3SecretKey   string
}

func loadConfig() *Config {
	return &Config{
		Port:          getEnvInt("PORT", 8080),
		DatabaseURL:   getEnv("DATABASE_URL", "postgresql://cicd:cicd@localhost:5432/cicd?sslmode=disable"),
		RedisURL:      getEnv("REDIS_URL", "redis://localhost:6379/0"),
		WebhookSecret: getEnv("WEBHOOK_SECRET", "changeme"),
		S3Endpoint:    getEnv("S3_ENDPOINT", "localhost:9000"),
		S3AccessKey:   getEnv("S3_ACCESS_KEY", "minioadmin"),
		S3SecretKey:   getEnv("S3_SECRET_KEY", "minioadmin"),
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
	if val := os.Getenv(key); val != "" {
		var i int
		fmt.Sscanf(val, "%d", &i)
		return i
	}
	return defaultVal
}
