## 52.6 Order Service with Saga

The order service is the most complex service in the platform because it coordinates a distributed transaction across multiple services. Creating an order requires reading the cart, reserving inventory, persisting the order, and clearing the cart, steps that span three different data stores. The `executeSaga` method implements an orchestration-based saga: it runs each step in sequence and compensates (cancels the order, releases inventory) if any step fails. Event publishing notifies downstream services like payment and notification without coupling the order service to them directly.

**Saga implementation choices in 2026.** Three approaches are commonly deployed:

- **Hand-written orchestration (what this chapter shows).** Great for learning the mechanics and for simple two- or three-step workflows. The weakness is durability: if the order service crashes between step 2 and step 3, nothing resumes the saga. You patch this with a periodic reconciliation job plus idempotent steps.
- **Event-driven choreography with the transactional outbox.** Each service listens for events and reacts, inventory sees `OrderCreated` and reserves stock, payment sees `InventoryReserved` and charges, etc. To publish events atomically with local DB writes you use the *outbox pattern*: the same SQL transaction that inserts into `orders` also inserts into an `outbox` table, and a relay process (Debezium/CDC or a simple poller) streams outbox rows into Kafka. This guarantees "exactly-at-least-once" event delivery without distributed transactions. Choreography is elegant for 3-4 participants and becomes hard to reason about beyond that.
- **Durable orchestration with Temporal.io.** Temporal hosts your workflow code, persists every state transition, and replays the workflow from history after a crash, retries, timeouts, and compensations are all expressed as normal Go code. For a checkout saga that touches five or more services, Temporal is usually the right answer in 2026. It removes the ad-hoc reconciliation machinery that hand-written sagas accumulate.

For this chapter we keep the hand-written saga so you can see every step, but in an interview expect to be asked *"how would you make this crash-safe?"*, the answer is either outbox + choreography or Temporal-backed orchestration.

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

	"github.com/google/uuid"

	"example.com/ecommerce/internal/cart"
	"example.com/ecommerce/internal/inventory"
	"example.com/ecommerce/pkg/events"
)

// Order represents an order
type Order struct {
	ID            string      `json:"id" db:"id"`
	UserID        string      `json:"user_id" db:"user_id"`
	Status        string      `json:"status" db:"status"`
	TotalAmountCents int64      `json:"total_amount_cents" db:"total_amount_cents"`
	ShippingAddr  Address     `json:"shipping_address"`
	BillingAddr   Address     `json:"billing_address"`
	Items         []OrderItem `json:"items"`
	PaymentID     *string     `json:"payment_id,omitempty" db:"payment_id"`
	ShipmentID    *string     `json:"shipment_id,omitempty" db:"shipment_id"`
	CreatedAt     time.Time   `json:"created_at" db:"created_at"`
	UpdatedAt     time.Time   `json:"updated_at" db:"updated_at"`
}

// OrderItem represents an item in an order
type OrderItem struct {
	ID        string  `json:"id" db:"id"`
	OrderID   string  `json:"order_id" db:"order_id"`
	ProductID string  `json:"product_id" db:"product_id"`
	Name      string  `json:"name" db:"name"`
	PriceCents int64 `json:"price_cents" db:"price_cents"`
	Quantity  int     `json:"quantity" db:"quantity"`
}

// Address represents an address
type Address struct {
	Line1   string `json:"line1"`
	Line2   string `json:"line2,omitempty"`
	City    string `json:"city"`
	State   string `json:"state"`
	ZipCode string `json:"zip_code"`
	Country string `json:"country"`
}

// OrderStatus constants
const (
	StatusPending         = "pending"
	StatusInventoryReserved = "inventory_reserved"
	StatusPaymentPending  = "payment_pending"
	StatusPaymentFailed   = "payment_failed"
	StatusPaid            = "paid"
	StatusShipping        = "shipping"
	StatusDelivered       = "delivered"
	StatusCanceled       = "canceled"
)

// Service handles order operations
type Service struct {
	db               *sql.DB
	publisher        events.Publisher
	inventoryService *inventory.Service
	cartService      *cart.Service
	logger           *slog.Logger
}

// NewService creates an order service
func NewService(
	db *sql.DB,
	publisher events.Publisher,
	inventoryService *inventory.Service,
	cartService *cart.Service,
	logger *slog.Logger,
) (*Service, error) {
	s := &Service{
		db:               db,
		publisher:        publisher,
		inventoryService: inventoryService,
		cartService:      cartService,
		logger:           logger,
	}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS orders (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL,
			status VARCHAR(50) NOT NULL,
			total_amount_cents BIGINT NOT NULL,
			shipping_address JSONB NOT NULL,
			billing_address JSONB NOT NULL,
			payment_id UUID,
			shipment_id UUID,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS order_items (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
			product_id UUID NOT NULL,
			name VARCHAR(255) NOT NULL,
			price_cents BIGINT NOT NULL,
			quantity INT NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
		CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
		CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
	`

	_, err := s.db.Exec(query)
	return err
}

// CreateOrderRequest represents a request to create an order
type CreateOrderRequest struct {
	UserID          string  `json:"user_id"`
	ShippingAddress Address `json:"shipping_address"`
	BillingAddress  Address `json:"billing_address"`
}

// CreateOrder creates a new order using saga pattern
func (s *Service) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
	// Get cart
	userCart, err := s.cartService.GetCart(ctx, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("get cart: %w", err)
	}

	if len(userCart.Items) == 0 {
		return nil, ErrEmptyCart
	}

	// Calculate total
	var totalCents int64
	orderItems := make([]OrderItem, len(userCart.Items))
	for i, item := range userCart.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
		orderItems[i] = OrderItem{
			ID:        uuid.New().String(),
			ProductID: item.ProductID,
			Name:      item.Name,
			PriceCents: item.PriceCents,
			Quantity:  item.Quantity,
		}
	}

	// Create order
	order := &Order{
		ID:           uuid.New().String(),
		UserID:       req.UserID,
		Status:       StatusPending,
		TotalAmountCents: totalCents,
		ShippingAddr: req.ShippingAddress,
		BillingAddr:  req.BillingAddress,
		Items:        orderItems,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}

	// Begin saga
	if err := s.executeSaga(ctx, order, userCart); err != nil {
		return nil, err
	}

	return order, nil
}

func (s *Service) executeSaga(ctx context.Context, order *Order, userCart *cart.Cart) error {
	// Step 1: Create order in database
	if err := s.saveOrder(ctx, order); err != nil {
		return fmt.Errorf("save order: %w", err)
	}

	// Step 2: Reserve inventory
	reserveItems := make([]inventory.ReserveItem, len(order.Items))
	for i, item := range order.Items {
		reserveItems[i] = inventory.ReserveItem{
			ProductID: item.ProductID,
			Quantity:  item.Quantity,
		}
	}

	_, err := s.inventoryService.ReserveStock(ctx, order.ID, reserveItems)
	if err != nil {
		// Compensate: Cancel order
		s.updateOrderStatus(ctx, order.ID, StatusCanceled)
		return fmt.Errorf("reserve inventory: %w", err)
	}

	// Update status
	order.Status = StatusInventoryReserved
	s.updateOrderStatus(ctx, order.ID, StatusInventoryReserved)

	// Step 3: Clear cart
	if err := s.cartService.ClearCart(ctx, order.UserID); err != nil {
		s.logger.Warn("Failed to clear cart", "error", err)
	}

	// Publish order created event
	s.publisher.Publish(ctx, events.OrderCreated, events.OrderCreatedEvent{
		OrderID:     order.ID,
		UserID:      order.UserID,
		TotalAmountCents: order.TotalAmountCents,
		Items:       order.Items,
	})

	s.logger.Info("Order created",
		"order_id", order.ID,
		"user_id", order.UserID,
		"total_cents", order.TotalAmountCents,
	)

	return nil
}

func (s *Service) saveOrder(ctx context.Context, order *Order) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	shippingJSON, _ := json.Marshal(order.ShippingAddr)
	billingJSON, _ := json.Marshal(order.BillingAddr)

	// Insert order
	_, err = tx.ExecContext(ctx,
		`INSERT INTO orders (id, user_id, status, total_amount_cents, shipping_address, billing_address, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		order.ID, order.UserID, order.Status, order.TotalAmountCents,
		shippingJSON, billingJSON, order.CreatedAt, order.UpdatedAt,
	)
	if err != nil {
		return err
	}

	// Insert items
	for _, item := range order.Items {
		item.OrderID = order.ID
		_, err = tx.ExecContext(ctx,
			`INSERT INTO order_items (id, order_id, product_id, name, price_cents, quantity)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			item.ID, item.OrderID, item.ProductID, item.Name, item.PriceCents, item.Quantity,
		)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Service) updateOrderStatus(ctx context.Context, orderID, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
		status, orderID,
	)
	return err
}

// GetOrder retrieves an order by ID
func (s *Service) GetOrder(ctx context.Context, orderID string) (*Order, error) {
	var order Order
	var shippingJSON, billingJSON []byte

	err := s.db.QueryRowContext(ctx,
		`SELECT id, user_id, status, total_amount_cents, shipping_address, billing_address, payment_id, shipment_id, created_at, updated_at
		 FROM orders WHERE id = $1`,
		orderID,
	).Scan(
		&order.ID, &order.UserID, &order.Status, &order.TotalAmountCents,
		&shippingJSON, &billingJSON, &order.PaymentID, &order.ShipmentID,
		&order.CreatedAt, &order.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, ErrOrderNotFound
	}
	if err != nil {
		return nil, err
	}

	json.Unmarshal(shippingJSON, &order.ShippingAddr)
	json.Unmarshal(billingJSON, &order.BillingAddr)

	// Get items
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, order_id, product_id, name, price_cents, quantity FROM order_items WHERE order_id = $1`,
		orderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var item OrderItem
		if err := rows.Scan(&item.ID, &item.OrderID, &item.ProductID, &item.Name, &item.PriceCents, &item.Quantity); err != nil {
			return nil, err
		}
		order.Items = append(order.Items, item)
	}

	return &order, rows.Err()
}

// GetUserOrders retrieves orders for a user
func (s *Service) GetUserOrders(ctx context.Context, userID string, limit, offset int) ([]Order, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, user_id, status, total_amount_cents, payment_id, shipment_id, created_at, updated_at
		 FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
		userID, limit, offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orders []Order
	for rows.Next() {
		var order Order
		if err := rows.Scan(
			&order.ID, &order.UserID, &order.Status, &order.TotalAmountCents,
			&order.PaymentID, &order.ShipmentID, &order.CreatedAt, &order.UpdatedAt,
		); err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}

	return orders, rows.Err()
}

// HandlePaymentProcessed handles payment processed event
func (s *Service) HandlePaymentProcessed(ctx context.Context, paymentID, orderID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = $1, payment_id = $2, updated_at = NOW() WHERE id = $3`,
		StatusPaid, paymentID, orderID,
	)
	if err != nil {
		return err
	}

	// Confirm inventory reservation
	if err := s.inventoryService.ConfirmReservation(ctx, orderID); err != nil {
		s.logger.Error("Failed to confirm inventory", "order_id", orderID, "error", err)
	}

	// Publish order paid event
	s.publisher.Publish(ctx, events.OrderPaid, events.OrderPaidEvent{
		OrderID:   orderID,
		PaymentID: paymentID,
	})

	s.logger.Info("Order paid", "order_id", orderID, "payment_id", paymentID)

	return nil
}

// HandlePaymentFailed handles payment failure - compensate
func (s *Service) HandlePaymentFailed(ctx context.Context, orderID string, reason string) error {
	// Update order status
	_, err := s.db.ExecContext(ctx,
		`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
		StatusPaymentFailed, orderID,
	)
	if err != nil {
		return err
	}

	// Release inventory
	if err := s.inventoryService.ReleaseStock(ctx, orderID); err != nil {
		s.logger.Error("Failed to release inventory", "order_id", orderID, "error", err)
	}

	// Publish order canceled event
	s.publisher.Publish(ctx, events.OrderCanceled, events.OrderCanceledEvent{
		OrderID: orderID,
		Reason:  "Payment failed: " + reason,
	})

	s.logger.Info("Order canceled due to payment failure",
		"order_id", orderID,
		"reason", reason,
	)

	return nil
}

// CancelOrder cancels an order
func (s *Service) CancelOrder(ctx context.Context, orderID, reason string) error {
	order, err := s.GetOrder(ctx, orderID)
	if err != nil {
		return err
	}

	// Can only cancel pending or payment_failed orders
	if order.Status != StatusPending && order.Status != StatusInventoryReserved && order.Status != StatusPaymentFailed {
		return ErrCannotCancel
	}

	// Update status
	_, err = s.db.ExecContext(ctx,
		`UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2`,
		StatusCanceled, orderID,
	)
	if err != nil {
		return err
	}

	// Release inventory if reserved
	if order.Status == StatusInventoryReserved {
		if err := s.inventoryService.ReleaseStock(ctx, orderID); err != nil {
			s.logger.Error("Failed to release inventory", "order_id", orderID, "error", err)
		}
	}

	// Publish event
	s.publisher.Publish(ctx, events.OrderCanceled, events.OrderCanceledEvent{
		OrderID: orderID,
		Reason:  reason,
	})

	return nil
}

// Errors
var (
	ErrOrderNotFound = fmt.Errorf("order not found")
	ErrEmptyCart     = fmt.Errorf("cart is empty")
	ErrCannotCancel  = fmt.Errorf("order cannot be canceled")
)
```

### Junior → FAANG: Understanding Sagas Before You Get Asked About Them

The saga pattern is one of the most common FAANG distributed systems interview topics. The order service here demonstrates orchestration-based saga. Study these specific points before your interview.

**Orchestration vs choreography, one sentence each.** Orchestration: a central coordinator (this order service) tells each participant what to do and handles compensation. Choreography: each service reacts to events and publishes its own events, with no central coordinator. Know when to use each: orchestration for complex flows with many steps where you need a single place to see the full state, choreography for simple two- or three-service flows where loose coupling is the priority.

**What `executeSaga` does when inventory fails.** It calls `updateOrderStatus(ctx, order.ID, StatusCanceled)`. This is the compensation. The order was already saved to the database at this point, so the compensation changes its status rather than deleting it. Never delete records to compensate. Status transitions create an audit trail. Deletions destroy it.

**What happens if the order service crashes between step 2 and step 3.** The inventory is reserved but the cart has not been cleared and the `OrderCreated` event has not been published. When the service restarts, there is no mechanism to resume. This is the durability gap in the hand-written saga. Be ready to name it and describe the fix: a periodic reconciliation job that finds orders in `pending` or `inventory_reserved` state older than a threshold and either resumes or compensates them.

**The state machine expressed in the status constants.** The constants `StatusPending`, `StatusInventoryReserved`, `StatusPaymentPending`, `StatusPaid`, `StatusCanceled` define the valid states. `CancelOrder` enforces that only orders in certain states can be canceled. This is an explicit state machine. In an interview, drawing this state machine as a diagram before writing any code demonstrates senior-level design thinking.

### Senior @ FAANG: Saga Durability, Temporal, and the Operational Cost of Hand-Written Orchestration

The `executeSaga` method in this file is the core of the order service's complexity. At production scale, the hand-written saga accumulates operational debt that is predictable and well-documented in the literature.

**The crash-recovery gap and its production cost.** If the order service crashes between `saveOrder` and `ReserveStock`, the order exists in `pending` state but inventory has not been reserved. A reconciliation job must find these orders and either resume or compensate. If the service crashes between `ReserveStock` and `publisher.Publish`, inventory is reserved but no `OrderCreated` event is emitted. The payment service never fires. The order sits in `inventory_reserved` indefinitely. Each of these crash windows requires a separate reconciliation path. In production, teams discover new windows during incidents, not during design reviews. The operational cost is a rotating on-call burden of "stuck order" tickets.

**Temporal as the architectural alternative.** Temporal externalizes saga state to a durable workflow history store. The `executeSaga` function becomes a Temporal workflow: each step is an activity, crash recovery is automatic (Temporal replays the workflow from the last recorded event), and retry policy is configured per activity rather than hand-coded. The code becomes shorter and the crash recovery problem disappears. The cost is operational: running a Temporal cluster, understanding Temporal's execution model, and training the team. For a checkout saga touching five or more services, this cost is almost always worth paying.

**Saga visibility as a first-class concern.** The current implementation has no way to answer "how many orders are currently in each saga state?" without a database query. At production scale, a Prometheus gauge for `orders_in_flight{status="inventory_reserved"}` is a required leading indicator. A spike in `inventory_reserved` orders with no corresponding `payment_pending` transition indicates that the payment service's Kafka consumer has stopped. This metric and its alert should be designed at the same time as the saga steps, not added after the first production incident.

**The `HandlePaymentFailed` compensation pattern.** When payment fails, `HandlePaymentFailed` calls `inventoryService.ReleaseStock`. If `ReleaseStock` also fails, the order is in `payment_failed` state but inventory is still reserved. A stuck reservation holds stock that other customers cannot buy. The production fix is a retry queue for compensation actions: if `ReleaseStock` fails, enqueue a retry with exponential backoff, and alert if the reservation has not been released within a configurable timeout. Compensation failures are more dangerous than forward-path failures because they cause resource leaks that are invisible to customers but visible in stock counts.

---
