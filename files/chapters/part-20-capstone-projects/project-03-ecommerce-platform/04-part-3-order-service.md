## Part 3: Order Service

The Order Service is responsible for creating, tracking, and managing customer orders throughout their entire lifecycle. It coordinates with the Product Service to validate items, the Payment Service to process charges, and the Notification Service to keep customers informed. Because placing an order touches multiple services, this is where you will implement the Saga pattern to handle distributed transactions safely, ensuring that a failure in any step triggers proper compensating actions.

### 3.1 Order Service Proto Definition

**services/order/proto/order.proto**

```protobuf
syntax = "proto3";

package order;
option go_package = "github.com/yourusername/ecommerce/services/order/proto";

import "google/protobuf/timestamp.proto";
import "proto/common/types.proto";

service OrderService {
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);
  rpc ListOrders(ListOrdersRequest) returns (ListOrdersResponse);
  rpc UpdateOrderStatus(UpdateOrderStatusRequest) returns (UpdateOrderStatusResponse);
  rpc CancelOrder(CancelOrderRequest) returns (CancelOrderResponse);
}

message Order {
  string id = 1;
  string user_id = 2;
  repeated OrderItem items = 3;
  common.Money subtotal = 4;
  common.Money tax = 5;
  common.Money shipping = 6;
  common.Money discount = 7;
  common.Money total = 8;
  OrderStatus status = 9;
  common.Address shipping_address = 10;
  common.Address billing_address = 11;
  string payment_intent_id = 12;
  string inventory_reservation_id = 13;
  map<string, string> metadata = 14;
  google.protobuf.Timestamp created_at = 15;
  google.protobuf.Timestamp updated_at = 16;
}

message OrderItem {
  string id = 1;
  string product_id = 2;
  optional string variant_id = 3;
  string product_name = 4;
  string sku = 5;
  int32 quantity = 6;
  common.Money unit_price = 7;
  common.Money total_price = 8;
}

enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;
  ORDER_STATUS_PENDING = 1;
  ORDER_STATUS_PAYMENT_PENDING = 2;
  ORDER_STATUS_PAYMENT_CONFIRMED = 3;
  ORDER_STATUS_PROCESSING = 4;
  ORDER_STATUS_SHIPPED = 5;
  ORDER_STATUS_DELIVERED = 6;
  ORDER_STATUS_CANCELED = 7;
  ORDER_STATUS_REFUNDED = 8;
}

message CreateOrderRequest {
  string user_id = 1;
  repeated OrderItemRequest items = 2;
  common.Address shipping_address = 3;
  common.Address billing_address = 4;
  optional string coupon_code = 5;
}

message OrderItemRequest {
  string product_id = 1;
  optional string variant_id = 2;
  int32 quantity = 3;
}

message CreateOrderResponse {
  Order order = 1;
}

message GetOrderRequest {
  string id = 1;
}

message GetOrderResponse {
  Order order = 1;
}

message ListOrdersRequest {
  string user_id = 1;
  OrderStatus status = 2;
  common.PageRequest page = 3;
}

message ListOrdersResponse {
  repeated Order orders = 1;
  common.PageResponse page = 2;
}

message UpdateOrderStatusRequest {
  string id = 1;
  OrderStatus status = 2;
}

message UpdateOrderStatusResponse {
  Order order = 1;
}

message CancelOrderRequest {
  string id = 1;
  string reason = 2;
}

message CancelOrderResponse {
  Order order = 1;
}
```

### 3.2 Order Service Domain Models

**services/order/internal/domain/order.go**

```go
package domain

import (
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

// Order represents a customer order
type Order struct {
	ID                    uuid.UUID
	UserID                uuid.UUID
	Items                 []OrderItem
	Subtotal              decimal.Decimal
	Tax                   decimal.Decimal
	Shipping              decimal.Decimal
	Discount              decimal.Decimal
	Total                 decimal.Decimal
	Currency              string
	Status                OrderStatus
	ShippingAddress       Address
	BillingAddress        Address
	PaymentIntentID       string
	InventoryReservationID uuid.UUID
	Metadata              map[string]string
	CreatedAt             time.Time
	UpdatedAt             time.Time
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
	OrderStatusCanceled        OrderStatus = "canceled"
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
	OrderEventCanceled        OrderEventType = "order.canceled"
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

// CanCancel checks if the order can be canceled
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
```

**services/order/internal/domain/errors.go**

```go
package domain

import "errors"

var (
	ErrOrderNotFound      = errors.New("order not found")
	ErrInvalidUserID      = errors.New("invalid user ID")
	ErrInvalidProductID   = errors.New("invalid product ID")
	ErrInvalidQuantity    = errors.New("invalid quantity")
	ErrInvalidPrice       = errors.New("invalid price")
	ErrNoItems            = errors.New("order must have at least one item")
	ErrCannotCancel       = errors.New("order cannot be canceled")
	ErrCannotRefund       = errors.New("order cannot be refunded")
	ErrInvalidStatus      = errors.New("invalid order status")
)
```

### 3.3 Order Service with Saga Pattern

The Order Service uses the Saga pattern to handle distributed transactions across multiple services (Product, Payment, Inventory).

**services/order/internal/saga/order_saga.go**

```go
package saga

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/yourusername/ecommerce/pkg/events"
	"github.com/yourusername/ecommerce/services/order/internal/domain"
)

// OrderSaga orchestrates the order creation process
type OrderSaga struct {
	orderRepo     OrderRepository
	productClient ProductClient
	paymentClient PaymentClient
	eventBus      events.Publisher
	logger        *zap.Logger
}

// OrderRepository defines order persistence interface
type OrderRepository interface {
	Create(ctx context.Context, order *domain.Order) error
	GetByID(ctx context.Context, id uuid.UUID) (*domain.Order, error)
	Update(ctx context.Context, order *domain.Order) error
	AddEvent(ctx context.Context, event *domain.OrderEvent) error
}

// ProductClient defines product service interface
type ProductClient interface {
	ReserveInventory(ctx context.Context, items []domain.OrderItem) (uuid.UUID, time.Time, error)
	ReleaseInventory(ctx context.Context, reservationID uuid.UUID) error
	CommitInventory(ctx context.Context, reservationID uuid.UUID) error
}

// PaymentClient defines payment service interface
type PaymentClient interface {
	CreatePaymentIntent(ctx context.Context, orderID uuid.UUID, amount, currency string) (string, error)
	CapturePayment(ctx context.Context, paymentIntentID string) error
	RefundPayment(ctx context.Context, paymentIntentID string) error
}

// NewOrderSaga creates a new OrderSaga
func NewOrderSaga(
	orderRepo OrderRepository,
	productClient ProductClient,
	paymentClient PaymentClient,
	eventBus events.Publisher,
	logger *zap.Logger,
) *OrderSaga {
	return &OrderSaga{
		orderRepo:     orderRepo,
		productClient: productClient,
		paymentClient: paymentClient,
		eventBus:      eventBus,
		logger:        logger,
	}
}

// CreateOrder executes the order creation saga
func (s *OrderSaga) CreateOrder(ctx context.Context, order *domain.Order) (*domain.Order, error) {
	s.logger.Info("starting order creation saga", zap.String("order_id", order.ID.String()))

	// Step 1: Create order in pending state
	order.Status = domain.OrderStatusPending
	if err := s.orderRepo.Create(ctx, order); err != nil {
		return nil, fmt.Errorf("creating order: %w", err)
	}

	// Publish order created event
	if err := s.publishEvent(ctx, order.ID, domain.OrderEventCreated, map[string]any{
		"user_id": order.UserID.String(),
		"total":   order.Total.String(),
	}); err != nil {
		s.logger.Error("failed to publish order created event", zap.Error(err))
	}

	// Step 2: Reserve inventory
	reservationID, expiresAt, err := s.productClient.ReserveInventory(ctx, order.Items)
	if err != nil {
		s.logger.Error("failed to reserve inventory", zap.Error(err))
		order.Status = domain.OrderStatusCanceled
		_ = s.orderRepo.Update(ctx, order)
		return nil, fmt.Errorf("reserving inventory: %w", err)
	}

	order.InventoryReservationID = reservationID
	order.Status = domain.OrderStatusPaymentPending
	if err := s.orderRepo.Update(ctx, order); err != nil {
		// Compensate: Release inventory
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		return nil, fmt.Errorf("updating order: %w", err)
	}

	s.logger.Info("inventory reserved",
		zap.String("order_id", order.ID.String()),
		zap.String("reservation_id", reservationID.String()),
		zap.Time("expires_at", expiresAt),
	)

	// Step 3: Create payment intent
	paymentIntentID, err := s.paymentClient.CreatePaymentIntent(
		ctx,
		order.ID,
		order.Total.String(),
		order.Currency,
	)
	if err != nil {
		s.logger.Error("failed to create payment intent", zap.Error(err))
		// Compensate: Release inventory
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		order.Status = domain.OrderStatusCanceled
		_ = s.orderRepo.Update(ctx, order)
		return nil, fmt.Errorf("creating payment intent: %w", err)
	}

	order.PaymentIntentID = paymentIntentID
	if err := s.orderRepo.Update(ctx, order); err != nil {
		// Compensate: Release inventory and cancel payment
		_ = s.productClient.ReleaseInventory(ctx, reservationID)
		_ = s.paymentClient.RefundPayment(ctx, paymentIntentID)
		return nil, fmt.Errorf("updating order: %w", err)
	}

	s.logger.Info("payment intent created",
		zap.String("order_id", order.ID.String()),
		zap.String("payment_intent_id", paymentIntentID),
	)

	return order, nil
}

// ConfirmPayment handles payment confirmation
func (s *OrderSaga) ConfirmPayment(ctx context.Context, orderID uuid.UUID, paymentIntentID string) error {
	s.logger.Info("confirming payment", zap.String("order_id", orderID.String()))

	// Get order
	order, err := s.orderRepo.GetByID(ctx, orderID)
	if err != nil {
		return fmt.Errorf("getting order: %w", err)
	}

	if order.Status != domain.OrderStatusPaymentPending {
		return fmt.Errorf("order is not in payment pending status")
	}

	// Capture payment
	if err := s.paymentClient.CapturePayment(ctx, paymentIntentID); err != nil {
		s.logger.Error("failed to capture payment", zap.Error(err))
		return fmt.Errorf("capturing payment: %w", err)
	}

	// Commit inventory reservation
	if err := s.productClient.CommitInventory(ctx, order.InventoryReservationID); err != nil {
		s.logger.Error("failed to commit inventory", zap.Error(err))
		// Compensate: Refund payment
		_ = s.paymentClient.RefundPayment(ctx, paymentIntentID)
		order.Status = domain.OrderStatusCanceled
		_ = s.orderRepo.Update(ctx, order)
		return fmt.Errorf("committing inventory: %w", err)
	}

	// Update order status
	order.Status = domain.OrderStatusPaymentConfirmed
	if err := s.orderRepo.Update(ctx, order); err != nil {
		s.logger.Error("failed to update order status", zap.Error(err))
		return fmt.Errorf("updating order: %w", err)
	}

	// Publish payment confirmed event
	if err := s.publishEvent(ctx, order.ID, domain.OrderEventPaymentConfirmed, map[string]any{
		"payment_intent_id": paymentIntentID,
		"total":             order.Total.String(),
	}); err != nil {
		s.logger.Error("failed to publish payment confirmed event", zap.Error(err))
	}

	s.logger.Info("payment confirmed", zap.String("order_id", orderID.String()))

	return nil
}

// CancelOrder handles order cancellation
func (s *OrderSaga) CancelOrder(ctx context.Context, orderID uuid.UUID, reason string) error {
	s.logger.Info("cancelling order",
		zap.String("order_id", orderID.String()),
		zap.String("reason", reason),
	)

	// Get order
	order, err := s.orderRepo.GetByID(ctx, orderID)
	if err != nil {
		return fmt.Errorf("getting order: %w", err)
	}

	if !order.CanCancel() {
		return domain.ErrCannotCancel
	}

	// Release inventory if reserved
	if order.InventoryReservationID != uuid.Nil {
		if err := s.productClient.ReleaseInventory(ctx, order.InventoryReservationID); err != nil {
			s.logger.Error("failed to release inventory", zap.Error(err))
		}
	}

	// Refund payment if captured
	if order.Status == domain.OrderStatusPaymentConfirmed || order.Status == domain.OrderStatusProcessing {
		if err := s.paymentClient.RefundPayment(ctx, order.PaymentIntentID); err != nil {
			s.logger.Error("failed to refund payment", zap.Error(err))
			return fmt.Errorf("refunding payment: %w", err)
		}
		order.Status = domain.OrderStatusRefunded
	} else {
		order.Status = domain.OrderStatusCanceled
	}

	// Update order
	if err := s.orderRepo.Update(ctx, order); err != nil {
		return fmt.Errorf("updating order: %w", err)
	}

	// Publish canceled event
	if err := s.publishEvent(ctx, order.ID, domain.OrderEventCanceled, map[string]any{
		"reason": reason,
	}); err != nil {
		s.logger.Error("failed to publish canceled event", zap.Error(err))
	}

	s.logger.Info("order canceled", zap.String("order_id", orderID.String()))

	return nil
}

func (s *OrderSaga) publishEvent(ctx context.Context, orderID uuid.UUID, eventType domain.OrderEventType, data map[string]any) error {
	event := &domain.OrderEvent{
		ID:        uuid.New(),
		OrderID:   orderID,
		EventType: eventType,
		Data:      data,
		CreatedAt: time.Now(),
	}

	// Save event to database
	if err := s.orderRepo.AddEvent(ctx, event); err != nil {
		return fmt.Errorf("saving event: %w", err)
	}

	// Publish to event bus
	return s.eventBus.Publish(ctx, string(eventType), event)
}
```

---

### Junior → FAANG: The Saga Pattern as a Distributed Transaction Alternative

The order service uses the Saga pattern to coordinate a checkout that spans multiple services (inventory reservation, payment charging, fulfillment trigger). Understanding why Saga exists is more important than knowing its implementation details: distributed databases do not support ACID transactions across service boundaries. If the payment service times out after inventory is reserved, you need a way to compensate (release the reservation). Saga provides that mechanism.

Two Saga variants are worth knowing for interviews: choreography (each service publishes events and other services react) and orchestration (a central orchestrator directs each step). Choreography is simpler but makes the overall flow harder to observe. Orchestration is more complex but provides a single place to see the full transaction state.

For the interview question "how do you handle a payment failure in an order that has already reserved inventory?", the Saga answer is: the payment service publishes a PaymentFailed event, the order service consumes it and transitions the order to Failed state, and the inventory service consumes the OrderFailed event and releases the reservation.

### Senior @ FAANG: Order State Machine as a Correctness Guarantee

At senior level, the order lifecycle is a formal state machine. Each state (Created, InventoryReserved, PaymentPending, PaymentCompleted, Fulfilled, Canceled, RefundPending, Refunded) has defined valid transitions. No transition should be possible that would leave the order in an inconsistent state.

Implementing the state machine with a persistent state store (storing the current state in PostgreSQL) and only allowing valid transitions (using a database constraint or a domain layer check) prevents illegal state transitions even under concurrent requests. The database column `ORDER STATUS VARCHAR(50) CHECK (status IN ('created', 'payment_pending', ...))` is the simplest enforcement mechanism.

Idempotency is the most critical correctness property for the payment step. Payment processors (Stripe, Adyen) can succeed but return a timeout to your service, leaving you uncertain whether the payment was charged. Retry without idempotency results in double charging. The correct approach uses an idempotency key (your order ID) when calling the payment processor: if you retry with the same key, the processor returns the original result without charging again. Documenting this idempotency contract in the ADR and testing it explicitly (simulate timeout, verify retry does not double charge) is required before production.

---
