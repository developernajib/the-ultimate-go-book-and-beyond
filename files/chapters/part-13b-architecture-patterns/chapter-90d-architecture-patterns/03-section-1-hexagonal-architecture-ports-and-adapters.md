## 90D.2 Hexagonal Architecture (Ports and Adapters)

Hexagonal architecture (also called Ports and Adapters) keeps the domain layer at the center, completely free of infrastructure dependencies. The domain defines interfaces (called ports) that describe what it needs from the outside world, and infrastructure code (databases, HTTP clients, message brokers) provides implementations of those interfaces (called adapters). In Go this maps naturally to interface types defined alongside the domain structs and concrete implementations living in separate packages. The code below shows a complete order domain with a pure `Order` aggregate, primary and secondary ports as interfaces, and an `OrderService` application layer that wires them together through constructor injection.

```go
package hexagonal

import (
	"context"
	"time"
)

// ─── Domain Layer (pure Go, no imports from infrastructure) ───

// Order is a domain entity - pure business logic
type Order struct {
	ID         string
	CustomerID string
	Items      []OrderItem
	Status     OrderStatus
	Total      Money
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type OrderItem struct {
	ProductID string
	Quantity  int
	Price     Money
}

type Money struct {
	Amount   int64  // cents
	Currency string
}

func (m Money) Add(other Money) Money {
	return Money{Amount: m.Amount + other.Amount, Currency: m.Currency}
}

type OrderStatus string

const (
	StatusPending   OrderStatus = "pending"
	StatusConfirmed OrderStatus = "confirmed"
	StatusShipped   OrderStatus = "shipped"
	StatusCanceled OrderStatus = "canceled"
)

// Domain errors
type DomainError struct{ msg string }

func (e DomainError) Error() string { return e.msg }

var (
	ErrOrderNotFound   = DomainError{"order not found"}
	ErrInvalidStatus   = DomainError{"invalid status transition"}
	ErrInsufficientStock = DomainError{"insufficient stock"}
)

// Domain methods - business logic lives here, nowhere else
func (o *Order) Confirm() error {
	if o.Status != StatusPending {
		return ErrInvalidStatus
	}
	o.Status = StatusConfirmed
	o.UpdatedAt = time.Now()
	return nil
}

func (o *Order) Cancel() error {
	if o.Status == StatusShipped {
		return ErrInvalidStatus
	}
	o.Status = StatusCanceled
	o.UpdatedAt = time.Now()
	return nil
}

func (o *Order) CalculateTotal() Money {
	total := Money{Currency: "USD"}
	for _, item := range o.Items {
		total = total.Add(Money{
			Amount:   item.Price.Amount * int64(item.Quantity),
			Currency: item.Price.Currency,
		})
	}
	return total
}

// ─── Ports (interfaces defined by the domain) ───

// OrderRepository is a PRIMARY port (driving) - used by use cases
type OrderRepository interface {
	Save(ctx context.Context, order *Order) error
	FindByID(ctx context.Context, id string) (*Order, error)
	FindByCustomer(ctx context.Context, customerID string) ([]*Order, error)
	Delete(ctx context.Context, id string) error
}

// PaymentGateway is a SECONDARY port (driven) - domain calls infrastructure
type PaymentGateway interface {
	Charge(ctx context.Context, orderID string, amount Money) (*Payment, error)
	Refund(ctx context.Context, paymentID string) error
}

type Payment struct {
	ID       string
	OrderID  string
	Amount   Money
	Status   string
}

// EventPublisher is a secondary port for publishing domain events
type EventPublisher interface {
	Publish(ctx context.Context, event DomainEvent) error
}

type DomainEvent struct {
	Type      string
	Payload   any
	OccurredAt time.Time
}

// ─── Use Cases (Application Layer) ───

// OrderService orchestrates domain logic - depends only on ports
type OrderService struct {
	orders   OrderRepository
	payments PaymentGateway
	events   EventPublisher
}

func NewOrderService(
	orders OrderRepository,
	payments PaymentGateway,
	events EventPublisher,
) *OrderService {
	return &OrderService{
		orders:   orders,
		payments: payments,
		events:   events,
	}
}

type CreateOrderRequest struct {
	CustomerID string
	Items      []OrderItem
}

func (s *OrderService) CreateOrder(ctx context.Context, req CreateOrderRequest) (*Order, error) {
	order := &Order{
		ID:         generateID(),
		CustomerID: req.CustomerID,
		Items:      req.Items,
		Status:     StatusPending,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
	order.Total = order.CalculateTotal()

	if err := s.orders.Save(ctx, order); err != nil {
		return nil, err
	}

	s.events.Publish(ctx, DomainEvent{
		Type:      "OrderCreated",
		Payload:   order,
		OccurredAt: time.Now(),
	})

	return order, nil
}

func (s *OrderService) ConfirmOrder(ctx context.Context, orderID string) error {
	order, err := s.orders.FindByID(ctx, orderID)
	if err != nil {
		return err
	}

	// Charge payment
	payment, err := s.payments.Charge(ctx, orderID, order.Total)
	if err != nil {
		return err
	}
	_ = payment

	if err := order.Confirm(); err != nil {
		s.payments.Refund(ctx, payment.ID)
		return err
	}

	if err := s.orders.Save(ctx, order); err != nil {
		s.payments.Refund(ctx, payment.ID)
		return err
	}

	s.events.Publish(ctx, DomainEvent{
		Type:      "OrderConfirmed",
		Payload:   order,
		OccurredAt: time.Now(),
	})

	return nil
}

func generateID() string {
	return "ord-" + time.Now().Format("20060102150405.000")
}
```

---
