## 53.1 Go as Backend for SPAs

### CORS Configuration

Cross-Origin Resource Sharing (CORS) is a critical security boundary when Go serves as the backend for JavaScript SPAs hosted on a different origin. Properly configuring CORS headers, especially distinguishing between wildcard and credential-aware policies, prevents both overly permissive setups and frustrating browser-side failures. The middleware below exposes a configurable `CORSConfig` struct so teams can lock down allowed origins per environment without touching handler logic.

```go
// pkg/middleware/cors.go
package middleware

import (
	"fmt"
	"net/http"
	"strings"
)

// CORSConfig holds CORS configuration
type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	ExposedHeaders   []string
	AllowCredentials bool
	MaxAge           int // preflight cache in seconds
}

// DefaultCORSConfig returns sensible defaults
func DefaultCORSConfig() CORSConfig {
	return CORSConfig{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{
			"Accept",
			"Authorization",
			"Content-Type",
			"X-Requested-With",
			"X-Request-ID",
		},
		ExposedHeaders:   []string{"X-Request-ID", "X-Total-Count"},
		AllowCredentials: false,
		MaxAge:           86400, // 24 hours
	}
}

// ProductionCORSConfig for production with specific origins
func ProductionCORSConfig(origins []string) CORSConfig {
	return CORSConfig{
		AllowedOrigins: origins,
		AllowedMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{
			"Accept",
			"Authorization",
			"Content-Type",
			"X-Requested-With",
			"X-Request-ID",
		},
		ExposedHeaders:   []string{"X-Request-ID", "X-Total-Count"},
		AllowCredentials: true,
		MaxAge:           86400,
	}
}

// CORS creates CORS middleware
func CORS(config CORSConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			w.Header().Add("Vary", "Origin")

			// Check if origin is allowed
			allowed := false
			for _, o := range config.AllowedOrigins {
				if o == "*" || o == origin {
					allowed = true
					break
				}
				// Support wildcard subdomains: *.example.com
				if strings.HasPrefix(o, "*.") {
					suffix := o[1:] // .example.com
					if strings.HasSuffix(origin, suffix) {
						allowed = true
						break
					}
				}
			}

			if allowed {
				// Set CORS headers
				if config.AllowCredentials {
					// Can't use * with credentials
					w.Header().Set("Access-Control-Allow-Origin", origin)
				} else if len(config.AllowedOrigins) == 1 && config.AllowedOrigins[0] == "*" {
					w.Header().Set("Access-Control-Allow-Origin", "*")
				} else {
					w.Header().Set("Access-Control-Allow-Origin", origin)
				}

				w.Header().Set("Access-Control-Allow-Methods", strings.Join(config.AllowedMethods, ", "))
				w.Header().Set("Access-Control-Allow-Headers", strings.Join(config.AllowedHeaders, ", "))

				if len(config.ExposedHeaders) > 0 {
					w.Header().Set("Access-Control-Expose-Headers", strings.Join(config.ExposedHeaders, ", "))
				}

				if config.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}

				// Handle preflight
				if r.Method == "OPTIONS" {
					w.Header().Set("Access-Control-Max-Age", fmt.Sprintf("%d", config.MaxAge))
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Example usage with Chi router
func SetupRouter() *chi.Mux {
	r := chi.NewRouter()

	// Apply CORS middleware
	corsConfig := ProductionCORSConfig([]string{
		"https://app.example.com",
		"https://admin.example.com",
		"http://localhost:3000", // Development
	})
	r.Use(CORS(corsConfig))

	// Routes
	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/users", listUsers)
		r.Post("/users", createUser)
	})

	return r
}
```

### Static File Serving

Serving a compiled SPA from Go eliminates the need for a separate static CDN during development and simplifies single-binary deployments via `embed.FS`. The key challenge is SPA client-side routing: any path that doesn't resolve to an actual file must fall back to `index.html` so the frontend router can take over. The handler below implements that fallback logic alongside cache-control heuristics that give long-lived headers to content-hashed assets while keeping HTML always fresh.

```go
// pkg/server/static.go
package server

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// StaticConfig holds static file serving configuration
type StaticConfig struct {
	// Root directory for static files
	Root string
	// Index file for SPA routing
	Index string
	// Enable gzip compression
	Gzip bool
	// Cache-Control header value for static assets
	CacheControl string
	// Paths that should be handled by SPA router
	SPAPaths []string
}

// DefaultStaticConfig returns sensible defaults
func DefaultStaticConfig() StaticConfig {
	return StaticConfig{
		Root:         "./static",
		Index:        "index.html",
		Gzip:         true,
		CacheControl: "public, max-age=31536000", // 1 year for hashed assets
		SPAPaths:     []string{"/app", "/dashboard", "/settings"},
	}
}

// SPAHandler serves a single-page application
// It serves static files and falls back to index.html for SPA routes
func SPAHandler(config StaticConfig) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Clean the path
		path := filepath.Clean(r.URL.Path)

		// Check if this is an API route (should not be handled by SPA)
		if strings.HasPrefix(path, "/api") {
			http.NotFound(w, r)
			return
		}

		// Try to serve the file
		filePath := filepath.Join(config.Root, path)

		// Check if file exists
		info, err := os.Stat(filePath)
		if err == nil && !info.IsDir() {
			// File exists, serve it
			serveFileWithCaching(w, r, filePath, config)
			return
		}

		// Check if it's a directory with index.html
		if err == nil && info.IsDir() {
			indexPath := filepath.Join(filePath, config.Index)
			if _, err := os.Stat(indexPath); err == nil {
				serveFileWithCaching(w, r, indexPath, config)
				return
			}
		}

		// Check if this is an SPA route
		for _, spaPath := range config.SPAPaths {
			if strings.HasPrefix(path, spaPath) {
				// Serve index.html for SPA routes
				indexPath := filepath.Join(config.Root, config.Index)
				serveFileWithCaching(w, r, indexPath, config)
				return
			}
		}

		// For other paths, try to serve index.html (catch-all for SPA)
		// This allows any path to work with client-side routing
		indexPath := filepath.Join(config.Root, config.Index)
		if _, err := os.Stat(indexPath); err == nil {
			serveFileWithCaching(w, r, indexPath, config)
			return
		}

		http.NotFound(w, r)
	})
}

func serveFileWithCaching(w http.ResponseWriter, r *http.Request, filePath string, config StaticConfig) {
	// Set caching headers based on file type
	ext := filepath.Ext(filePath)

	switch ext {
	case ".html":
		// Don't cache HTML files
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	case ".js", ".css", ".woff", ".woff2", ".ttf", ".eot":
		// Cache hashed assets for a long time
		if containsHash(filePath) {
			w.Header().Set("Cache-Control", config.CacheControl)
		} else {
			w.Header().Set("Cache-Control", "public, max-age=86400") // 1 day
		}
	case ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp":
		// Cache images
		w.Header().Set("Cache-Control", "public, max-age=604800") // 1 week
	default:
		w.Header().Set("Cache-Control", "public, max-age=86400") // 1 day
	}

	http.ServeFile(w, r, filePath)
}

func containsHash(filename string) bool {
	// Check for common hash patterns like file.abc123.js
	base := filepath.Base(filename)
	parts := strings.Split(base, ".")
	if len(parts) >= 3 {
		// Check if second-to-last part looks like a hash
		potentialHash := parts[len(parts)-2]
		if len(potentialHash) >= 8 && isAlphanumeric(potentialHash) {
			return true
		}
	}
	return false
}

func isAlphanumeric(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

// Embedded static files (for single-binary deployment)
//
//go:embed static/*
var staticFS embed.FS

// EmbeddedSPAHandler serves embedded static files
func EmbeddedSPAHandler() http.Handler {
	// Get the static subdirectory
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		panic(err)
	}

	fileServer := http.FileServer(http.FS(staticContent))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the file
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}

		// Check if file exists in embedded FS
		if _, err := fs.Stat(staticContent, strings.TrimPrefix(path, "/")); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}

		// Serve index.html for SPA routing
		r.URL.Path = "/index.html"
		fileServer.ServeHTTP(w, r)
	})
}
```

### API Design for Frontend

A consistent JSON envelope (carrying `success`, `data`, `error`, and `meta` fields) makes frontend error handling predictable and prevents the ad-hoc response structures that accumulate when each handler invents its own format. Pagination metadata attached to list responses removes the need for a separate count endpoint and keeps clients in sync with server-side totals. The helpers below standardize this contract across every handler in the service.

```go
// pkg/api/response.go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Response is a standardized API response
type Response struct {
	Success bool        `json:"success"`
	Data    any `json:"data,omitempty"`
	Error   *ErrorInfo  `json:"error,omitempty"`
	Meta    *MetaInfo   `json:"meta,omitempty"`
}

// ErrorInfo provides error details
type ErrorInfo struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Details map[string]string `json:"details,omitempty"`
}

// MetaInfo provides pagination metadata
type MetaInfo struct {
	Page       int    `json:"page,omitempty"`
	PerPage    int    `json:"per_page,omitempty"`
	Total      int    `json:"total,omitempty"`
	TotalPages int    `json:"total_pages,omitempty"`
	HasMore    bool   `json:"has_more,omitempty"`
	NextCursor string `json:"next_cursor,omitempty"`
	PrevCursor string `json:"prev_cursor,omitempty"`
}

// JSON sends a JSON response
func JSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	response := Response{
		Success: status >= 200 && status < 300,
		Data:    data,
	}

	json.NewEncoder(w).Encode(response)
}

// JSONWithMeta sends a JSON response with pagination metadata
func JSONWithMeta(w http.ResponseWriter, status int, data any, meta *MetaInfo) {
	w.Header().Set("Content-Type", "application/json")

	// Set total count header before WriteHeader (headers must be set before writing status)
	if meta != nil && meta.Total > 0 {
		w.Header().Set("X-Total-Count", strconv.Itoa(meta.Total))
	}

	w.WriteHeader(status)

	response := Response{
		Success: true,
		Data:    data,
		Meta:    meta,
	}

	json.NewEncoder(w).Encode(response)
}

// Error sends an error response
func Error(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	response := Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    code,
			Message: message,
		},
	}

	json.NewEncoder(w).Encode(response)
}

// ValidationError sends a validation error response
func ValidationError(w http.ResponseWriter, errors map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)

	response := Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "VALIDATION_ERROR",
			Message: "Validation failed",
			Details: errors,
		},
	}

	json.NewEncoder(w).Encode(response)
}

// Common error codes
const (
	ErrCodeNotFound       = "NOT_FOUND"
	ErrCodeUnauthorized   = "UNAUTHORIZED"
	ErrCodeForbidden      = "FORBIDDEN"
	ErrCodeBadRequest     = "BAD_REQUEST"
	ErrCodeConflict       = "CONFLICT"
	ErrCodeInternal       = "INTERNAL_ERROR"
	ErrCodeValidation     = "VALIDATION_ERROR"
	ErrCodeRateLimit      = "RATE_LIMIT_EXCEEDED"
)

// Pagination helpers
type PaginationParams struct {
	Page    int
	PerPage int
	Cursor  string
	Sort    string
	Order   string // asc or desc
}

func ParsePaginationParams(r *http.Request) PaginationParams {
	params := PaginationParams{
		Page:    1,
		PerPage: 20,
		Order:   "desc",
	}

	if page := r.URL.Query().Get("page"); page != "" {
		if p, err := strconv.Atoi(page); err == nil && p > 0 {
			params.Page = p
		}
	}

	if perPage := r.URL.Query().Get("per_page"); perPage != "" {
		if pp, err := strconv.Atoi(perPage); err == nil && pp > 0 && pp <= 100 {
			params.PerPage = pp
		}
	}

	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params.Cursor = cursor
	}

	if sort := r.URL.Query().Get("sort"); sort != "" {
		params.Sort = sort
	}

	if order := r.URL.Query().Get("order"); order == "asc" || order == "desc" {
		params.Order = order
	}

	return params
}

// Example handler using the response helpers
func ListUsersHandler(w http.ResponseWriter, r *http.Request) {
	pagination := ParsePaginationParams(r)

	// Get users from database
	users, total, err := userService.List(r.Context(), pagination)
	if err != nil {
		Error(w, http.StatusInternalServerError, ErrCodeInternal, "Failed to fetch users")
		return
	}

	// Calculate pagination metadata
	totalPages := (total + pagination.PerPage - 1) / pagination.PerPage

	meta := &MetaInfo{
		Page:       pagination.Page,
		PerPage:    pagination.PerPage,
		Total:      total,
		TotalPages: totalPages,
		HasMore:    pagination.Page < totalPages,
	}

	JSONWithMeta(w, http.StatusOK, users, meta)
}
```

### Junior -> FAANG: First-Job Habits for SPA Backend Work

The three most common mistakes on a first fullstack Go project are: (1) putting the CORS middleware after other middleware in the chain so preflight OPTIONS requests hit auth checks and return 401 before CORS headers are written, (2) forgetting to set `Vary: Origin` on CORS responses so a CDN caches the response for origin A and serves it to origin B, and (3) using `no-store` on the SPA `index.html` when `no-cache` is the correct directive. `no-store` prevents the browser from storing the file at all, while `no-cache` allows storage but requires revalidation before use. For `index.html`, you want the browser to cache it but always revalidate so users do not get stale app shells.

For the response envelope pattern, the practical first-job habit is to write a single `respondJSON`, `respondError`, and `respondPaginated` function in a shared package on day one, before writing any handlers. Retrofitting a consistent envelope across 50 handlers later is painful and error-prone. Ask your tech lead whether the project has a response helper package before writing your first handler.

CORS preflight debugging workflow: open the browser Network tab, filter for the OPTIONS request matching your API endpoint, check the response headers. If there is no OPTIONS response at all, the middleware is not running or the route is not registered for OPTIONS. If the response is 401, auth middleware is running before CORS. If the response is 200 but the real request still fails, check whether the `Access-Control-Allow-Headers` list includes every header your JavaScript sets.

### Senior @ FAANG: CORS Policy, Envelope Governance, and CDN Architecture

**CORS as a security boundary, not middleware.** A well-designed CORS policy is a statement of which browser origins are trusted to act as agents of authenticated users. The `ProductionCORSConfig` pattern in this section hardcodes the allowlist in application code, which works for a single-service team. For a platform with dozens of services, the allowlist belongs in a central config store (environment variable set at deploy time, or pulled from a secrets manager). This prevents a developer from accidentally adding `localhost:3000` to the production allowlist when they forget to change a constant before pushing.

The `Vary: Origin` header is load-bearing for CDN correctness. Without it, a CDN with `Access-Control-Allow-Origin: https://app.example.com` in its cache will serve that cached response to any origin, including origins that should receive no CORS headers. The Vary header tells the CDN to cache a separate copy per unique `Origin` header value. At high-traffic scale with many origins, this can expand CDN cache size significantly. The mitigation is to place the CORS middleware at the origin server and configure the CDN to strip `Origin` from cache keys for non-credentialed requests, relying on CORS only for credentialed flows.

**Response envelope versioning.** The `Response` struct in this section has no version field. As the API evolves, the envelope may need to change: adding a `warnings` array for deprecation notices, adding a `tracing` block for distributed trace IDs, or restructuring `meta` pagination fields. Without versioning, any change is a breaking change for existing clients. The senior-level approach is to treat the envelope as a versioned contract. One practical implementation is including a `schema_version` field in the meta object that increments when the envelope shape changes. Clients that parse only `data` are unaffected by additions, but clients that serialize the full envelope (e.g., logging pipelines) can gate on `schema_version` to handle format changes gracefully.

**SPA serving and the CDN split.** The `EmbeddedSPAHandler` in this section is appropriate for development and small deployments. For production at scale, serving static assets from the Go binary wastes CPU on file I/O and network bandwidth that a CDN handles more efficiently. The correct architecture is a build pipeline that publishes content-hashed assets to a CDN origin (S3 + CloudFront, GCS + Cloud CDN, or Azure Blob + Azure CDN) and sets `Cache-Control: public, max-age=31536000, immutable` on upload. The Go server serves only `index.html` with `Cache-Control: no-cache` and the `<script src="https://cdn.example.com/main.abc123.js">` tags pointing to the CDN. This eliminates the Go server from the static asset serving path entirely and allows static assets to be deployed independently from the Go binary. The ADR question is whether the CDN domain is the same as the API domain (eliminating CORS for assets) or a separate domain (requiring CORS headers on asset responses, which is unusual but sometimes needed for font loading via `crossorigin="anonymous"`).

**Pagination strategy selection.** Cursor-based pagination (`next_cursor`, `prev_cursor`) is superior to offset pagination for any collection that is written to concurrently. Offset pagination suffers from the "shifting rows" problem: a row inserted between page 1 and page 2 requests causes page 2 to repeat a row from page 1. Cursor pagination encodes a stable sort position (typically the primary key or a `(created_at, id)` tuple) that is immune to insertions. The tradeoff is that cursor pagination does not support "jump to page N," which matters for some admin UIs. Define in your ADR whether the product requires arbitrary page access. If not, default to cursor pagination for all list endpoints and document this decision so future engineers do not regress to offset pagination without understanding the tradeoff.

---
