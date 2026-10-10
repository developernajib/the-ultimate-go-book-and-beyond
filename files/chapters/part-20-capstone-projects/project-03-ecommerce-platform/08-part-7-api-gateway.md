## Part 7: API Gateway

The API Gateway provides a unified REST API for clients and routes requests to backend gRPC services. Instead of exposing each microservice's gRPC endpoint directly to the outside world, the gateway acts as a single entry point that translates REST requests into gRPC calls. This simplifies client development because frontend and mobile applications only need to know about one HTTP API rather than multiple gRPC services. The gateway also handles cross-cutting concerns like authentication, rate limiting, and request aggregation in one place.

### 7.1 API Gateway Implementation

**api-gateway/internal/router/router.go**

```go
package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/api-gateway/internal/handlers"
	"github.com/yourusername/ecommerce/api-gateway/internal/middleware"
)

// NewRouter creates a new HTTP router
func NewRouter(
	productHandler *handlers.ProductHandler,
	cartHandler *handlers.CartHandler,
	orderHandler *handlers.OrderHandler,
	paymentHandler *handlers.PaymentHandler,
	logger *zap.Logger,
) *chi.Mux {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.Logging(logger))
	r.Use(middleware.CORS())
	r.Use(middleware.RequestID())

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy"}`))
	})

	// API routes
	r.Route("/api/v1", func(api chi.Router) {
		// Products
		api.Get("/products", productHandler.ListProducts)
		api.Get("/products/{id}", productHandler.GetProduct)
		api.Get("/products/search", productHandler.SearchProducts)

		// Cart (requires authentication)
		api.Route("/cart", func(cart chi.Router) {
			cart.Use(middleware.Authentication())
			cart.Get("/", cartHandler.GetCart)
			cart.Post("/items", cartHandler.AddItem)
			cart.Put("/items/{id}", cartHandler.UpdateItem)
			cart.Delete("/items/{id}", cartHandler.RemoveItem)
			cart.Post("/clear", cartHandler.ClearCart)
		})

		// Orders (requires authentication)
		api.Route("/orders", func(orders chi.Router) {
			orders.Use(middleware.Authentication())
			orders.Post("/", orderHandler.CreateOrder)
			orders.Get("/", orderHandler.ListOrders)
			orders.Get("/{id}", orderHandler.GetOrder)
			orders.Post("/{id}/cancel", orderHandler.CancelOrder)
		})

		// Payments
		api.Post("/payments/webhook", paymentHandler.HandleWebhook)
	})

	return r
}
```

**api-gateway/internal/handlers/product_handler.go**

```go
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/api-gateway/internal/clients"
)

// ProductHandler handles product-related requests
type ProductHandler struct {
	productClient *clients.ProductClient
	logger        *zap.Logger
}

// NewProductHandler creates a new ProductHandler
func NewProductHandler(productClient *clients.ProductClient, logger *zap.Logger) *ProductHandler {
	return &ProductHandler{
		productClient: productClient,
		logger:        logger,
	}
}

// ListProducts lists products
func (h *ProductHandler) ListProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Parse query parameters
	query := r.URL.Query()
	page := parseIntParam(query.Get("page"), 1)
	pageSize := parseIntParam(query.Get("page_size"), 20)
	searchQuery := query.Get("q")

	// Call product service
	products, total, err := h.productClient.ListProducts(ctx, searchQuery, page, pageSize)
	if err != nil {
		h.logger.Error("failed to list products", zap.Error(err))
		respondError(w, http.StatusInternalServerError, "failed to list products")
		return
	}

	// Prepare response
	response := map[string]any{
		"products": products,
		"pagination": map[string]any{
			"page":        page,
			"page_size":   pageSize,
			"total":       total,
			"total_pages": (total + pageSize - 1) / pageSize,
		},
	}

	respondJSON(w, http.StatusOK, response)
}

// GetProduct gets a product by ID
func (h *ProductHandler) GetProduct(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Parse product ID
	productID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid product ID")
		return
	}

	// Call product service
	product, err := h.productClient.GetProduct(ctx, productID)
	if err != nil {
		h.logger.Error("failed to get product", zap.Error(err))
		respondError(w, http.StatusNotFound, "product not found")
		return
	}

	respondJSON(w, http.StatusOK, product)
}

// SearchProducts searches products using Elasticsearch
func (h *ProductHandler) SearchProducts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// Parse query parameters
	query := r.URL.Query()
	searchQuery := query.Get("q")
	if searchQuery == "" {
		respondError(w, http.StatusBadRequest, "search query is required")
		return
	}

	page := parseIntParam(query.Get("page"), 1)
	pageSize := parseIntParam(query.Get("page_size"), 20)

	// Call search service (Elasticsearch)
	products, total, err := h.productClient.SearchProducts(ctx, searchQuery, page, pageSize)
	if err != nil {
		h.logger.Error("failed to search products", zap.Error(err))
		respondError(w, http.StatusInternalServerError, "failed to search products")
		return
	}

	// Prepare response
	response := map[string]any{
		"products": products,
		"pagination": map[string]any{
			"page":        page,
			"page_size":   pageSize,
			"total":       total,
			"total_pages": (total + pageSize - 1) / pageSize,
		},
	}

	respondJSON(w, http.StatusOK, response)
}

// Helper functions

func respondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

func parseIntParam(param string, defaultValue int) int {
	if param == "" {
		return defaultValue
	}
	var value int
	if _, err := fmt.Sscanf(param, "%d", &value); err != nil {
		return defaultValue
	}
	return value
}
```

### 7.2 Middleware

**api-gateway/internal/middleware/auth.go**

```go
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

type contextKey string

const (
	userIDKey contextKey = "user_id"
)

// Authentication middleware
func Authentication() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				http.Error(w, "missing authorization header", http.StatusUnauthorized)
				return
			}

			// Extract token
			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				http.Error(w, "invalid authorization header", http.StatusUnauthorized)
				return
			}

			token := parts[1]

			// Validate token and get user ID
			// In production, this would validate JWT or call auth service
			userID, err := validateToken(token)
			if err != nil {
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}

			// Add user ID to context
			ctx := context.WithValue(r.Context(), userIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUserID gets the user ID from context
func GetUserID(ctx context.Context) (uuid.UUID, bool) {
	userID, ok := ctx.Value(userIDKey).(uuid.UUID)
	return userID, ok
}

func validateToken(token string) (uuid.UUID, error) {
	// Simplified - in production, validate JWT or call auth service
	return uuid.Parse(token)
}
```

**api-gateway/internal/middleware/logging.go**

```go
package middleware

import (
	"net/http"
	"time"

	"go.uber.org/zap"
)

// Logging middleware
func Logging(logger *zap.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Wrap response writer to capture status code
			wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(wrapped, r)

			duration := time.Since(start)

			logger.Info("http request",
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", wrapped.statusCode),
				zap.Duration("duration", duration),
				zap.String("remote_addr", r.RemoteAddr),
			)
		})
	}
}

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}
```

**api-gateway/internal/middleware/cors.go**

```go
package middleware

import (
	"net/http"
)

// CORS middleware
func CORS() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

**api-gateway/internal/middleware/request_id.go**

```go
package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

type requestIDKey string

const requestIDKeyValue requestIDKey = "request_id"

// RequestID middleware
func RequestID() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get or generate request ID
			requestID := r.Header.Get("X-Request-ID")
			if requestID == "" {
				requestID = uuid.New().String()
			}

			// Add to response header
			w.Header().Set("X-Request-ID", requestID)

			// Add to context
			ctx := context.WithValue(r.Context(), requestIDKeyValue, requestID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetRequestID gets the request ID from context
func GetRequestID(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDKeyValue).(string)
	return requestID
}
```

---

### Junior → FAANG: API Gateway as the Entry Point Pattern

An API gateway is the standard entry point for a microservices system. It performs three functions: protocol translation (REST to gRPC), cross-cutting concern enforcement (authentication, rate limiting, logging), and request aggregation (combining data from multiple services into a single response).

For interviews, describe the API gateway as the single surface that external clients interact with. Internal services use gRPC because it is efficient and strongly typed. External clients use REST because it is accessible from any language without protobuf tooling. The gateway bridges these two worlds.

The authentication model in the gateway determines the trust model for internal services. If the gateway validates JWTs and passes the user identity to downstream services in a trusted header (`X-User-ID`), internal services do not need to re-validate tokens. This simplifies internal services but requires that the gateway is never bypassed. If internal services are accessible outside the gateway, the security model breaks.

### Senior @ FAANG: API Gateway as a Platform Product

At senior level, the API gateway is not a single service. It is a platform that product teams configure to expose their services. The platform team owns the gateway infrastructure. Product teams own the route configurations that direct traffic to their services.

Gateway configuration as code (routes defined in version-controlled YAML or protobuf, not in a database) makes changes auditable and reversible. A route configuration that causes a 100% error rate on a specific endpoint can be reverted in seconds if it is stored in git and deployed via CI/CD.

Traffic shaping at the gateway level (canary routing, A/B testing, header-based routing) enables gradual service migrations without client-side changes. When migrating from Order Service v1 to v2, route 10% of traffic to v2, monitor error rates and latency, then gradually increase to 100%. The gateway is the natural implementation point for this routing logic.

Rate limiting at the gateway versus at the service level is an architectural decision. Gateway-level rate limiting protects all internal services with a single configuration. Service-level rate limiting allows per-service customization. The combination (gateway enforces global limits, services enforce per-endpoint limits) is the production standard. Document which layer enforces which limit and how they interact.

---
