## 90D.5 Saga Pattern: Distributed Transactions

The Saga pattern coordinates a multi-step business transaction across independent services without a two-phase commit. Each step in the saga executes a local transaction, and if any step fails, the orchestrator runs compensating transactions in reverse order to undo the preceding steps. This makes the overall process eventually consistent without holding distributed locks. The orchestrator below is step-agnostic: you supply a slice of `SagaStep` values each with a `Transaction` function and a `Compensation` function, and the orchestrator handles the LIFO rollback on failure automatically. The `OrderFulfillmentSaga` shows a complete real-world example covering inventory reservation, payment charging, shipment creation, and customer notification.

```go
package saga

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
)

// SagaStep is one step in a saga with a transaction and compensation
type SagaStep struct {
	Name         string
	Transaction  func(ctx context.Context, state *SagaState) error
	Compensation func(ctx context.Context, state *SagaState) error
}

// SagaState carries shared state across saga steps
type SagaState struct {
	mu   sync.Mutex
	data map[string]any
}

func NewSagaState() *SagaState {
	return &SagaState{data: make(map[string]any)}
}

func (s *SagaState) Set(key string, value any) {
	s.mu.Lock()
	s.data[key] = value
	s.mu.Unlock()
}

func (s *SagaState) Get(key string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// Orchestrator executes a saga with automatic compensation on failure
type Orchestrator struct {
	logger *slog.Logger
}

func NewOrchestrator() *Orchestrator {
	return &Orchestrator{logger: slog.Default()}
}

// Execute runs a saga - compensates in reverse order on any failure
func (o *Orchestrator) Execute(ctx context.Context, steps []SagaStep, state *SagaState) error {
	var completed []SagaStep

	for _, step := range steps {
		o.logger.Info("saga step", "step", step.Name)

		if err := step.Transaction(ctx, state); err != nil {
			o.logger.Error("saga step failed, compensating",
				"step", step.Name, "error", err)

			// Compensate in reverse order (LIFO)
			for i := len(completed) - 1; i >= 0; i-- {
				compensated := completed[i]
				if compensated.Compensation == nil {
					continue
				}
				o.logger.Info("compensating step", "step", compensated.Name)
				if compErr := compensated.Compensation(ctx, state); compErr != nil {
					o.logger.Error("compensation failed",
						"step", compensated.Name, "error", compErr)
					// Log but continue compensating remaining steps
				}
			}

			return fmt.Errorf("saga failed at step '%s': %w", step.Name, err)
		}

		completed = append(completed, step)
	}

	return nil
}

// ─── Order Fulfillment Saga ───

type OrderFulfillmentSaga struct {
	inventory InventoryService
	payment   PaymentService
	shipping  ShippingService
	notifier  NotificationService
	logger    *slog.Logger
}

type InventoryService interface {
	Reserve(ctx context.Context, productID string, qty int) (string, error)
	Release(ctx context.Context, reservationID string) error
}

type PaymentService interface {
	Charge(ctx context.Context, orderID string, amount int64) (string, error)
	Refund(ctx context.Context, paymentID string) error
}

type ShippingService interface {
	CreateShipment(ctx context.Context, orderID string) (string, error)
	CancelShipment(ctx context.Context, shipmentID string) error
}

type NotificationService interface {
	NotifyCustomer(ctx context.Context, customerID, message string) error
}

type FulfillmentRequest struct {
	OrderID    string
	CustomerID string
	ProductID  string
	Quantity   int
	Amount     int64
}

func NewOrderFulfillmentSaga(
	inventory InventoryService,
	payment PaymentService,
	shipping ShippingService,
	notifier NotificationService,
) *OrderFulfillmentSaga {
	return &OrderFulfillmentSaga{
		inventory: inventory,
		payment:   payment,
		shipping:  shipping,
		notifier:  notifier,
		logger:    slog.Default(),
	}
}

func (s *OrderFulfillmentSaga) Execute(ctx context.Context, req FulfillmentRequest) error {
	state := NewSagaState()
	state.Set("request", req)

	orchestrator := NewOrchestrator()
	return orchestrator.Execute(ctx, []SagaStep{
		{
			Name: "reserve-inventory",
			Transaction: func(ctx context.Context, st *SagaState) error {
				reservationID, err := s.inventory.Reserve(ctx, req.ProductID, req.Quantity)
				if err != nil {
					return fmt.Errorf("reserve inventory: %w", err)
				}
				st.Set("reservation_id", reservationID)
				return nil
			},
			Compensation: func(ctx context.Context, st *SagaState) error {
				resID, _ := st.Get("reservation_id")
				return s.inventory.Release(ctx, resID.(string))
			},
		},
		{
			Name: "charge-payment",
			Transaction: func(ctx context.Context, st *SagaState) error {
				paymentID, err := s.payment.Charge(ctx, req.OrderID, req.Amount)
				if err != nil {
					return fmt.Errorf("charge payment: %w", err)
				}
				st.Set("payment_id", paymentID)
				return nil
			},
			Compensation: func(ctx context.Context, st *SagaState) error {
				payID, _ := st.Get("payment_id")
				return s.payment.Refund(ctx, payID.(string))
			},
		},
		{
			Name: "create-shipment",
			Transaction: func(ctx context.Context, st *SagaState) error {
				shipmentID, err := s.shipping.CreateShipment(ctx, req.OrderID)
				if err != nil {
					return fmt.Errorf("create shipment: %w", err)
				}
				st.Set("shipment_id", shipmentID)
				return nil
			},
			Compensation: func(ctx context.Context, st *SagaState) error {
				shipID, _ := st.Get("shipment_id")
				return s.shipping.CancelShipment(ctx, shipID.(string))
			},
		},
		{
			Name: "notify-customer",
			Transaction: func(ctx context.Context, st *SagaState) error {
				return s.notifier.NotifyCustomer(ctx, req.CustomerID,
					fmt.Sprintf("Your order %s has been confirmed!", req.OrderID))
			},
			Compensation: nil, // No compensation needed for notifications
		},
	}, state)
}
```

---
