// cmd/api/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/jwtauth/v5"
	"github.com/go-playground/validator/v10"
	"github.com/example/social-network/internal/config"
	"github.com/example/social-network/internal/database"
	"github.com/example/social-network/internal/http/handler"
	"github.com/example/social-network/internal/logging"
	custommw "github.com/example/social-network/internal/middleware"
	"github.com/example/social-network/internal/repository/postgres"
	"github.com/example/social-network/internal/service"
	"go.uber.org/zap"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// Initialize logger
	logger, err := logging.NewLogger(cfg.Environment)
	if err != nil {
		log.Fatalf("failed to create logger: %v", err)
	}
	defer logger.Sync()

	// Initialize database
	db, err := database.NewPostgresDB(cfg.Database)
	if err != nil {
		logger.Fatal("failed to connect to database", zap.Error(err))
	}
	defer db.Close()

	// Initialize repositories
	userRepo := postgres.NewUserRepository(db)
	postRepo := postgres.NewPostRepository(db)

	// Initialize dependent services
	notifService := service.NewNotificationService(nil, userRepo, postRepo, logger)
	feedService := service.NewFeedService(nil, postRepo, userRepo, nil, nil, logger)

	// Initialize services
	userService := service.NewUserService(userRepo, logger)
	postService := service.NewPostService(postRepo, userRepo, feedService, notifService, logger)

	// Initialize handlers
	validate := validator.New()
	tokenAuth := jwtauth.New("HS256", []byte(cfg.JWTSecret), nil)

	userHandler := handler.NewUserHandler(userService, validate, tokenAuth, logger)
	wsHandler := handler.NewWebSocketHandler(notifService, logger)

	_ = postService // used via routes below

	// Setup router
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(custommw.CORS())
	r.Use(custommw.RateLimit())

	// Routes
	r.Route("/api/v1", func(r chi.Router) {
		// Public routes
		r.Post("/register", userHandler.Register)
		r.Post("/login", userHandler.Login)

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(custommw.Authenticator(tokenAuth))

			// User routes
			r.Get("/me", userHandler.GetCurrentUser)
			r.Put("/me", userHandler.UpdateUser)
			r.Get("/users/{username}", userHandler.GetUserByUsername)
			r.Get("/users/search", userHandler.SearchUsers)

			// WebSocket
			r.Get("/ws/notifications", wsHandler.HandleNotifications)
		})
	})

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Start server
	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	go func() {
		logger.Info("starting server", zap.Int("port", cfg.Port))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Fatal("server forced to shutdown", zap.Error(err))
	}

	logger.Info("server exited")
}
