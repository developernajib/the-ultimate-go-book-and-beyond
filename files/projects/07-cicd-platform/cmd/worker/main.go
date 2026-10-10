package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/example/cicd-platform/internal/queue"
	"github.com/example/cicd-platform/internal/storage"
	"github.com/example/cicd-platform/internal/worker"
)

func main() {
	// Configure logging
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	// Load configuration
	cfg := loadConfig()

	// Connect to database
	db, err := storage.New(cfg.DatabaseURL)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer db.Close()

	// Create job queue
	jobQueue, err := queue.NewRedisQueue(cfg.RedisURL)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to create job queue")
	}

	// Create worker
	w, err := worker.New(&worker.Config{
		Name:     cfg.WorkerName,
		Capacity: cfg.WorkerCapacity,
		WorkDir:  cfg.WorkDir,
		LogDir:   cfg.LogDir,
	}, jobQueue, db)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to create worker")
	}

	// Start worker
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if err := w.Start(ctx); err != nil {
			log.Error().Err(err).Msg("Worker error")
		}
	}()

	// Wait for interrupt
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info().Msg("Shutting down worker...")
	w.Stop()
	log.Info().Msg("Worker exited")
}

type Config struct {
	DatabaseURL    string
	RedisURL       string
	WorkerName     string
	WorkerCapacity int
	WorkDir        string
	LogDir         string
}

func loadConfig() *Config {
	hostname, _ := os.Hostname()

	return &Config{
		DatabaseURL:    getEnv("DATABASE_URL", "postgresql://cicd:cicd@localhost:5432/cicd?sslmode=disable"),
		RedisURL:       getEnv("REDIS_URL", "redis://localhost:6379/0"),
		WorkerName:     getEnv("WORKER_NAME", fmt.Sprintf("worker-%s", hostname)),
		WorkerCapacity: getEnvInt("WORKER_CAPACITY", 5),
		WorkDir:        getEnv("WORK_DIR", "/tmp/cicd/workspace"),
		LogDir:         getEnv("LOG_DIR", "/tmp/cicd/logs"),
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
