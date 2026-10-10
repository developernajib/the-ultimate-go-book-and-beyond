## Main Application

The main application file wires together all the components we have built: it initializes the database connections, creates the repositories, constructs the services, sets up HTTP handlers, and starts the server. This is the entry point of the entire social network backend. Notice how it configures graceful shutdown, which waits for in-flight requests to complete before stopping the server. This prevents data loss and broken connections when deploying new versions of the application.

```go
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
    "github.com/yourname/socialnet/internal/config"
    "github.com/yourname/socialnet/internal/database"
    "github.com/yourname/socialnet/internal/http/handler"
    custommw "github.com/yourname/socialnet/internal/middleware"
    "github.com/yourname/socialnet/internal/repository/postgres"
    "github.com/yourname/socialnet/internal/service"
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
    // ... other repositories

    // Initialize services
    userService := service.NewUserService(userRepo, logger)
    postService := service.NewPostService(postRepo, userRepo, feedService, notifService, logger)
    // ... other services

    // Initialize handlers
    validator := validator.New()
    tokenAuth := jwtauth.New("HS256", []byte(cfg.JWTSecret), nil)

    userHandler := handler.NewUserHandler(userService, validator, tokenAuth, logger)
    postHandler := handler.NewPostHandler(postService, validator, logger)
    // ... other handlers

    // Setup router
    r := chi.NewRouter()

    // Middleware
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(custommw.Logger(logger))
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

            // Post routes
            r.Post("/posts", postHandler.CreatePost)
            r.Get("/posts/{postID}", postHandler.GetPost)
            r.Put("/posts/{postID}", postHandler.UpdatePost)
            r.Delete("/posts/{postID}", postHandler.DeletePost)
            r.Post("/posts/{postID}/like", postHandler.LikePost)
            r.Delete("/posts/{postID}/like", postHandler.UnlikePost)

            // Feed routes
            r.Get("/feed", feedHandler.GetFeed)
            r.Get("/timeline", feedHandler.GetTimeline)

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
```

---

### Junior → FAANG: Reading and Writing Main Application Entry Points

Junior engineers often skip reading `main.go` files because they seem like boilerplate. But the main function is where the entire dependency graph is wired together. Reading it teaches you how the application bootstraps, in what order dependencies initialize, and how graceful shutdown is handled.

The key habit: understand graceful shutdown before your first production incident. In Go, graceful shutdown listens for `SIGTERM` (sent by Kubernetes before terminating a pod), stops accepting new connections, waits for in-flight requests to complete, then exits. Without this, rolling deployments drop requests in flight. Know how `context.WithTimeout` and `http.Server.Shutdown` work together.

Entry-level interview habit: when asked to design an application, describe the initialization order explicitly. Config loads first (no external calls yet), then loggers, then database connections, then caches, then business logic services, then HTTP handlers. Each step depends on the previous. Getting this order wrong causes nil pointer panics at startup.

First-job mistake: hardcoding configuration in `main.go`. Externalize all configuration to environment variables or a config file, with defaults for local development. Use a config struct with validation so a missing required variable fails fast at startup with a clear error, not at runtime with a confusing nil dereference.

### Senior @ FAANG: Application Lifecycle and Startup Contract Design

At L6, the `main.go` and its initialization sequence represent a formal contract between the service and the platform infrastructure that runs it. Kubernetes expects services to become healthy within a defined startup probe timeout, serve traffic reliably while alive, and drain cleanly before termination. Each of these is a contract point with platform implications.

**Startup probe design.** Kubernetes startup probes determine when a container has finished initializing. A service that runs database migrations at startup before becoming ready must have a startup probe with a sufficient timeout. Migrations can take minutes for large tables. The startup probe timeout must be longer than the maximum expected migration time, or Kubernetes will kill and restart the pod repeatedly, creating a crash loop. Define the startup probe timeout based on empirical migration duration measurements, not guesses.

**Health check hierarchy.** Distinguish three health endpoints: `/health/live` (is the process alive and not deadlocked, used by liveness probe), `/health/ready` (can this instance serve traffic, includes dependency checks, used by readiness probe), and `/health/startup` (has initialization completed, used by startup probe). The liveness probe must be minimal: only check that the goroutine scheduler is running and no critical goroutines have panicked. Heavy dependency checks in the liveness probe cause the process to be killed and restarted when a dependency is temporarily unavailable, which is the wrong response. The readiness probe removes the pod from the load balancer rotation without killing it, which is the correct response to a dependency being unavailable.

**Dependency injection and testability.** The `main.go` function that constructs all dependencies via direct instantiation is not testable. At L6, you design the wiring to use dependency injection explicitly: every component receives its dependencies through constructor parameters, not global variables or package-level singletons. This makes each component testable in isolation with mock dependencies. The main function becomes a thin wiring layer that instantiates real implementations and passes them to constructors. When a new engineer joins the team, they can understand the entire dependency graph by reading `main.go`.

**Feature flag integration at initialization.** At FAANG, feature flags are not optional. Every significant behavior change is gated behind a flag that allows emergency disablement without a code deploy. Integrating the feature flag client into the main initialization sequence means the service can read flags from a centralized store (LaunchDarkly, Optimizely, or an internal system) at startup and on each request. Define which flags require a restart to take effect versus which are dynamically readable. Document this in the service README to prevent operators from assuming all flag changes take effect immediately.
