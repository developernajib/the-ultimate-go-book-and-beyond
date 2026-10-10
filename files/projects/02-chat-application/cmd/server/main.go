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

	"github.com/example/chat-application/internal/api"
	"github.com/example/chat-application/internal/auth"
	"github.com/example/chat-application/internal/chat"
	"github.com/example/chat-application/internal/config"
	"github.com/example/chat-application/internal/storage"
	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/redis/go-redis/v9"
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

	db, err := sql.Open("pgx", dsn)
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
