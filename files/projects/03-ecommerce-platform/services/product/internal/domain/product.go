package domain

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Product represents a product in the catalog
type Product struct {
	ID          uuid.UUID
	Name        string
	Description string
	SKU         string
	Price       decimal.Decimal
	Currency    string
	Inventory   int32
	CategoryIDs []uuid.UUID
	Variants    []ProductVariant
	Images      []ProductImage
	Status      ProductStatus
	Metadata    map[string]string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ProductVariant represents a product variant
type ProductVariant struct {
	ID         uuid.UUID
	ProductID  uuid.UUID
	Name       string
	SKU        string
	Price      decimal.Decimal
	Currency   string
	Inventory  int32
	Attributes map[string]string
}

// ProductImage represents a product image
type ProductImage struct {
	ID      uuid.UUID
	URL     string
	AltText string
	Order   int32
}

// ProductStatus represents the status of a product
type ProductStatus string

const (
	ProductStatusActive       ProductStatus = "active"
	ProductStatusInactive     ProductStatus = "inactive"
	ProductStatusOutOfStock   ProductStatus = "out_of_stock"
	ProductStatusDiscontinued ProductStatus = "discontinued"
)

// Category represents a product category
type Category struct {
	ID       uuid.UUID
	Name     string
	Slug     string
	ParentID *uuid.UUID
	Order    int32
}

// InventoryReservation represents a temporary inventory reservation
type InventoryReservation struct {
	ID        uuid.UUID
	ProductID uuid.UUID
	VariantID *uuid.UUID
	Quantity  int32
	ExpiresAt time.Time
	Status    ReservationStatus
	CreatedAt time.Time
}

// ReservationStatus represents the status of an inventory reservation
type ReservationStatus string

const (
	ReservationStatusPending   ReservationStatus = "pending"
	ReservationStatusCommitted ReservationStatus = "committed"
	ReservationStatusReleased  ReservationStatus = "released"
	ReservationStatusExpired   ReservationStatus = "expired"
)

// Validate validates the product
func (p *Product) Validate() error {
	if p.Name == "" {
		return ErrInvalidProductName
	}
	if p.SKU == "" {
		return ErrInvalidSKU
	}
	if p.Price.LessThan(decimal.Zero) {
		return ErrInvalidPrice
	}
	if p.Inventory < 0 {
		return ErrInvalidInventory
	}
	return nil
}

// IsAvailable checks if the product has sufficient inventory
func (p *Product) IsAvailable(quantity int32) bool {
	return p.Inventory >= quantity && p.Status == ProductStatusActive
}

// CanReserve checks if inventory can be reserved
func (r *InventoryReservation) CanReserve() bool {
	return r.Status == ReservationStatusPending && time.Now().Before(r.ExpiresAt)
}
