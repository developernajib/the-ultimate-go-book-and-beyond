package clients

import (
	"context"

	"github.com/google/uuid"
)

// ProductInfo represents a product returned to gateway clients
type ProductInfo struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	SKU         string    `json:"sku"`
	Price       float64   `json:"price"`
	Currency    string    `json:"currency"`
	Inventory   int32     `json:"inventory"`
}

// ProductClient is a client for the product service
type ProductClient struct {
	addr string
}

// NewProductClient creates a new ProductClient
func NewProductClient(addr string) *ProductClient {
	return &ProductClient{addr: addr}
}

// ListProducts retrieves products from the product service
func (c *ProductClient) ListProducts(ctx context.Context, searchQuery string, page, pageSize int) ([]*ProductInfo, int, error) {
	// In production: call gRPC product service
	// For now: return empty results
	return []*ProductInfo{}, 0, nil
}

// GetProduct retrieves a product by ID from the product service
func (c *ProductClient) GetProduct(ctx context.Context, productID uuid.UUID) (*ProductInfo, error) {
	// In production: call gRPC product service
	return &ProductInfo{
		ID:   productID,
		Name: "Sample Product",
	}, nil
}

// SearchProducts searches products via Elasticsearch
func (c *ProductClient) SearchProducts(ctx context.Context, searchQuery string, page, pageSize int) ([]*ProductInfo, int, error) {
	// In production: call Elasticsearch search service
	return []*ProductInfo{}, 0, nil
}
