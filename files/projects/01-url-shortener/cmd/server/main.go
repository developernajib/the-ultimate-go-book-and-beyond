// cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"

	"github.com/example/url-shortener/internal/api"
	"github.com/example/url-shortener/internal/api/handlers"
	"github.com/example/url-shortener/internal/api/middleware"
	"github.com/example/url-shortener/internal/cache"
	"github.com/example/url-shortener/internal/ratelimit"
	"github.com/example/url-shortener/internal/repository/postgres"
	"github.com/example/url-shortener/internal/service"
)

func main() {
	// Database connection
	dbURL := getEnv("DATABASE_URL", "postgres://goshort:password@localhost:5432/goshort?sslmode=disable")
	db, err := sqlx.Connect("postgres", dbURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Redis connection
	redisURL := getEnv("REDIS_URL", "redis://localhost:6379")
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("Failed to parse Redis URL: %v", err)
	}
	redisClient := redis.NewClient(opts)
	defer redisClient.Close()

	// Repositories
	urlRepo := postgres.NewURLRepository(db)
	analyticsRepo := postgres.NewAnalyticsRepository(db)

	// Cache
	lruCache := cache.NewLRUCache(10000)
	redisCache := cache.NewRedisCache(redisClient, "goshort")
	layeredCache := cache.NewLayeredCache(lruCache, redisCache)

	// Rate limiter
	rateLimiter := ratelimit.NewTokenBucketLimiter(redisClient, "goshort")

	// Services
	geoIP := &service.MockGeoIPService{}
	enricher := service.NewEventEnricher(geoIP)
	analyticsSvc := service.NewAnalyticsService(analyticsRepo, enricher)
	shortenerSvc := service.NewShortenerService(urlRepo, layeredCache, analyticsSvc, &rateLimiterAdapter{limiter: rateLimiter})

	// Handlers and middleware
	h := handlers.NewHandler(shortenerSvc, analyticsSvc)
	m := middleware.NewMiddleware(rateLimiter)

	// Router
	router := api.SetupRouter(h, m)

	// HTTP server
	addr := getEnv("SERVER_ADDR", ":8080")
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server
	go func() {
		log.Printf("Starting server on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server stopped")
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}

// rateLimiterAdapter adapts TokenBucketLimiter to the service.RateLimiter interface
type rateLimiterAdapter struct {
	limiter *ratelimit.TokenBucketLimiter
}

func (a *rateLimiterAdapter) Allow(ctx context.Context, identifier string) (bool, error) {
	allowed, _, _, err := a.limiter.Allow(ctx, identifier, 100, time.Hour)
	return allowed, err
}
