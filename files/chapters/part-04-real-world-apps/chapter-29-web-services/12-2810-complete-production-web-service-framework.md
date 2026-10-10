## 29.10 Complete Production Web Service Framework

This section assembles every pattern from the chapter into a single, working web service. The code is structured as a real project with configuration management, domain models, a middleware stack, route definitions, handlers, and deployment files.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
myapi/
├── cmd/
│   └── server/
│       └── main.go                 # Application entry point
├── internal/
│   ├── api/
│   │   ├── api.go                  # API server setup
│   │   ├── routes.go               # Route definitions
│   │   └── handlers/
│   │       ├── health.go           # Health check handlers
│   │       ├── users.go            # User handlers
│   │       └── response.go         # Response utilities
│   ├── config/
│   │   └── config.go               # Configuration management
│   ├── middleware/
│   │   ├── auth.go                 # Authentication middleware
│   │   ├── cors.go                 # CORS middleware
│   │   ├── logger.go               # Logging middleware
│   │   ├── ratelimit.go            # Rate limiting middleware
│   │   ├── recovery.go             # Panic recovery middleware
│   │   ├── requestid.go            # Request ID middleware
│   │   └── timeout.go              # Request timeout middleware
│   ├── domain/
│   │   ├── user.go                 # User domain model
│   │   └── errors.go               # Domain errors
│   ├── repository/
│   │   ├── repository.go           # Repository interface
│   │   ├── postgres/
│   │   │   └── user.go             # PostgreSQL user repository
│   │   └── memory/
│   │       └── user.go             # In-memory user repository
│   └── service/
│       └── user.go                 # User service
├── pkg/
│   ├── validator/
│   │   └── validator.go            # Input validation
│   └── jwt/
│       └── jwt.go                  # JWT utilities
├── migrations/
│   ├── 000001_create_users.up.sql
│   └── 000001_create_users.down.sql
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── go.mod
└── go.sum
```

### Configuration Management

Externalizing configuration through environment variables or a config server follows the Twelve-Factor App methodology and simplifies deployment across environments without rebuilding the binary. Structured configuration types with validation fail fast on startup if required values are absent.

```go
// internal/config/config.go
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	Redis    RedisConfig
	JWT      JWTConfig
	Logging  LoggingConfig
}

type ServerConfig struct {
	Host            string
	Port            int
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	IdleTimeout     time.Duration
	ShutdownTimeout time.Duration
	TLSCert         string
	TLSKey          string
}

type DatabaseConfig struct {
	Host            string
	Port            int
	User            string
	Password        string
	Name            string
	SSLMode         string
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
}

type RedisConfig struct {
	Host         string
	Port         int
	Password     string
	DB           int
	PoolSize     int
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

type JWTConfig struct {
	Secret           string
	AccessTokenTTL   time.Duration
	RefreshTokenTTL  time.Duration
	Issuer           string
}

type LoggingConfig struct {
	Level  string
	Format string // "json" or "text"
}

func Load() (*Config, error) {
	cfg := &Config{
		Server: ServerConfig{
			Host:            getEnv("SERVER_HOST", "0.0.0.0"),
			Port:            getEnvInt("SERVER_PORT", 8080),
			ReadTimeout:     getEnvDuration("SERVER_READ_TIMEOUT", 15*time.Second),
			WriteTimeout:    getEnvDuration("SERVER_WRITE_TIMEOUT", 15*time.Second),
			IdleTimeout:     getEnvDuration("SERVER_IDLE_TIMEOUT", 60*time.Second),
			ShutdownTimeout: getEnvDuration("SERVER_SHUTDOWN_TIMEOUT", 30*time.Second),
			TLSCert:         getEnv("TLS_CERT_FILE", ""),
			TLSKey:          getEnv("TLS_KEY_FILE", ""),
		},
		Database: DatabaseConfig{
			Host:            getEnv("DB_HOST", "localhost"),
			Port:            getEnvInt("DB_PORT", 5432),
			User:            getEnv("DB_USER", "postgres"),
			Password:        getEnv("DB_PASSWORD", ""),
			Name:            getEnv("DB_NAME", "myapi"),
			SSLMode:         getEnv("DB_SSLMODE", "disable"),
			MaxOpenConns:    getEnvInt("DB_MAX_OPEN_CONNS", 25),
			MaxIdleConns:    getEnvInt("DB_MAX_IDLE_CONNS", 5),
			ConnMaxLifetime: getEnvDuration("DB_CONN_MAX_LIFETIME", 5*time.Minute),
		},
		Redis: RedisConfig{
			Host:         getEnv("REDIS_HOST", "localhost"),
			Port:         getEnvInt("REDIS_PORT", 6379),
			Password:     getEnv("REDIS_PASSWORD", ""),
			DB:           getEnvInt("REDIS_DB", 0),
			PoolSize:     getEnvInt("REDIS_POOL_SIZE", 10),
			ReadTimeout:  getEnvDuration("REDIS_READ_TIMEOUT", 3*time.Second),
			WriteTimeout: getEnvDuration("REDIS_WRITE_TIMEOUT", 3*time.Second),
		},
		JWT: JWTConfig{
			Secret:          getEnv("JWT_SECRET", ""),
			AccessTokenTTL:  getEnvDuration("JWT_ACCESS_TOKEN_TTL", 15*time.Minute),
			RefreshTokenTTL: getEnvDuration("JWT_REFRESH_TOKEN_TTL", 7*24*time.Hour),
			Issuer:          getEnv("JWT_ISSUER", "myapi"),
		},
		Logging: LoggingConfig{
			Level:  getEnv("LOG_LEVEL", "info"),
			Format: getEnv("LOG_FORMAT", "json"),
		},
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

func (c *Config) Validate() error {
	if c.JWT.Secret == "" {
		return fmt.Errorf("JWT_SECRET is required")
	}
	if len(c.JWT.Secret) < 32 {
		return fmt.Errorf("JWT_SECRET must be at least 32 characters")
	}
	return nil
}

func (c *DatabaseConfig) DSN() string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		c.Host, c.Port, c.User, c.Password, c.Name, c.SSLMode,
	)
}

func (c *ServerConfig) Address() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if d, err := time.ParseDuration(value); err == nil {
			return d
		}
	}
	return defaultValue
}
```

### Domain Models and Errors

Domain models represent the core entities and value objects of the application. Keeping models free of framework annotations and database tags in the domain layer maintains a clean separation between business logic and infrastructure concerns.

```go
// internal/domain/user.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID           uuid.UUID `json:"id" db:"id"`
	Email        string    `json:"email" db:"email"`
	PasswordHash string    `json:"-" db:"password_hash"`
	Name         string    `json:"name" db:"name"`
	Role         Role      `json:"role" db:"role"`
	Status       Status    `json:"status" db:"status"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at"`
	DeletedAt    *time.Time `json:"-" db:"deleted_at"`
}

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

type Status string

const (
	StatusActive   Status = "active"
	StatusInactive Status = "inactive"
	StatusBanned   Status = "banned"
)

type CreateUserInput struct {
	Email    string `json:"email" validate:"required,email,max=255"`
	Password string `json:"password" validate:"required,min=8,max=72"`
	Name     string `json:"name" validate:"required,min=2,max=100"`
}

type UpdateUserInput struct {
	Email *string `json:"email,omitempty" validate:"omitempty,email,max=255"`
	Name  *string `json:"name,omitempty" validate:"omitempty,min=2,max=100"`
}

type UserFilter struct {
	Status *Status
	Role   *Role
	Search *string
}

type Pagination struct {
	Page    int `json:"page"`
	PerPage int `json:"per_page"`
}

func (p *Pagination) Offset() int {
	return (p.Page - 1) * p.PerPage
}

func (p *Pagination) Limit() int {
	return p.PerPage
}

type PagedResult[T any] struct {
	Data       []T `json:"data"`
	Page       int `json:"page"`
	PerPage    int `json:"per_page"`
	TotalItems int `json:"total_items"`
	TotalPages int `json:"total_pages"`
}

func NewPagedResult[T any](data []T, page, perPage, total int) PagedResult[T] {
	totalPages := (total + perPage - 1) / perPage
	return PagedResult[T]{
		Data:       data,
		Page:       page,
		PerPage:    perPage,
		TotalItems: total,
		TotalPages: totalPages,
	}
}
```

Domain errors define sentinel values for common failure cases and an `AppError` struct that carries an HTTP status code, a client-safe message, and optional details. Service and repository layers return these errors. The handler layer translates them into HTTP responses.

```go
// internal/domain/errors.go
package domain

import (
	"errors"
	"fmt"
	"net/http"
)

// Sentinel errors
var (
	ErrNotFound          = errors.New("resource not found")
	ErrConflict          = errors.New("resource already exists")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUnauthorized      = errors.New("unauthorized")
	ErrForbidden         = errors.New("forbidden")
	ErrValidation        = errors.New("validation error")
)

// AppError represents an application error with HTTP status
type AppError struct {
	Code       int                    `json:"-"`
	Message    string                 `json:"message"`
	Details    map[string]any `json:"details,omitempty"`
	Internal   error                  `json:"-"`
}

func (e *AppError) Error() string {
	if e.Internal != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Internal)
	}
	return e.Message
}

func (e *AppError) Unwrap() error {
	return e.Internal
}

func NewNotFoundError(resource string) *AppError {
	return &AppError{
		Code:    http.StatusNotFound,
		Message: fmt.Sprintf("%s not found", resource),
	}
}

func NewConflictError(message string) *AppError {
	return &AppError{
		Code:    http.StatusConflict,
		Message: message,
	}
}

func NewValidationError(details map[string]any) *AppError {
	return &AppError{
		Code:    http.StatusBadRequest,
		Message: "Validation failed",
		Details: details,
	}
}

func NewBadRequestError(message string) *AppError {
	return &AppError{
		Code:    http.StatusBadRequest,
		Message: message,
	}
}

func NewUnauthorizedError() *AppError {
	return &AppError{
		Code:    http.StatusUnauthorized,
		Message: "Unauthorized",
	}
}

func NewForbiddenError() *AppError {
	return &AppError{
		Code:    http.StatusForbidden,
		Message: "Forbidden",
	}
}

func NewInternalError(err error) *AppError {
	return &AppError{
		Code:     http.StatusInternalServerError,
		Message:  "Internal server error",
		Internal: err,
	}
}

func NewRateLimitError() *AppError {
	return &AppError{
		Code:    http.StatusTooManyRequests,
		Message: "Rate limit exceeded",
	}
}
```

### Middleware Stack

Each middleware is a standalone file that wraps an `http.Handler`. The request ID middleware assigns a UUID to every request for tracing. The logger records method, path, status, and duration. The recovery middleware catches panics so a single handler bug does not crash the entire server. Rate limiting and CORS round out the stack.

```go
// internal/middleware/requestid.go
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

type contextKey string

const RequestIDKey contextKey = "request_id"

const RequestIDHeader = "X-Request-ID"

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get(RequestIDHeader)
		if requestID == "" {
			requestID = uuid.New().String()
		}

		ctx := context.WithValue(r.Context(), RequestIDKey, requestID)
		w.Header().Set(RequestIDHeader, requestID)

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func GetRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(RequestIDKey).(string); ok {
		return id
	}
	return ""
}
```

The logger middleware wraps the `ResponseWriter` to capture the status code and response size, then logs a structured entry after the handler completes. It relies on the request ID already being set by the previous middleware in the chain.

```go
// internal/middleware/logger.go
package middleware

import (
	"log/slog"
	"net/http"
	"time"
)

type responseRecorder struct {
	http.ResponseWriter
	statusCode int
	size       int
}

func (r *responseRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.size += n
	return n, err
}

func Logger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			recorder := &responseRecorder{
				ResponseWriter: w,
				statusCode:     http.StatusOK,
			}

			next.ServeHTTP(recorder, r)

			duration := time.Since(start)
			requestID := GetRequestID(r.Context())

			logger.Info("http request",
				"request_id", requestID,
				"method", r.Method,
				"path", r.URL.Path,
				"query", r.URL.RawQuery,
				"status", recorder.statusCode,
				"size", recorder.size,
				"duration_ms", duration.Milliseconds(),
				"ip", r.RemoteAddr,
				"user_agent", r.UserAgent(),
			)
		})
	}
}
```

The recovery middleware catches panics from downstream handlers, logs the stack trace, and returns a 500 response instead of crashing the server process.

```go
// internal/middleware/recovery.go
package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"
)

func Recovery(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := recover(); err != nil {
					requestID := GetRequestID(r.Context())

					logger.Error("panic recovered",
						"request_id", requestID,
						"error", err,
						"stack", string(debug.Stack()),
						"path", r.URL.Path,
					)

					http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				}
			}()

			next.ServeHTTP(w, r)
		})
	}
}
```

The rate limiter tracks visitors by IP address using a token bucket per client. A background goroutine periodically cleans up stale entries to prevent unbounded memory growth.

```go
// internal/middleware/ratelimit.go
package middleware

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type RateLimiter struct {
	visitors map[string]*visitor
	mu       sync.RWMutex
	rate     rate.Limit
	burst    int
	cleanup  time.Duration
}

type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

func NewRateLimiter(rps float64, burst int) *RateLimiter {
	rl := &RateLimiter{
		visitors: make(map[string]*visitor),
		rate:     rate.Limit(rps),
		burst:    burst,
		cleanup:  3 * time.Minute,
	}
	go rl.cleanupVisitors()
	return rl
}

func (rl *RateLimiter) getVisitor(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	v, exists := rl.visitors[ip]
	if !exists {
		limiter := rate.NewLimiter(rl.rate, rl.burst)
		rl.visitors[ip] = &visitor{limiter: limiter, lastSeen: time.Now()}
		return limiter
	}

	v.lastSeen = time.Now()
	return v.limiter
}

func (rl *RateLimiter) cleanupVisitors() {
	ticker := time.NewTicker(time.Minute)
	for range ticker.C {
		rl.mu.Lock()
		for ip, v := range rl.visitors {
			if time.Since(v.lastSeen) > rl.cleanup {
				delete(rl.visitors, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *RateLimiter) Limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		limiter := rl.getVisitor(ip)

		if !limiter.Allow() {
			w.Header().Set("Retry-After", "60")
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func getClientIP(r *http.Request) string {
	// Check common proxy headers
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	return r.RemoteAddr
}
```

The authentication middleware extracts the JWT from the `Authorization` header, validates it, and stores the claims in the request context. `OptionalAuth` follows the same flow but does not reject requests missing a token, useful for endpoints that behave differently for logged-in versus anonymous users. `RequireRole` checks the authenticated user's role against a whitelist.

```go
// internal/middleware/auth.go
package middleware

import (
	"context"
	"net/http"
	"strings"

	"myapi/internal/domain"
	"myapi/pkg/jwt"
)

const UserContextKey contextKey = "user"

type AuthMiddleware struct {
	jwtService *jwt.Service
}

func NewAuthMiddleware(jwtService *jwt.Service) *AuthMiddleware {
	return &AuthMiddleware{jwtService: jwtService}
}

func (m *AuthMiddleware) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			http.Error(w, "Invalid authorization header format", http.StatusUnauthorized)
			return
		}

		claims, err := m.jwtService.ValidateAccessToken(parts[1])
		if err != nil {
			http.Error(w, "Invalid or expired token", http.StatusUnauthorized)
			return
		}

		ctx := context.WithValue(r.Context(), UserContextKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (m *AuthMiddleware) OptionalAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader != "" {
			parts := strings.Split(authHeader, " ")
			if len(parts) == 2 && strings.ToLower(parts[0]) == "bearer" {
				if claims, err := m.jwtService.ValidateAccessToken(parts[1]); err == nil {
					ctx := context.WithValue(r.Context(), UserContextKey, claims)
					r = r.WithContext(ctx)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (m *AuthMiddleware) RequireRole(roles ...domain.Role) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := GetUserClaims(r.Context())
			if claims == nil {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			hasRole := false
			for _, role := range roles {
				if claims.Role == role {
					hasRole = true
					break
				}
			}

			if !hasRole {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

func GetUserClaims(ctx context.Context) *jwt.Claims {
	if claims, ok := ctx.Value(UserContextKey).(*jwt.Claims); ok {
		return claims
	}
	return nil
}
```

The timeout middleware uses the standard library's `http.TimeoutHandler`, which safely handles the race between the handler goroutine and the timeout path writing to the same `ResponseWriter`.

```go
// internal/middleware/timeout.go
package middleware

import (
	"net/http"
	"time"
)

func Timeout(duration time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		// Use the stdlib TimeoutHandler which safely handles the data race
		// between the handler goroutine writing to ResponseWriter and the
		// timeout path writing the error response.
		return http.TimeoutHandler(next, duration, "Request Timeout")
	}
}
```

The CORS middleware handles preflight `OPTIONS` requests and sets the appropriate access control headers. The configuration struct lets you control allowed origins, methods, and headers per deployment environment.

```go
// internal/middleware/cors.go
package middleware

import (
	"fmt"
	"net/http"
	"strings"
)

type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	ExposedHeaders   []string
	AllowCredentials bool
	MaxAge           int
}

func DefaultCORSConfig() CORSConfig {
	return CORSConfig{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-Request-ID"},
		ExposedHeaders:   []string{"X-Request-ID"},
		AllowCredentials: false,
		MaxAge:           86400,
	}
}

func CORS(config CORSConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			// Check if origin is allowed
			allowed := false
			for _, o := range config.AllowedOrigins {
				if o == "*" || o == origin {
					allowed = true
					break
				}
			}

			if allowed && origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			}

			if config.AllowCredentials {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}

			// Handle preflight
			if r.Method == "OPTIONS" {
				w.Header().Set("Access-Control-Allow-Methods", strings.Join(config.AllowedMethods, ", "))
				w.Header().Set("Access-Control-Allow-Headers", strings.Join(config.AllowedHeaders, ", "))
				if config.MaxAge > 0 {
					w.Header().Set("Access-Control-Max-Age", fmt.Sprintf("%d", config.MaxAge))
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}

			if len(config.ExposedHeaders) > 0 {
				w.Header().Set("Access-Control-Expose-Headers", strings.Join(config.ExposedHeaders, ", "))
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

### API Server and Routes

The `Server` struct holds the configuration, logger, router, and service dependencies. Its constructor wires middleware and routes, then creates the underlying `http.Server` with the configured timeouts. Routes are split into public (registration, login) and protected groups, with admin-only endpoints nested inside a role-check middleware.

```go
// internal/api/api.go
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"myapi/internal/api/handlers"
	"myapi/internal/config"
	"myapi/internal/domain"
	"myapi/internal/middleware"
	"myapi/internal/service"
	"myapi/pkg/jwt"

	"github.com/go-chi/chi/v5"
)

type Server struct {
	config     *config.Config
	logger     *slog.Logger
	router     *chi.Mux
	httpServer *http.Server

	// Services
	userService *service.UserService
	jwtService  *jwt.Service
}

func NewServer(
	cfg *config.Config,
	logger *slog.Logger,
	userService *service.UserService,
	jwtService *jwt.Service,
) *Server {
	s := &Server{
		config:      cfg,
		logger:      logger,
		router:      chi.NewRouter(),
		userService: userService,
		jwtService:  jwtService,
	}

	s.setupMiddleware()
	s.setupRoutes()

	s.httpServer = &http.Server{
		Addr:           cfg.Server.Address(),
		Handler:        s.router,
		ReadTimeout:    cfg.Server.ReadTimeout,
		WriteTimeout:   cfg.Server.WriteTimeout,
		IdleTimeout:    cfg.Server.IdleTimeout,
		MaxHeaderBytes: 1 << 20, // 1MB
	}

	return s
}

func (s *Server) setupMiddleware() {
	// Rate limiter: 100 requests per second with burst of 200
	rateLimiter := middleware.NewRateLimiter(100, 200)

	// Global middleware stack (order matters!)
	s.router.Use(middleware.Recovery(s.logger))
	s.router.Use(middleware.RequestID)
	s.router.Use(middleware.Logger(s.logger))
	s.router.Use(middleware.CORS(middleware.DefaultCORSConfig()))
	s.router.Use(rateLimiter.Limit)
}

func (s *Server) setupRoutes() {
	authMiddleware := middleware.NewAuthMiddleware(s.jwtService)

	// Health endpoints (no auth)
	healthHandler := handlers.NewHealthHandler()
	s.router.Get("/health", healthHandler.Health)
	s.router.Get("/ready", healthHandler.Ready)

	// API v1
	s.router.Route("/api/v1", func(r chi.Router) {
		// Public routes
		r.Group(func(r chi.Router) {
			authHandler := handlers.NewAuthHandler(s.userService, s.jwtService, s.logger)
			r.Post("/auth/register", authHandler.Register)
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/refresh", authHandler.RefreshToken)
		})

		// Protected routes
		r.Group(func(r chi.Router) {
			r.Use(authMiddleware.Authenticate)
			r.Use(middleware.Timeout(30 * time.Second))

			userHandler := handlers.NewUserHandler(s.userService, s.logger)
			r.Get("/users/me", userHandler.GetCurrentUser)
			r.Put("/users/me", userHandler.UpdateCurrentUser)
			r.Delete("/users/me", userHandler.DeleteCurrentUser)

			// Admin only routes
			r.Group(func(r chi.Router) {
				r.Use(authMiddleware.RequireRole(domain.RoleAdmin))
				r.Get("/users", userHandler.ListUsers)
				r.Get("/users/{id}", userHandler.GetUser)
				r.Put("/users/{id}", userHandler.UpdateUser)
				r.Delete("/users/{id}", userHandler.DeleteUser)
			})
		})
	})

	// 404 handler
	s.router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		handlers.RespondError(w, http.StatusNotFound, "Resource not found")
	})

	// 405 handler
	s.router.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		handlers.RespondError(w, http.StatusMethodNotAllowed, "Method not allowed")
	})
}

func (s *Server) Start() error {
	s.logger.Info("starting server",
		"address", s.config.Server.Address(),
		"tls", s.config.Server.TLSCert != "",
	)

	if s.config.Server.TLSCert != "" && s.config.Server.TLSKey != "" {
		return s.httpServer.ListenAndServeTLS(
			s.config.Server.TLSCert,
			s.config.Server.TLSKey,
		)
	}

	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("shutting down server")
	return s.httpServer.Shutdown(ctx)
}

func (s *Server) Router() http.Handler {
	return s.router
}
```

### Handlers

Handlers follow a consistent pattern: parse the request, validate input, call the service layer, and write the response using shared helpers. The `HandleError` function maps `AppError` types to appropriate HTTP status codes, while `RespondJSON` and `RespondSuccess` enforce a uniform response envelope.

```go
// internal/api/handlers/response.go
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"myapi/internal/domain"
)

type ErrorResponse struct {
	Error   string                 `json:"error"`
	Details map[string]any `json:"details,omitempty"`
}

type SuccessResponse struct {
	Data    any `json:"data,omitempty"`
	Message string      `json:"message,omitempty"`
}

func RespondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		json.NewEncoder(w).Encode(data)
	}
}

func RespondError(w http.ResponseWriter, status int, message string) {
	RespondJSON(w, status, ErrorResponse{Error: message})
}

func RespondErrorWithDetails(w http.ResponseWriter, status int, message string, details map[string]any) {
	RespondJSON(w, status, ErrorResponse{Error: message, Details: details})
}

func RespondSuccess(w http.ResponseWriter, status int, data any) {
	RespondJSON(w, status, SuccessResponse{Data: data})
}

func RespondMessage(w http.ResponseWriter, status int, message string) {
	RespondJSON(w, status, SuccessResponse{Message: message})
}

func RespondNoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

func HandleError(w http.ResponseWriter, err error) {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		if appErr.Details != nil {
			RespondErrorWithDetails(w, appErr.Code, appErr.Message, appErr.Details)
		} else {
			RespondError(w, appErr.Code, appErr.Message)
		}
		return
	}

	// Unknown error - return generic message
	RespondError(w, http.StatusInternalServerError, "Internal server error")
}
```

Health check endpoints report server status to load balancers and orchestrators. The liveness check (`/health`) returns 200 if the process is running. The readiness check (`/ready`) verifies downstream dependencies and reports degraded status if any check fails.

```go
// internal/api/handlers/health.go
package handlers

import (
	"net/http"
	"runtime"
	"time"
)

var startTime = time.Now()

type HealthHandler struct{}

func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

type HealthResponse struct {
	Status    string `json:"status"`
	Timestamp string `json:"timestamp"`
}

type ReadyResponse struct {
	Status     string        `json:"status"`
	Uptime     string        `json:"uptime"`
	GoVersion  string        `json:"go_version"`
	NumCPU     int           `json:"num_cpu"`
	Goroutines int           `json:"goroutines"`
	Checks     []CheckResult `json:"checks"`
}

type CheckResult struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (h *HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	RespondJSON(w, http.StatusOK, HealthResponse{
		Status:    "ok",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

func (h *HealthHandler) Ready(w http.ResponseWriter, r *http.Request) {
	// Perform readiness checks
	checks := []CheckResult{
		{Name: "database", Status: "ok"},
		{Name: "redis", Status: "ok"},
	}

	allOK := true
	for _, check := range checks {
		if check.Status != "ok" {
			allOK = false
			break
		}
	}

	response := ReadyResponse{
		Status:     "ok",
		Uptime:     time.Since(startTime).String(),
		GoVersion:  runtime.Version(),
		NumCPU:     runtime.NumCPU(),
		Goroutines: runtime.NumGoroutine(),
		Checks:     checks,
	}

	if !allOK {
		response.Status = "degraded"
		RespondJSON(w, http.StatusServiceUnavailable, response)
		return
	}

	RespondJSON(w, http.StatusOK, response)
}
```

The user handler implements CRUD operations. Current-user endpoints extract the user ID from JWT claims in the context. Admin endpoints parse the user ID from the URL path. Both share the same service and validation logic.

```go
// internal/api/handlers/user.go
package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"myapi/internal/domain"
	"myapi/internal/middleware"
	"myapi/internal/service"
	"myapi/pkg/validator"
)

type UserHandler struct {
	service  *service.UserService
	logger   *slog.Logger
	validate *validator.Validator
}

func NewUserHandler(service *service.UserService, logger *slog.Logger) *UserHandler {
	return &UserHandler{
		service:  service,
		logger:   logger,
		validate: validator.New(),
	}
}

func (h *UserHandler) GetCurrentUser(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetUserClaims(r.Context())
	if claims == nil {
		RespondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	user, err := h.service.GetByID(r.Context(), claims.UserID)
	if err != nil {
		HandleError(w, err)
		return
	}

	RespondSuccess(w, http.StatusOK, user)
}

func (h *UserHandler) UpdateCurrentUser(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetUserClaims(r.Context())
	if claims == nil {
		RespondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	var input domain.UpdateUserInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if err := h.validate.Struct(input); err != nil {
		RespondErrorWithDetails(w, http.StatusBadRequest, "Validation failed",
			map[string]any{"errors": h.validate.FormatErrors(err)})
		return
	}

	user, err := h.service.Update(r.Context(), claims.UserID, input)
	if err != nil {
		HandleError(w, err)
		return
	}

	RespondSuccess(w, http.StatusOK, user)
}

func (h *UserHandler) DeleteCurrentUser(w http.ResponseWriter, r *http.Request) {
	claims := middleware.GetUserClaims(r.Context())
	if claims == nil {
		RespondError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	if err := h.service.Delete(r.Context(), claims.UserID); err != nil {
		HandleError(w, err)
		return
	}

	RespondNoContent(w)
}

func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	page := parseQueryInt(r, "page", 1)
	perPage := parseQueryInt(r, "per_page", 20)

	if perPage > 100 {
		perPage = 100
	}

	pagination := domain.Pagination{Page: page, PerPage: perPage}

	filter := domain.UserFilter{}
	if status := r.URL.Query().Get("status"); status != "" {
		s := domain.Status(status)
		filter.Status = &s
	}
	if search := r.URL.Query().Get("search"); search != "" {
		filter.Search = &search
	}

	result, err := h.service.List(r.Context(), filter, pagination)
	if err != nil {
		HandleError(w, err)
		return
	}

	RespondJSON(w, http.StatusOK, result)
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	user, err := h.service.GetByID(r.Context(), id)
	if err != nil {
		HandleError(w, err)
		return
	}

	RespondSuccess(w, http.StatusOK, user)
}

func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	var input domain.UpdateUserInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid JSON")
		return
	}

	if err := h.validate.Struct(input); err != nil {
		RespondErrorWithDetails(w, http.StatusBadRequest, "Validation failed",
			map[string]any{"errors": h.validate.FormatErrors(err)})
		return
	}

	user, err := h.service.Update(r.Context(), id, input)
	if err != nil {
		HandleError(w, err)
		return
	}

	RespondSuccess(w, http.StatusOK, user)
}

func (h *UserHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		RespondError(w, http.StatusBadRequest, "Invalid user ID")
		return
	}

	if err := h.service.Delete(r.Context(), id); err != nil {
		HandleError(w, err)
		return
	}

	RespondNoContent(w)
}

func parseQueryInt(r *http.Request, key string, defaultValue int) int {
	val := r.URL.Query().Get(key)
	if val == "" {
		return defaultValue
	}
	if i, err := strconv.Atoi(val); err == nil && i > 0 {
		return i
	}
	return defaultValue
}
```

### Main Application

The `main` function is the composition root: it loads configuration, connects to the database, creates repositories and services, and passes them into the API server. The server runs in a goroutine while the main goroutine blocks on OS signals. On SIGINT or SIGTERM, it calls `Shutdown` with a deadline to drain in-flight requests before exiting.

```go
// cmd/server/main.go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"myapi/internal/api"
	"myapi/internal/config"
	"myapi/internal/repository/postgres"
	"myapi/internal/service"
	"myapi/pkg/jwt"
)

func main() {
	// Initialize logger
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		logger.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	// Initialize database
	db, err := postgres.Connect(cfg.Database)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Initialize repositories
	userRepo := postgres.NewUserRepository(db)

	// Initialize services
	jwtService := jwt.NewService(cfg.JWT)
	userService := service.NewUserService(userRepo, logger)

	// Initialize API server
	server := api.NewServer(cfg, logger, userService, jwtService)

	// Start server in goroutine
	go func() {
		if err := server.Start(); err != nil {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	logger.Info("server started", "address", cfg.Server.Address())

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("shutting down server...")

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		logger.Error("server shutdown error", "error", err)
		os.Exit(1)
	}

	logger.Info("server stopped")
}
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s -X main.version=$(git describe --tags --always)" \
    -o /app/server \
    ./cmd/server

# Final stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

# Create non-root user
RUN addgroup -g 1000 app && \
    adduser -u 1000 -G app -s /bin/sh -D app

WORKDIR /app

# Copy binary
COPY --from=builder /app/server .

# Set ownership
RUN chown -R app:app /app

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENTRYPOINT ["./server"]
```

### Docker Compose

Docker Compose defines the full development stack: the Go API service, PostgreSQL, and Redis. Health checks on the database and cache containers ensure the API service starts only after its dependencies are ready. The `migrate` service runs schema migrations automatically on startup.

```yaml
# docker-compose.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - SERVER_HOST=0.0.0.0
      - SERVER_PORT=8080
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - DB_NAME=myapi
      - REDIS_HOST=redis
      - REDIS_PORT=6379
      - JWT_SECRET=your-super-secret-jwt-key-at-least-32-chars
      - LOG_LEVEL=info
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - backend

  postgres:
    image: postgres:18-alpine
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=myapi
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - backend

  redis:
    image: redis:8-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
    networks:
      - backend

  migrate:
    image: migrate/migrate:v4.19.1
    volumes:
      - ./migrations:/migrations
    command: ["-path", "/migrations", "-database", "postgres://postgres:postgres@postgres:5432/myapi?sslmode=disable", "up"]
    depends_on:
      postgres:
        condition: service_healthy
    networks:
      - backend

volumes:
  postgres_data:
  redis_data:

networks:
  backend:
    driver: bridge
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
# Makefile
.PHONY: all build run test lint clean docker-build docker-up docker-down migrate

# Variables
BINARY_NAME=server
VERSION=$(shell git describe --tags --always --dirty)
BUILD_TIME=$(shell date -u +"%Y-%m-%dT%H:%M:%SZ")
LDFLAGS=-ldflags "-w -s -X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}"

# Go commands
GOCMD=go
GOBUILD=$(GOCMD) build
GOTEST=$(GOCMD) test
GOMOD=$(GOCMD) mod
GOLINT=golangci-lint

all: lint test build

build:
	$(GOBUILD) $(LDFLAGS) -o bin/$(BINARY_NAME) ./cmd/server

run:
	$(GOCMD) run ./cmd/server

test:
	$(GOTEST) -v -race -coverprofile=coverage.out ./...

test-coverage: test
	$(GOCMD) tool cover -html=coverage.out -o coverage.html

lint:
	$(GOLINT) run ./...

clean:
	rm -rf bin/
	rm -f coverage.out coverage.html

# Docker commands
docker-build:
	docker build -t myapi:latest .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f api

# Database commands
migrate-up:
	migrate -path migrations -database "postgres://postgres:postgres@localhost:5432/myapi?sslmode=disable" up

migrate-down:
	migrate -path migrations -database "postgres://postgres:postgres@localhost:5432/myapi?sslmode=disable" down 1

migrate-create:
	@read -p "Migration name: " name; \
	migrate create -ext sql -dir migrations -seq $$name

# Development
dev:
	air -c .air.toml

install-tools:
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	go install github.com/air-verse/air@latest
	go install -tags 'postgres' github.com/golang-migrate/migrate/v4/cmd/migrate@latest

# API testing
api-health:
	curl -s http://localhost:8080/health | jq

api-ready:
	curl -s http://localhost:8080/ready | jq
```

### Junior to FAANG: Reading the Full Skeleton

The structure above looks intimidating on first read. Parse it in layers. Layer one, the directory tree, each folder is a bounded responsibility. Layer two, the config struct, every external dependency becomes a field. Layer three, the middleware chain, five wrappers around the router. Layer four, routes grouped by auth level. Layer five, handlers that decode, validate, call service, encode. Layer six, main wires it together. If you can sketch this on a whiteboard without looking, you can explain any Go web service architecture in an interview.

Practice exercise. Clone this into a repo, add one new endpoint `/api/v1/posts` with Create, Get, Update, Delete. Write tests for each. This one exercise teaches more than reading ten tutorials.

Common traps for new engineers. First, putting business logic in handlers (keep it in the service layer). Second, logging secrets (the JWT secret ends up in a startup log because someone prints the whole config struct). Third, exposing `/debug/pprof` on the main port (admin port only). Fourth, returning `err.Error()` for unknown errors (generic message, log the details). The skeleton above avoids all four by design.

### Senior at FAANG: The Skeleton as Org Starter Template

Publish this as `platform/service-template` with one `make bootstrap NAME=myservice` command that scaffolds a new service from the template. Every new service in the org starts here. Drift from the template is visible and correctable.

Template maintenance as a platform. The template is versioned. Services pull updates via a codemod (`platform-sync`). Breaking changes in the template go through the same review as any platform change. Deprecated patterns get flagged in CI scans of every service repo.

Production hardening deltas to apply. First, swap the in-memory rate limiter for Redis-backed. Second, replace the `{"error": "..."}` envelope with RFC 7807 problem+json. Third, wire OTEL around the router, propagate `traceparent` end to end. Third, split metrics and healthz onto an admin listener on a separate port. Fourth, integrate the auth middleware with the org's JWKS rotation service, ban HS256 for service tokens. Fifth, use `slog.Handler` from the platform library that adds org-standard fields (service, version, region, cluster, trace_id).

Dockerfile deltas for FAANG production. Switch base image to distroless (`gcr.io/distroless/static-debian12`). Run as non-root (UID 65532). Sign the image with cosign. Pin digest, not tag. Scan with Trivy or Snyk in CI. Embed SBOM via `syft`. Add `--no-cache-dir` for Alpine where used. Avoid `latest` tags anywhere.

docker-compose vs kustomize vs helm. docker-compose is fine for local dev, insufficient for prod. Production manifests are Kubernetes via kustomize overlays or Helm charts, owned by a platform team, generated from a service descriptor. The template should include both (`deploy/local/docker-compose.yml`, `deploy/prod/kustomize/`) so developers never hand-write prod YAML.

Health and readiness semantics. Liveness (`/healthz`) returns 200 if the process can answer HTTP. No dependency checks. Readiness (`/readyz`) checks dependencies (DB, cache, config). During shutdown, readiness flips to 503 immediately while liveness stays 200 so k8s does not kill the pod mid-drain. This is codified in the platform library.

Configuration hierarchy. Flags over env over config file over defaults. Secrets via external secret manager (Vault, AWS Secrets Manager, GCP Secret Manager), injected at startup via a sidecar or CSI driver. Never in env vars long-term (leaks via `/proc/pid/environ`). The template uses env vars for convenience, production services swap for the org secret-manager integration.

Observability wiring. OTEL tracing around the router (inside recovery, outside logging). Prometheus metrics on `/metrics` on the admin port. slog JSON handler with trace_id injection. Structured panics emitted as errors plus a counter. Four lines in the template, saves weeks of retrofit later.

Database layer deltas. Replace the direct `postgres.Connect` with `pgxpool` (pgx v5). Connection lifetime aligned with rotation schedule (5 minutes for frequent rotation, 1 hour for rare). Prepared-statement cache enabled. Per-query tracing via `pgx.QueryTracer`. Read replica routing through a context tag. Migrations via `goose` or `golang-migrate`, run as a one-shot job not on service startup (startup migrations cause deploy deadlocks when pods race).

Service-layer patterns to promote at scale. Transactional outbox for at-least-once delivery. Idempotent handlers for retriable operations. Saga patterns for distributed transactions. Circuit breakers around every outbound call. Publish these as named patterns in the platform handbook, each with a reference implementation.

Capacity and cost. The template pod defaults to 100m CPU request, 256Mi memory. Measure actual usage after launch and right-size. Every FAANG I know of spends 20 to 40 percent more on compute than necessary because teams never revisit the defaults. Platform teams publish a "right-sizing" dashboard and chase teams quarterly.

Staff archetype. The Service Template Owner runs the template, reviews every breaking change, publishes the migration codemods, and maintains the per-service drift report. One of the most impactful roles per headcount in a platform org.

Multi-year roadmap. Year 1, publish template, onboard 10 percent of new services. Year 2, mandatory for new services, codemod existing fleet. Year 3, service-descriptor-driven generation (developer writes a YAML spec, scaffolding generates 90 percent of the code). Year 4, re-evaluate against state of Go (1.28, 1.29), refactor for any new stdlib features.

---
