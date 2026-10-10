package domain

import (
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

var (
	ErrCartNotFound          = errors.New("cart not found")
	ErrItemNotFound          = errors.New("cart item not found")
	ErrInsufficientInventory = errors.New("insufficient inventory")
)

// Cart represents a shopping cart
type Cart struct {
	ID         uuid.UUID   `json:"id"`
	UserID     uuid.UUID   `json:"user_id"`
	Items      []CartItem  `json:"items"`
	Subtotal   decimal.Decimal `json:"subtotal"`
	Tax        decimal.Decimal `json:"tax"`
	Total      decimal.Decimal `json:"total"`
	CouponCode string      `json:"coupon_code,omitempty"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  time.Time   `json:"updated_at"`
}

// CartItem represents an item in a cart
type CartItem struct {
	ID          uuid.UUID       `json:"id"`
	ProductID   uuid.UUID       `json:"product_id"`
	VariantID   *uuid.UUID      `json:"variant_id,omitempty"`
	ProductName string          `json:"product_name"`
	SKU         string          `json:"sku"`
	Quantity    int32           `json:"quantity"`
	UnitPrice   decimal.Decimal `json:"unit_price"`
	TotalPrice  decimal.Decimal `json:"total_price"`
	Currency    string          `json:"currency"`
	ImageURL    string          `json:"image_url,omitempty"`
}

// CalculateTotal recalculates the cart total
func (c *Cart) CalculateTotal() {
	c.Subtotal = decimal.Zero
	for _, item := range c.Items {
		c.Subtotal = c.Subtotal.Add(item.TotalPrice)
	}
	c.Total = c.Subtotal.Add(c.Tax)
}
