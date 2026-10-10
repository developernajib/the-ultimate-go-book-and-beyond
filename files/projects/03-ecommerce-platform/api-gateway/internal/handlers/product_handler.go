package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/example/ecommerce-platform/api-gateway/internal/clients"
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

	query := r.URL.Query()
	page := parseIntParam(query.Get("page"), 1)
	pageSize := parseIntParam(query.Get("page_size"), 20)
	searchQuery := query.Get("q")

	products, total, err := h.productClient.ListProducts(ctx, searchQuery, page, pageSize)
	if err != nil {
		h.logger.Error("failed to list products", zap.Error(err))
		respondError(w, http.StatusInternalServerError, "failed to list products")
		return
	}

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

	productID, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid product ID")
		return
	}

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

	query := r.URL.Query()
	searchQuery := query.Get("q")
	if searchQuery == "" {
		respondError(w, http.StatusBadRequest, "search query is required")
		return
	}

	page := parseIntParam(query.Get("page"), 1)
	pageSize := parseIntParam(query.Get("page_size"), 20)

	products, total, err := h.productClient.SearchProducts(ctx, searchQuery, page, pageSize)
	if err != nil {
		h.logger.Error("failed to search products", zap.Error(err))
		respondError(w, http.StatusInternalServerError, "failed to search products")
		return
	}

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
