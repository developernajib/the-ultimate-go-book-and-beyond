## 54.1 Project Setup

### Project Structure

A clean directory layout separates concerns before the codebase grows. Go backend packages live in `internal/` (unexported to external consumers), the frontend source lives under `frontend/`, and shared infrastructure configuration sits at the root. The tree below shows the layout for this application.

```
task-manager/
├── backend/
│   ├── cmd/
│   │   └── server/
│   │       └── main.go
│   ├── internal/
│   │   ├── auth/
│   │   │   ├── handler.go
│   │   │   ├── service.go
│   │   │   └── middleware.go
│   │   ├── task/
│   │   │   ├── handler.go
│   │   │   ├── service.go
│   │   │   ├── repository.go
│   │   │   └── model.go
│   │   ├── project/
│   │   │   ├── handler.go
│   │   │   ├── service.go
│   │   │   └── model.go
│   │   ├── user/
│   │   │   ├── handler.go
│   │   │   ├── service.go
│   │   │   └── model.go
│   │   └── ws/
│   │       └── hub.go
│   ├── pkg/
│   │   ├── config/
│   │   ├── database/
│   │   └── middleware/
│   ├── migrations/
│   ├── go.mod
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── store/
│   │   ├── hooks/
│   │   ├── types/
│   │   └── utils/
│   ├── package.json
│   ├── vite.config.ts
│   └── Dockerfile
└── docker-compose.yml
```

### Go Backend Setup

The `main.go` entry point wires together configuration loading, database connection, migrations, and HTTP server startup. It initializes all repositories and services in dependency order, then mounts route groups with middleware. The graceful shutdown block at the bottom listens for SIGINT/SIGTERM and drains in-flight requests before exiting.

```go
// backend/cmd/server/main.go
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"taskmanager/internal/auth"
	"taskmanager/internal/project"
	"taskmanager/internal/task"
	"taskmanager/internal/user"
	"taskmanager/internal/ws"
	"taskmanager/pkg/config"
	"taskmanager/pkg/database"
	"taskmanager/pkg/middleware"
)

func main() {
	// Logger setup
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load configuration
	cfg := config.Load()

	// Database connection
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		logger.Error("Failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Run migrations
	if err := database.Migrate(db); err != nil {
		logger.Error("Failed to run migrations", "error", err)
		os.Exit(1)
	}

	// Initialize WebSocket hub
	wsHub := ws.NewHub(logger)
	go wsHub.Run()

	// Initialize services
	userRepo := user.NewRepository(db)
	userService := user.NewService(userRepo)

	authService := auth.NewService(userService, cfg.JWTSecret)

	projectRepo := project.NewRepository(db)
	projectService := project.NewService(projectRepo)

	taskRepo := task.NewRepository(db)
	taskService := task.NewService(taskRepo, wsHub)

	// Initialize handlers
	authHandler := auth.NewHandler(authService)
	userHandler := user.NewHandler(userService)
	projectHandler := project.NewHandler(projectService)
	taskHandler := task.NewHandler(taskService)

	// Router setup
	r := chi.NewRouter()

	// Middleware
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.Logger(logger))
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(60 * time.Second))

	// CORS
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.AllowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Request-ID"},
		ExposedHeaders:   []string{"X-Request-ID", "X-Total-Count"},
		AllowCredentials: true,
		MaxAge:           86400,
	}))

	// Routes
	r.Route("/api/v1", func(r chi.Router) {
		// Public routes
		r.Group(func(r chi.Router) {
			r.Post("/auth/register", authHandler.Register)
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/refresh", authHandler.RefreshToken)
		})

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(auth.Middleware(cfg.JWTSecret))

			// User routes
			r.Get("/users/me", userHandler.GetCurrentUser)
			r.Put("/users/me", userHandler.UpdateCurrentUser)

			// Project routes
			r.Get("/projects", projectHandler.List)
			r.Post("/projects", projectHandler.Create)
			r.Get("/projects/{id}", projectHandler.Get)
			r.Put("/projects/{id}", projectHandler.Update)
			r.Delete("/projects/{id}", projectHandler.Delete)
			r.Get("/projects/{id}/members", projectHandler.GetMembers)
			r.Post("/projects/{id}/members", projectHandler.AddMember)
			r.Delete("/projects/{id}/members/{userId}", projectHandler.RemoveMember)

			// Task routes
			r.Get("/projects/{projectId}/tasks", taskHandler.List)
			r.Post("/projects/{projectId}/tasks", taskHandler.Create)
			r.Get("/tasks/{id}", taskHandler.Get)
			r.Put("/tasks/{id}", taskHandler.Update)
			r.Patch("/tasks/{id}/status", taskHandler.UpdateStatus)
			r.Patch("/tasks/{id}/position", taskHandler.UpdatePosition)
			r.Delete("/tasks/{id}", taskHandler.Delete)
			r.Post("/tasks/{id}/comments", taskHandler.AddComment)
			r.Get("/tasks/{id}/comments", taskHandler.GetComments)
		})

		// WebSocket
		r.Get("/ws", func(w http.ResponseWriter, r *http.Request) {
			wsHub.HandleConnection(w, r, cfg.JWTSecret)
		})
	})

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	// Server setup
	server := &http.Server{
		Addr:         cfg.ServerAddr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server
	go func() {
		logger.Info("Starting server", "addr", cfg.ServerAddr)
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			logger.Error("Server error", "error", err)
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down server...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Error("Server shutdown error", "error", err)
	}

	logger.Info("Server stopped")
}
```

### Configuration

Centralizing configuration in a single struct loaded from environment variables keeps the application portable across environments. The `getEnv` helper falls back to sensible defaults for local development, so the application runs without any environment setup. In production, override `JWT_SECRET` and `DATABASE_URL` with real values.

```go
// backend/pkg/config/config.go
package config

import (
	"os"
	"strings"
)

type Config struct {
	ServerAddr     string
	DatabaseURL    string
	JWTSecret      string
	AllowedOrigins []string
}

func Load() *Config {
	return &Config{
		ServerAddr:     getEnv("SERVER_ADDR", ":8080"),
		DatabaseURL:    getEnv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/taskmanager?sslmode=disable"),
		JWTSecret:      getEnv("JWT_SECRET", "your-secret-key-change-in-production"),
		AllowedOrigins: strings.Split(getEnv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173"), ","),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
```

### Junior -> FAANG: Project Structure as a Communication Tool

The directory layout in this file is not arbitrary. Go's `internal/` convention enforces package-level encapsulation at the toolchain level: nothing outside `backend/` can import from `internal/`. This matters in interviews because it shows you understand Go's module boundaries, not just its syntax.

When walking through your project structure in a system design interview, explain why each boundary exists. The `pkg/` directory holds cross-cutting utilities (config, database, middleware) that multiple internal packages depend on. The `cmd/server/main.go` is the only place that wires dependencies together. If a candidate puts business logic in `main.go`, it signals that they have not thought about testability.

Practice explaining this layout out loud in two minutes: what lives where, why those boundaries were chosen, and how you would test each layer in isolation. That narration is what FAANG system design interviews are actually assessing.

### Senior @ FAANG: Entry Point Wiring as a Governance Surface

The `main.go` shown here follows manual dependency injection: each repository and service is constructed in dependency order, then passed to the handler that needs it. This is a good starting point. At scale, two problems emerge.

First, as the dependency graph grows, `main.go` becomes a 300-line constructor chain. The common resolution at FAANG is a dependency injection framework (Google's Wire for Go, compile-time code generation) that makes the graph explicit and checks it at compile time. The ADR choice is: generate code you can read and debug, or use a runtime container that is opaque on failure. Wire generates code, fx (Uber's container) uses reflection. For Go, Wire is the correct senior choice because generated code is auditable.

Second, the graceful shutdown block matters more than its size suggests. Thirty seconds is a timeout, not a guarantee. If a handler is holding a long-running database transaction when SIGTERM arrives, the transaction will be rolled back mid-flight when the timeout expires. The correct pattern is to track in-flight requests with a `sync.WaitGroup`, signal new requests to drain via a context, and only start the shutdown timer after the wait group reaches zero. The current implementation delegates all of that to `server.Shutdown`, which is correct for HTTP connections but does not cover background goroutines (the WebSocket hub's `Run` goroutine, the notification flush ticker). A staff engineer would audit every `go func()` at startup and ensure each one exits cleanly on the shutdown context.

Configuration management at L6 level is a security surface. The `getEnv` fallback to a hardcoded default JWT secret is a training-data footgun: developers copy-paste the default into their first production deploy and ship a known-bad secret. The correct design is to fail fast when `JWT_SECRET` is not set in production. Distinguish environments explicitly (a `GO_ENV` or `APP_ENV` variable) and panic on startup if a required secret is missing. Twelve-factor apps do not have defaults for secrets.

---
