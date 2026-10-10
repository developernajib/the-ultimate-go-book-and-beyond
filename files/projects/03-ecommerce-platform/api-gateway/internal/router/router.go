package router

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/api-gateway/internal/handlers"
	"github.com/example/ecommerce-platform/api-gateway/internal/middleware"
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
