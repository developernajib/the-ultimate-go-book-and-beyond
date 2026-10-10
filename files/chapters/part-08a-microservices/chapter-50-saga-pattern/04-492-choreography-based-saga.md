## 50.2 Choreography-Based Saga

### Event-Based Coordination

In a choreography-based saga each participating service listens for domain events and reacts by performing its local step, then emitting its own outcome event. There is no central coordinator. The Go implementation registers handlers per event type and routes incoming Kafka messages to the correct step, with each handler responsible for persisting its local state and publishing the next event atomically via the transactional outbox pattern. Choreography is simple to implement for linear workflows but becomes hard to reason about as the number of participants grows, because the overall saga flow is implicit in the event chain rather than explicit in code.

```go
// pkg/saga/choreography/saga.go
package choreography

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

/*
Choreography Saga:
- No central coordinator
- Services react to events
- Each service publishes events after local transaction
- Other services subscribe and react

Pros:
- Simple, loosely coupled
- No single point of failure
- Good for simple sagas

Cons:
- Hard to track saga state
- Complex for many steps
- Risk of cyclic dependencies
*/

// Event types for order saga
const (
	// Order Service Events
	EventOrderCreated    = "order.created"
	EventOrderConfirmed  = "order.confirmed"
	EventOrderCanceled  = "order.canceled"
	EventOrderCompleted  = "order.completed"

	// Inventory Service Events
	EventInventoryReserved  = "inventory.reserved"
	EventInventoryReleased  = "inventory.released"
	EventInventoryFailed    = "inventory.reservation_failed"

	// Payment Service Events
	EventPaymentProcessed = "payment.processed"
	EventPaymentFailed    = "payment.failed"
	EventPaymentRefunded  = "payment.refunded"

	// Shipping Service Events
	EventShipmentCreated  = "shipment.created"
	EventShipmentFailed   = "shipment.failed"
)

// SagaEvent represents an event in the choreography
type SagaEvent struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	SagaID        string          `json:"saga_id"`
	CorrelationID string          `json:"correlation_id"`
	Timestamp     time.Time       `json:"timestamp"`
	Data          json.RawMessage `json:"data"`
}

// NewSagaEvent creates a new saga event
func NewSagaEvent(eventType, sagaID string, data any) (*SagaEvent, error) {
	dataJSON, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	return &SagaEvent{
		ID:            uuid.New().String(),
		Type:          eventType,
		SagaID:        sagaID,
		CorrelationID: sagaID,
		Timestamp:     time.Now().UTC(),
		Data:          dataJSON,
	}, nil
}

// EventPublisher publishes saga events
type EventPublisher interface {
	Publish(ctx context.Context, event *SagaEvent) error
}

// EventSubscriber subscribes to saga events
type EventSubscriber interface {
	Subscribe(ctx context.Context, eventTypes []string, handler EventHandler) error
}

// EventHandler processes saga events
type EventHandler func(ctx context.Context, event *SagaEvent) error
```

### Order Service (Choreography)

The order service initiates the saga by inserting an order in `pending` state and publishing an `OrderCreated` event. It then reacts to downstream events: `PaymentProcessed` transitions the order to `confirmed`, while `InventoryFailed` or `PaymentFailed` transitions it to `canceled` and publishes an `OrderCanceled` event that triggers compensation in the other services. The order-and-event write is not atomic here. If the event publish fails after the database commit, a separate retry mechanism (or a transactional outbox) must ensure the event is eventually delivered.

```go
// internal/order/service.go
package order

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"example.com/saga/pkg/saga/choreography"
)

// Order represents an order entity
type Order struct {
	ID          string     `json:"id" db:"id"`
	CustomerID  string     `json:"customer_id" db:"customer_id"`
	Status      string     `json:"status" db:"status"`
	TotalAmountCents int64 `json:"total_amount_cents" db:"total_amount_cents"`
	Items       []OrderItem `json:"items"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at" db:"updated_at"`
}

// OrderItem represents an item in an order
type OrderItem struct {
	ID        string  `json:"id" db:"id"`
	OrderID   string  `json:"order_id" db:"order_id"`
	ProductID string  `json:"product_id" db:"product_id"`
	Quantity  int     `json:"quantity" db:"quantity"`
	PriceCents int64 `json:"price_cents" db:"price_cents"`
}

// OrderService handles order operations
type OrderService struct {
	db        *sql.DB
	publisher choreography.EventPublisher
	logger    *slog.Logger
}

// NewOrderService creates a new order service
func NewOrderService(db *sql.DB, publisher choreography.EventPublisher, logger *slog.Logger) *OrderService {
	return &OrderService{
		db:        db,
		publisher: publisher,
		logger:    logger,
	}
}

// CreateOrderRequest represents a request to create an order
type CreateOrderRequest struct {
	CustomerID string      `json:"customer_id"`
	Items      []OrderItem `json:"items"`
}

// CreateOrder creates a new order and initiates the saga
func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
	// Calculate total
	var totalCents int64
	for _, item := range req.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
	}

	// Create order in pending state
	order := &Order{
		ID:          generateID(),
		CustomerID:  req.CustomerID,
		Status:      "pending",
		TotalAmountCents: totalCents,
		Items:       req.Items,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}

	// Insert into database
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	// Insert order
	_, err = tx.ExecContext(ctx,
		`INSERT INTO orders (id, customer_id, status, total_amount_cents, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		order.ID, order.CustomerID, order.Status, order.TotalAmountCents, order.CreatedAt, order.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("insert order: %w", err)
	}

	// Insert order items
	for _, item := range order.Items {
		item.ID = generateID()
		item.OrderID = order.ID
		_, err = tx.ExecContext(ctx,
			`INSERT INTO order_items (id, order_id, product_id, quantity, price_cents)
			 VALUES ($1, $2, $3, $4, $5)`,
			item.ID, item.OrderID, item.ProductID, item.Quantity, item.PriceCents,
		)
		if err != nil {
			return nil, fmt.Errorf("insert order item: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}

	// Publish OrderCreated event to start saga
	event, err := choreography.NewSagaEvent(choreography.EventOrderCreated, order.ID, OrderCreatedEvent{
		OrderID:     order.ID,
		CustomerID:  order.CustomerID,
		TotalAmountCents: order.TotalAmountCents,
		Items:       order.Items,
	})
	if err != nil {
		return nil, fmt.Errorf("create event: %w", err)
	}

	if err := s.publisher.Publish(ctx, event); err != nil {
		// Order is created but event failed - need retry mechanism
		s.logger.Error("Failed to publish OrderCreated event",
			"order_id", order.ID,
			"error", err,
		)
	}

	s.logger.Info("Order created, saga started", "order_id", order.ID)

	return order, nil
}

// OrderCreatedEvent data
type OrderCreatedEvent struct {
	OrderID     string      `json:"order_id"`
	CustomerID  string      `json:"customer_id"`
	TotalAmountCents int64  `json:"total_amount_cents"`
	Items       []OrderItem `json:"items"`
}

// HandleInventoryReserved handles inventory reserved event
func (s *OrderService) HandleInventoryReserved(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID        string `json:"order_id"`
		ReservationID  string `json:"reservation_id"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	s.logger.Info("Inventory reserved, proceeding to payment",
		"order_id", data.OrderID,
		"reservation_id", data.ReservationID,
	)

	// Order service could trigger payment here or let another service handle it
	// In pure choreography, payment service listens to InventoryReserved

	return nil
}

// HandlePaymentProcessed handles payment processed event
func (s *OrderService) HandlePaymentProcessed(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID     string  `json:"order_id"`
		PaymentID   string  `json:"payment_id"`
		AmountCents int64  `json:"amount_cents"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	// Update order status to confirmed
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("update order status: %w", err)
	}

	// Publish order confirmed event
	confirmEvent, err := choreography.NewSagaEvent(choreography.EventOrderConfirmed, data.OrderID, map[string]any{
		"order_id":   data.OrderID,
		"payment_id": data.PaymentID,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, confirmEvent); err != nil {
		s.logger.Error("Failed to publish OrderConfirmed event", "error", err)
	}

	s.logger.Info("Order confirmed", "order_id", data.OrderID)

	return nil
}

// HandleInventoryFailed handles inventory reservation failure - compensate
func (s *OrderService) HandleInventoryFailed(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
		Reason  string `json:"reason"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	// Cancel the order
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = 'canceled', updated_at = NOW() WHERE id = $1`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("update order status: %w", err)
	}

	// Publish order canceled event
	cancelEvent, err := choreography.NewSagaEvent(choreography.EventOrderCanceled, data.OrderID, map[string]any{
		"order_id": data.OrderID,
		"reason":   data.Reason,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, cancelEvent); err != nil {
		s.logger.Error("Failed to publish OrderCanceled event", "error", err)
	}

	s.logger.Info("Order canceled due to inventory failure",
		"order_id", data.OrderID,
		"reason", data.Reason,
	)

	return nil
}

// HandlePaymentFailed handles payment failure - compensate
func (s *OrderService) HandlePaymentFailed(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
		Reason  string `json:"reason"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	// Cancel the order
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = 'payment_failed', updated_at = NOW() WHERE id = $1`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("update order status: %w", err)
	}

	// Publish order canceled event
	cancelEvent, err := choreography.NewSagaEvent(choreography.EventOrderCanceled, data.OrderID, map[string]any{
		"order_id": data.OrderID,
		"reason":   "Payment failed: " + data.Reason,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, cancelEvent); err != nil {
		s.logger.Error("Failed to publish OrderCanceled event", "error", err)
	}

	s.logger.Info("Order canceled due to payment failure",
		"order_id", data.OrderID,
		"reason", data.Reason,
	)

	return nil
}

func generateID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
```

### Inventory Service (Choreography)

The inventory service reacts to `OrderCreated` events by reserving stock inside a database transaction, using `SELECT ... FOR UPDATE` to prevent overselling under concurrent requests. If stock is insufficient, it publishes an `InventoryFailed` event that triggers the order service's compensation path. On cancellation, it reverses the reservation by restoring the available count and marking each reservation row as released, again within a single transaction to keep the inventory and reservation tables consistent.

```go
// internal/inventory/service.go
package inventory

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"example.com/saga/pkg/saga/choreography"
)

// Inventory represents inventory for a product
type Inventory struct {
	ProductID   string `json:"product_id" db:"product_id"`
	Available   int    `json:"available" db:"available"`
	Reserved    int    `json:"reserved" db:"reserved"`
}

// Reservation represents a stock reservation
type Reservation struct {
	ID          string    `json:"id" db:"id"`
	OrderID     string    `json:"order_id" db:"order_id"`
	ProductID   string    `json:"product_id" db:"product_id"`
	Quantity    int       `json:"quantity" db:"quantity"`
	Status      string    `json:"status" db:"status"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	ExpiresAt   time.Time `json:"expires_at" db:"expires_at"`
}

// InventoryService handles inventory operations
type InventoryService struct {
	db        *sql.DB
	publisher choreography.EventPublisher
	logger    *slog.Logger
}

// NewInventoryService creates a new inventory service
func NewInventoryService(db *sql.DB, publisher choreography.EventPublisher, logger *slog.Logger) *InventoryService {
	return &InventoryService{
		db:        db,
		publisher: publisher,
		logger:    logger,
	}
}

// HandleOrderCreated handles order created event - reserve inventory
func (s *InventoryService) HandleOrderCreated(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
		Items   []struct {
			ProductID string `json:"product_id"`
			Quantity  int    `json:"quantity"`
		} `json:"items"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	s.logger.Info("Reserving inventory for order", "order_id", data.OrderID)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	reservations := make([]Reservation, 0, len(data.Items))

	for _, item := range data.Items {
		// Check and reserve inventory
		var available int
		err := tx.QueryRowContext(ctx,
			`SELECT available FROM inventory WHERE product_id = $1 FOR UPDATE`,
			item.ProductID,
		).Scan(&available)
		if err != nil {
			return s.publishFailure(ctx, data.OrderID, fmt.Sprintf("product %s not found", item.ProductID))
		}

		if available < item.Quantity {
			return s.publishFailure(ctx, data.OrderID, fmt.Sprintf("insufficient stock for product %s", item.ProductID))
		}

		// Reserve stock
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET available = available - $1, reserved = reserved + $1 WHERE product_id = $2`,
			item.Quantity, item.ProductID,
		)
		if err != nil {
			return fmt.Errorf("update inventory: %w", err)
		}

		// Create reservation record
		reservation := Reservation{
			ID:        generateID(),
			OrderID:   data.OrderID,
			ProductID: item.ProductID,
			Quantity:  item.Quantity,
			Status:    "active",
			CreatedAt: time.Now().UTC(),
			ExpiresAt: time.Now().UTC().Add(30 * time.Minute),
		}

		_, err = tx.ExecContext(ctx,
			`INSERT INTO reservations (id, order_id, product_id, quantity, status, created_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			reservation.ID, reservation.OrderID, reservation.ProductID,
			reservation.Quantity, reservation.Status, reservation.CreatedAt, reservation.ExpiresAt,
		)
		if err != nil {
			return fmt.Errorf("insert reservation: %w", err)
		}

		reservations = append(reservations, reservation)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// Publish inventory reserved event
	reservedEvent, err := choreography.NewSagaEvent(choreography.EventInventoryReserved, data.OrderID, map[string]any{
		"order_id":     data.OrderID,
		"reservations": reservations,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, reservedEvent); err != nil {
		s.logger.Error("Failed to publish InventoryReserved event", "error", err)
		// Need to handle this failure - perhaps store in outbox
	}

	s.logger.Info("Inventory reserved", "order_id", data.OrderID)

	return nil
}

func (s *InventoryService) publishFailure(ctx context.Context, orderID, reason string) error {
	failedEvent, err := choreography.NewSagaEvent(choreography.EventInventoryFailed, orderID, map[string]any{
		"order_id": orderID,
		"reason":   reason,
	})
	if err != nil {
		return err
	}

	return s.publisher.Publish(ctx, failedEvent)
}

// HandleOrderCanceled handles order canceled event - release inventory (compensate)
func (s *InventoryService) HandleOrderCanceled(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	s.logger.Info("Releasing inventory for canceled order", "order_id", data.OrderID)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get reservations for order
	rows, err := tx.QueryContext(ctx,
		`SELECT id, product_id, quantity FROM reservations WHERE order_id = $1 AND status = 'active'`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("query reservations: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var id, productID string
		var quantity int
		if err := rows.Scan(&id, &productID, &quantity); err != nil {
			return err
		}

		// Release stock
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET available = available + $1, reserved = reserved - $1 WHERE product_id = $2`,
			quantity, productID,
		)
		if err != nil {
			return fmt.Errorf("update inventory: %w", err)
		}

		// Mark reservation as released
		_, err = tx.ExecContext(ctx,
			`UPDATE reservations SET status = 'released' WHERE id = $1`,
			id,
		)
		if err != nil {
			return fmt.Errorf("update reservation: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// Publish inventory released event
	releasedEvent, err := choreography.NewSagaEvent(choreography.EventInventoryReleased, data.OrderID, map[string]any{
		"order_id": data.OrderID,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, releasedEvent); err != nil {
		s.logger.Error("Failed to publish InventoryReleased event", "error", err)
	}

	s.logger.Info("Inventory released", "order_id", data.OrderID)

	return nil
}

// HandleOrderConfirmed handles order confirmed - confirm reservation
func (s *InventoryService) HandleOrderConfirmed(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	// Confirm reservations (move from reserved to sold)
	_, err := s.db.ExecContext(ctx,
		`UPDATE reservations SET status = 'confirmed' WHERE order_id = $1 AND status = 'active'`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("confirm reservations: %w", err)
	}

	// Reduce reserved count (already deducted from available)
	_, err = s.db.ExecContext(ctx,
		`UPDATE inventory i
		 SET reserved = reserved - r.quantity
		 FROM reservations r
		 WHERE r.order_id = $1 AND r.product_id = i.product_id AND r.status = 'confirmed'`,
		data.OrderID,
	)
	if err != nil {
		return fmt.Errorf("update inventory: %w", err)
	}

	s.logger.Info("Inventory confirmed", "order_id", data.OrderID)

	return nil
}
```

### Payment Service (Choreography)

The payment service subscribes to `InventoryReserved` events and attempts to charge the customer through an external payment gateway. On success it persists the payment record and publishes `PaymentProcessed`. On failure it publishes `PaymentFailed`, which causes the order service to cancel the order and the inventory service to release the reservation. The compensation handler for `OrderCanceled` checks whether a completed payment exists before attempting a refund, making the operation safe to call even when payment was never captured.

```go
// internal/payment/service.go
package payment

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"example.com/saga/pkg/saga/choreography"
)

// Payment represents a payment
type Payment struct {
	ID        string    `json:"id" db:"id"`
	OrderID   string    `json:"order_id" db:"order_id"`
	AmountCents int64     `json:"amount_cents" db:"amount_cents"`
	Status    string    `json:"status" db:"status"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

// PaymentService handles payment operations
type PaymentService struct {
	db        *sql.DB
	publisher choreography.EventPublisher
	logger    *slog.Logger
}

// NewPaymentService creates a new payment service
func NewPaymentService(db *sql.DB, publisher choreography.EventPublisher, logger *slog.Logger) *PaymentService {
	return &PaymentService{
		db:        db,
		publisher: publisher,
		logger:    logger,
	}
}

// HandleInventoryReserved handles inventory reserved event - process payment
func (s *PaymentService) HandleInventoryReserved(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID     string  `json:"order_id"`
		TotalAmountCents int64 `json:"total_amount_cents"`
		CustomerID  string  `json:"customer_id"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	s.logger.Info("Processing payment for order", "order_id", data.OrderID)

	// Simulate payment processing
	payment := &Payment{
		ID:        generateID(),
		OrderID:   data.OrderID,
		AmountCents: data.TotalAmountCents,
		Status:    "pending",
		CreatedAt: time.Now().UTC(),
	}

	// In real implementation, this would call payment gateway
	success, reason := s.processPaymentWithGateway(ctx, payment)

	if !success {
		// Payment failed - publish failure event
		failedEvent, err := choreography.NewSagaEvent(choreography.EventPaymentFailed, data.OrderID, map[string]any{
			"order_id": data.OrderID,
			"reason":   reason,
		})
		if err != nil {
			return err
		}

		if err := s.publisher.Publish(ctx, failedEvent); err != nil {
			s.logger.Error("Failed to publish PaymentFailed event", "error", err)
		}

		s.logger.Info("Payment failed", "order_id", data.OrderID, "reason", reason)
		return nil
	}

	// Save successful payment
	payment.Status = "completed"
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO payments (id, order_id, amount_cents, status, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		payment.ID, payment.OrderID, payment.AmountCents, payment.Status, payment.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert payment: %w", err)
	}

	// Publish payment processed event
	processedEvent, err := choreography.NewSagaEvent(choreography.EventPaymentProcessed, data.OrderID, map[string]any{
		"order_id":   data.OrderID,
		"payment_id": payment.ID,
		"amount_cents": payment.AmountCents,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, processedEvent); err != nil {
		s.logger.Error("Failed to publish PaymentProcessed event", "error", err)
	}

	s.logger.Info("Payment processed", "order_id", data.OrderID, "payment_id", payment.ID)

	return nil
}

func (s *PaymentService) processPaymentWithGateway(ctx context.Context, payment *Payment) (bool, string) {
	// Simulate payment gateway call
	// In real implementation, this would call Stripe/PayPal/etc.
	time.Sleep(100 * time.Millisecond)

	// Simulate occasional failures
	// For demo, fail if amount exceeds $100.00
	if payment.AmountCents > 10000 {
		return false, "amount exceeds limit"
	}

	return true, ""
}

// HandleOrderCanceled handles order canceled - refund payment (compensate)
func (s *PaymentService) HandleOrderCanceled(ctx context.Context, event *choreography.SagaEvent) error {
	var data struct {
		OrderID string `json:"order_id"`
	}
	if err := json.Unmarshal(event.Data, &data); err != nil {
		return err
	}

	// Check if payment exists for this order
	var payment Payment
	err := s.db.QueryRowContext(ctx,
		`SELECT id, order_id, amount_cents, status FROM payments WHERE order_id = $1 AND status = 'completed'`,
		data.OrderID,
	).Scan(&payment.ID, &payment.OrderID, &payment.AmountCents, &payment.Status)

	if err == sql.ErrNoRows {
		// No payment to refund
		s.logger.Info("No payment to refund", "order_id", data.OrderID)
		return nil
	}
	if err != nil {
		return fmt.Errorf("query payment: %w", err)
	}

	// Process refund
	s.logger.Info("Processing refund for order", "order_id", data.OrderID, "payment_id", payment.ID)

	// Update payment status to refunded
	_, err = s.db.ExecContext(ctx,
		`UPDATE payments SET status = 'refunded' WHERE id = $1`,
		payment.ID,
	)
	if err != nil {
		return fmt.Errorf("update payment: %w", err)
	}

	// Publish refund event
	refundEvent, err := choreography.NewSagaEvent(choreography.EventPaymentRefunded, data.OrderID, map[string]any{
		"order_id":   data.OrderID,
		"payment_id": payment.ID,
		"amount_cents": payment.AmountCents,
	})
	if err != nil {
		return err
	}

	if err := s.publisher.Publish(ctx, refundEvent); err != nil {
		s.logger.Error("Failed to publish PaymentRefunded event", "error", err)
	}

	s.logger.Info("Payment refunded", "order_id", data.OrderID, "payment_id", payment.ID)

	return nil
}
```

### Junior -> FAANG: Tracing a Choreography Saga by Hand

The biggest practical skill gap for junior engineers implementing choreography-based sagas is the inability to trace a saga's execution path through the event chain when something goes wrong. Practice this by reading the three service handlers above and answering: if `ProcessPaymentActivity` succeeds at the Stripe API level but the `payments` table insert fails, what state is the system in?

Answer: the customer has been charged. No payment row exists locally. The saga never publishes `PaymentProcessed`. The order stays in `inventory_reserved` status forever. The inventory reservation eventually expires (if you implemented expiry), or it holds stock indefinitely. This is a real failure mode called "phantom charge," and it is prevented by either the transactional outbox pattern (write the payment row and the event in the same local transaction, then relay events from the outbox) or by making the Stripe call idempotent so the retry also returns success with the same charge ID.

A worked example for building the habit: every time you write a handler like `HandleInventoryReserved`, write a test table with at least five entries: (1) happy path, (2) database write succeeds but event publish fails, (3) event published but database write fails, (4) handler called twice with the same event (at-least-once delivery), (5) handler called out of order because of Kafka rebalance. Test entry 4 reveals whether your handler is idempotent. Test entry 5 reveals whether you have an ordering assumption that choreography cannot guarantee.

The `generateID()` function in the code uses `time.Now().UnixNano()`, which is not safe for concurrent use across goroutines and produces collisions under high throughput. In a real system, use the standard library `uuid` package (Go 1.27) for identifiers, which is what the choreography package already imports. This kind of detail is what code reviewers at FAANG catch immediately.

### Senior @ FAANG: Production Gaps in Choreography Implementations

The implementation in this section is architecturally correct but contains several gaps that a senior engineer must close before deploying it.

**Transactional outbox is missing.** Every service handler writes to the local database and then calls `s.publisher.Publish(ctx, event)` as two separate operations. If the publish fails, the local state is committed but the event is never delivered. The downstream saga step never fires. In production this must be replaced with the transactional outbox pattern: the event is inserted into an `outbox` table in the same database transaction as the local state change, and a separate relay process polls the outbox and publishes to Kafka with at-least-once delivery, marking rows as published after acknowledgment. This is the only way to guarantee that local state changes and downstream events are not silently lost under any failure mode.

**Consumer group semantics need explicit design.** The inventory service subscribes to `OrderCreated` events. If you run three inventory service instances for redundancy, all three are in the same consumer group and Kafka delivers each partition to exactly one instance. If a rebalance happens in the middle of processing a message, the message may be redelivered to a different instance. The `HandleOrderCreated` handler must be idempotent under this condition: calling it twice for the same `OrderCreated` event must not double-reserve inventory. The fix uses the reservation table as the idempotency record: check whether a reservation already exists for `order_id` before inserting, and return success without modifying inventory if it does.

**Cyclic event dependency detection.** Pure choreography creates the possibility of event loops: service A's handler for event X publishes event Y, service B's handler for event Y publishes event Z, and service C's handler for event Z publishes event X. The system loops until a depth counter or TTL field in the event envelope terminates it. Enforce this by adding `depth int` and `max_depth int` to the `SagaEvent` struct and rejecting any event whose depth exceeds the saga's configured maximum. Failing to do this turns a misconfigured compensation flow into an infinite event storm that exhausts Kafka topic retention.

**Observability gap.** There is no correlation between the Kafka consumer lag metric and the saga state. A saga stuck because the payment service's consumer group is 10,000 messages behind is invisible in the saga state table, which shows all sagas as `inventory_reserved` (normal). Staff engineers add a separate reconciler job that queries for sagas in non-terminal states older than the expected step latency threshold and cross-references them with consumer group lag per topic partition. This surfaces "the payment service consumer is behind and N sagas are waiting" rather than requiring the on-call engineer to correlate two separate dashboards.

---
