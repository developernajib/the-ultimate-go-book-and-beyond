## Part 9: Main Application

The main application file is where all previously implemented components come together. It initializes configuration, establishes database and Redis connections, creates the WebSocket hub, wires up HTTP routes, and starts the server with graceful shutdown support. Graceful shutdown is especially important for a chat application because you need to cleanly close all active WebSocket connections and flush any pending messages before the process exits. This entry point also demonstrates the dependency injection pattern, each component receives its dependencies explicitly rather than relying on global state.

### 9.1 Main Server (`cmd/server/main.go`)

The main entry point composes all application components, initializes dependencies in correct order, and starts the server. Graceful shutdown handling allows in-flight requests to complete and resources to be released cleanly when the process receives a termination signal.

```go
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	_ "github.com/jackc/pgx/v5"

	"github.com/yourusername/gochat/internal/api"
	"github.com/yourusername/gochat/internal/auth"
	"github.com/yourusername/gochat/internal/chat"
	"github.com/yourusername/gochat/internal/config"
	"github.com/yourusername/gochat/internal/storage"
)

func main() {
	// Load .env file
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found")
	}

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize PostgreSQL
	db, err := initDB(cfg.Database)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Initialize Redis
	redisClient := initRedis(cfg.Redis)
	defer redisClient.Close()

	// Initialize S3
	s3Store, err := storage.NewS3Store(
		cfg.S3.Endpoint,
		cfg.S3.AccessKeyID,
		cfg.S3.SecretAccessKey,
		cfg.S3.Bucket,
		cfg.S3.Region,
		cfg.S3.UseSSL,
	)
	if err != nil {
		log.Fatalf("Failed to initialize S3: %v", err)
	}

	// Initialize stores
	pgStore := storage.NewPostgresStore(db)
	redisStore := storage.NewRedisStore(redisClient)

	// Initialize services
	jwtService := auth.NewJWTService(cfg.JWT.Secret, cfg.JWT.Expiration)
	messageHandler := chat.NewMessageHandler(pgStore)
	presenceService := chat.NewPresenceService(redisStore)

	// Initialize WebSocket hub
	hub := chat.NewHub(redisClient, messageHandler, presenceService)
	go hub.Run()

	// Initialize handlers
	handlers := api.NewHandlers(pgStore, redisStore, jwtService)
	wsHandler := api.NewWSHandler(hub, jwtService)
	uploadHandler := api.NewUploadHandler(s3Store, pgStore)

	// Initialize middleware
	authMiddleware := auth.NewMiddleware(jwtService)
	rateLimiter := auth.NewRateLimiter(redisStore, 100, time.Minute)

	// Setup routes
	router := setupRoutes(handlers, wsHandler, uploadHandler, authMiddleware, rateLimiter)

	// Create server
	server := &http.Server{
		Addr:         ":" + cfg.Server.Port,
		Handler:      router,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
	}

	// Start server
	go func() {
		log.Printf("Server starting on port %s", cfg.Server.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
	defer cancel()

	hub.Shutdown()

	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server stopped")
}

func initDB(cfg config.DatabaseConfig) (*sql.DB, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.DBName, cfg.SSLMode,
	)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

	if err := db.Ping(); err != nil {
		return nil, err
	}

	return db, nil
}

func initRedis(cfg config.RedisConfig) *redis.Client {
	client := redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		PoolSize:     cfg.PoolSize,
		MinIdleConns: cfg.MinIdleConns,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}

	return client
}

func setupRoutes(
	handlers *api.Handlers,
	wsHandler *api.WSHandler,
	uploadHandler *api.UploadHandler,
	authMiddleware *auth.Middleware,
	rateLimiter *auth.RateLimiter,
) *chi.Mux {
	router := chi.NewRouter()

	// Public routes
	router.Post("/api/register", handlers.Register)
	router.Post("/api/login", handlers.Login)

	// WebSocket (requires token in query parameter)
	router.Get("/ws", wsHandler.ServeWebSocket)

	// Protected routes
	router.Route("/api", func(r chi.Router) {
		r.Use(rateLimiter.LimitByUser)
		r.Use(authMiddleware.Authenticate)

		// Channels
		r.Get("/channels", handlers.GetChannels)
		r.Post("/channels", handlers.CreateChannel)
		r.Get("/channels/{id}", handlers.GetChannel)

		// Messages
		r.Get("/channels/{channelId}/messages", handlers.GetMessages)
		r.Get("/messages/search", handlers.SearchMessages)

		// Upload
		r.Post("/upload", uploadHandler.UploadFile)
	})

	// Serve static files
	router.Handle("/*", http.FileServer(http.Dir("./web/static")))

	return router
}
```

### Junior → FAANG: Main as a Dependency Injection Root

The `main.go` file should be the only place in your application where concrete implementations are instantiated and wired together. Everything else should depend on interfaces. This means `main.go` is inherently integration-tested by the act of running the binary: if the wiring is wrong, it fails at startup.

Graceful shutdown is a correctness requirement for WebSocket servers. When the process receives SIGTERM (as happens during a Kubernetes rolling deploy), open WebSocket connections must be closed with a proper close frame, in-flight messages must be flushed, and database connections must be returned to the pool. A server that exits without graceful shutdown drops active connections, causing client-visible errors.

Context propagation from the root context through to individual request handlers enables cancellation. When the root context is canceled (on SIGTERM), in-progress operations will cancel at their next context check point, which is the mechanism for bounded shutdown time.

### Senior @ FAANG: Startup Sequencing as an Operational Concern

At senior level, startup sequencing is a reliability concern. The order in which dependencies are initialized matters: the database connection pool must be ready before the HTTP server starts accepting requests. The Redis connection must be ready before the WebSocket hub starts. If any dependency is unavailable at startup, the service should exit with a non-zero exit code rather than starting in a degraded state.

Kubernetes readiness probes work in conjunction with startup sequencing. The readiness probe should return unhealthy until all dependencies are confirmed healthy. This prevents the Kubernetes load balancer from routing traffic to an instance that is still initializing. A common bug is a service that returns healthy on the readiness probe before its database connection pool has warmed up, causing a burst of slow queries on initial traffic.

Structured startup logging (logging each dependency initialization step with timestamps) enables faster incident diagnosis when a service fails to start in production. Without structured startup logs, "service failed to start" in Kubernetes is an opaque event. With structured startup logs, you can identify exactly which dependency caused the failure and how long each step took. This is a small investment at implementation time that pays significant dividends during on-call incidents.

---
