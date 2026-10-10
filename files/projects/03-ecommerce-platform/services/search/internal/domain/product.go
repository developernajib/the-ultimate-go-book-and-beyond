package domain

import (
	"time"

	"github.com/google/uuid"
)

// Product represents a product document in the search index
type Product struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	SKU         string    `json:"sku"`
	Price       float64   `json:"price"`
	Currency    string    `json:"currency"`
	Categories  []string  `json:"categories"`
	Tags        []string  `json:"tags"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}
