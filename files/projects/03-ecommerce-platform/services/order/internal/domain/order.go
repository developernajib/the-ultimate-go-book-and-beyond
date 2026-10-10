package domain

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Order represents a customer order
type Order struct {
	ID                     uuid.UUID
	UserID                 uuid.UUID
	Items                  []OrderItem
	Subtotal               decimal.Decimal
	Tax                    decimal.Decimal
	Shipping               decimal.Decimal
	Discount               decimal.Decimal
	Total                  decimal.Decimal
	Currency               string
	Status                 OrderStatus
	ShippingAddress        Address
	BillingAddress         Address
	PaymentIntentID        string
	InventoryReservationID uuid.UUID
	Metadata               map[string]string
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

// OrderItem represents an item in an order
type OrderItem struct {
	ID          uuid.UUID
	OrderID     uuid.UUID
	ProductID   uuid.UUID
	VariantID   *uuid.UUID
	ProductName string
	SKU         string
	Quantity    int32
	UnitPrice   decimal.Decimal
	TotalPrice  decimal.Decimal
	Currency    string
}

// Address represents a shipping or billing address
type Address struct {
	StreetAddress string
	City          string
	State         string
	PostalCode    string
	Country       string
}

// OrderStatus represents the status of an order
type OrderStatus string

const (
	OrderStatusPending          OrderStatus = "pending"
	OrderStatusPaymentPending   OrderStatus = "payment_pending"
	OrderStatusPaymentConfirmed OrderStatus = "payment_confirmed"
	OrderStatusProcessing       OrderStatus = "processing"
	OrderStatusShipped          OrderStatus = "shipped"
	OrderStatusDelivered        OrderStatus = "delivered"
	OrderStatusCancelled        OrderStatus = "cancelled"
	OrderStatusRefunded         OrderStatus = "refunded"
)

// OrderEvent represents an event in the order lifecycle
type OrderEvent struct {
	ID        uuid.UUID
	OrderID   uuid.UUID
	EventType OrderEventType
	Data      map[string]any
	CreatedAt time.Time
}

// OrderEventType represents the type of order event
type OrderEventType string

const (
	OrderEventCreated          OrderEventType = "order.created"
	OrderEventPaymentConfirmed OrderEventType = "order.payment_confirmed"
	OrderEventProcessing       OrderEventType = "order.processing"
	OrderEventShipped          OrderEventType = "order.shipped"
	OrderEventDelivered        OrderEventType = "order.delivered"
	OrderEventCancelled        OrderEventType = "order.cancelled"
	OrderEventRefunded         OrderEventType = "order.refunded"
)

// CalculateTotal calculates the order total
func (o *Order) CalculateTotal() {
	o.Subtotal = decimal.Zero
	for _, item := range o.Items {
		o.Subtotal = o.Subtotal.Add(item.TotalPrice)
	}

	o.Total = o.Subtotal.
		Add(o.Tax).
		Add(o.Shipping).
		Sub(o.Discount)
}

// CanCancel checks if the order can be cancelled
func (o *Order) CanCancel() bool {
	return o.Status == OrderStatusPending ||
		o.Status == OrderStatusPaymentPending ||
		o.Status == OrderStatusPaymentConfirmed ||
		o.Status == OrderStatusProcessing
}

// CanRefund checks if the order can be refunded
func (o *Order) CanRefund() bool {
	return o.Status == OrderStatusPaymentConfirmed ||
		o.Status == OrderStatusProcessing ||
		o.Status == OrderStatusShipped ||
		o.Status == OrderStatusDelivered
}

// Validate validates the order
func (o *Order) Validate() error {
	if o.UserID == uuid.Nil {
		return ErrInvalidUserID
	}
	if len(o.Items) == 0 {
		return ErrNoItems
	}
	for _, item := range o.Items {
		if err := item.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Validate validates the order item
func (i *OrderItem) Validate() error {
	if i.ProductID == uuid.Nil {
		return ErrInvalidProductID
	}
	if i.Quantity <= 0 {
		return ErrInvalidQuantity
	}
	if i.UnitPrice.LessThan(decimal.Zero) {
		return ErrInvalidPrice
	}
	return nil
}
