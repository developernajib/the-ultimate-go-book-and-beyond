## 50.9 Exercises with Complete Solutions

These exercises build progressively from a choreography-based saga to a full orchestrator with persistence and crash recovery. Work through them in order. The first exercise establishes the event-driven foundation, and the second builds on that understanding by adding centralized coordination and state management.

### Junior -> FAANG: Getting Maximum Value from These Exercises

Exercises in a book chapter are easy to skip or to read passively. The engineers who get the most from exercises like these follow a specific discipline.

Before reading the solution, write out your own implementation. It does not need to compile. Write pseudocode if you prefer. The act of deciding "where does the compensation live" and "what is the idempotency key for this step" before seeing the answer reveals your current mental model gaps, which are exactly what you need to identify before an interview.

After reading the solution, find three things that differ from your implementation and understand why the solution made that choice. In Exercise 1, the `SagaEventConsumer` routes events based on `event.Type` using a switch statement. If you implemented it differently (perhaps with a map of handlers, or with each service subscribing independently), understand the trade-off: the switch statement couples all routing logic to a single component, which is simpler but makes it harder to add new services without modifying the consumer. A map of handlers is more extensible but requires careful initialization ordering.

The most common place candidates lose points in coding interviews is not algorithm correctness but missing edge cases. For Exercise 1, the edge cases are: what happens if `InventoryFailed` fires but the order was never in the local `orders` map (replay of an old event), and what happens if `PaymentFailed` fires after `PaymentProcessed` for the same order (duplicate event or out-of-order delivery), and what happens if `OrderCanceled` fires but no reservation exists (compensation of an order that never got past the order creation step). Write a test for each of these before submitting any saga implementation in a real codebase.

### Senior @ FAANG: Using Exercises to Evaluate Engineering Candidates

These exercises are calibrated to distinguish candidates at different seniority levels. Understanding what each level is expected to produce helps you evaluate candidates in take-home or pair-programming rounds.

A strong L4 (mid-level) candidate produces a correct solution that handles the happy path and the primary failure path, with appropriate error handling and structured logging. They miss some edge cases (out-of-order events, duplicate delivery) but can be coached to add them.

A strong L5 (senior) candidate produces a correct solution, handles all the edge cases identified above, adds context propagation for distributed tracing, and can explain why the transactional outbox is missing and what the failure mode is. They proactively mention idempotency without being prompted.

A strong L6 (staff) candidate produces the correct solution in less time because they have built sagas before, and spends the majority of their time on the design discussion: why choreography for this exercise but orchestration for a saga with more than four steps, what the production gaps in the provided solution are, and how they would structure the team to own this code going forward. They may propose replacing Exercise 2's hand-rolled orchestrator with a Temporal-based implementation and justify the trade-off.

For evaluating candidates on Exercise 2 specifically: the `RecoverIncomplete` method is the key differentiator. An L4 candidate writes the happy-path orchestrator but needs hints for recovery. An L5 candidate writes recovery correctly but uses a simple `updated_at < NOW() - INTERVAL '5 minutes'` query without considering that two orchestrator instances might claim the same saga. An L6 candidate immediately adds `FOR UPDATE SKIP LOCKED` to the recovery query and explains distributed locking before being asked.

---

### Exercise 1: Implement a Choreography-Based Order Saga

**Challenge:** Build a complete order processing saga using Kafka events. The solution implements three services (order, inventory, payment) that communicate exclusively through domain events on a shared Kafka topic, with each service handling both its forward action and its compensation when it receives a cancellation event.

```go
// exercises/saga/choreography/solution/saga.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/IBM/sarama"
)

// Domain Events
type EventType string

const (
	OrderCreated       EventType = "order.created"
	InventoryReserved  EventType = "inventory.reserved"
	InventoryFailed    EventType = "inventory.failed"
	PaymentProcessed   EventType = "payment.processed"
	PaymentFailed      EventType = "payment.failed"
	OrderCompleted     EventType = "order.completed"
	OrderCanceled     EventType = "order.canceled"
)

// Event represents a domain event
type Event struct {
	ID            string          `json:"id"`
	Type          EventType       `json:"type"`
	CorrelationID string          `json:"correlation_id"`
	Timestamp     time.Time       `json:"timestamp"`
	Data          json.RawMessage `json:"data"`
}

// Order represents an order
type Order struct {
	ID          string      `json:"id"`
	CustomerID  string      `json:"customer_id"`
	Items       []OrderItem `json:"items"`
	TotalAmountCents int64  `json:"total_amount_cents"`
	Status      string      `json:"status"`
}

type OrderItem struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// InventoryReservation represents a reservation
type InventoryReservation struct {
	OrderID       string      `json:"order_id"`
	ReservationID string      `json:"reservation_id"`
	Items         []OrderItem `json:"items"`
}

// PaymentResult represents payment outcome
type PaymentResult struct {
	OrderID   string  `json:"order_id"`
	PaymentID string  `json:"payment_id"`
	AmountCents int64 `json:"amount_cents"`
	Status    string  `json:"status"`
}

// EventBus handles event publishing
type EventBus struct {
	producer sarama.SyncProducer
	topic    string
}

func NewEventBus(brokers []string, topic string) (*EventBus, error) {
	config := sarama.NewConfig()
	config.Producer.Return.Successes = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Retry.Max = 5

	producer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		return nil, err
	}

	return &EventBus{producer: producer, topic: topic}, nil
}

func (b *EventBus) Publish(ctx context.Context, event Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}

	msg := &sarama.ProducerMessage{
		Topic: b.topic,
		Key:   sarama.StringEncoder(event.CorrelationID),
		Value: sarama.ByteEncoder(data),
	}

	_, _, err = b.producer.SendMessage(msg)
	return err
}

// OrderService handles order creation
type OrderService struct {
	eventBus *EventBus
	orders   map[string]*Order
	logger   *slog.Logger
}

func NewOrderService(eventBus *EventBus) *OrderService {
	return &OrderService{
		eventBus: eventBus,
		orders:   make(map[string]*Order),
		logger:   slog.Default(),
	}
}

func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
	order.ID = uuid.New().String()
	order.Status = "pending"
	s.orders[order.ID] = order

	orderData, _ := json.Marshal(order)
	event := Event{
		ID:            uuid.New().String(),
		Type:          OrderCreated,
		CorrelationID: order.ID,
		Timestamp:     time.Now(),
		Data:          orderData,
	}

	s.logger.Info("order created", "orderId", order.ID)
	return s.eventBus.Publish(ctx, event)
}

func (s *OrderService) HandleInventoryReserved(ctx context.Context, event Event) error {
	var reservation InventoryReservation
	if err := json.Unmarshal(event.Data, &reservation); err != nil {
		return err
	}

	if order, ok := s.orders[reservation.OrderID]; ok {
		order.Status = "inventory_reserved"
		s.logger.Info("order inventory reserved", "orderId", order.ID)
	}
	return nil
}

func (s *OrderService) HandlePaymentProcessed(ctx context.Context, event Event) error {
	var payment PaymentResult
	if err := json.Unmarshal(event.Data, &payment); err != nil {
		return err
	}

	if order, ok := s.orders[payment.OrderID]; ok {
		order.Status = "completed"
		s.logger.Info("order completed", "orderId", order.ID)

		// Publish order completed event
		orderData, _ := json.Marshal(order)
		return s.eventBus.Publish(ctx, Event{
			ID:            uuid.New().String(),
			Type:          OrderCompleted,
			CorrelationID: order.ID,
			Timestamp:     time.Now(),
			Data:          orderData,
		})
	}
	return nil
}

func (s *OrderService) HandlePaymentFailed(ctx context.Context, event Event) error {
	var payment PaymentResult
	if err := json.Unmarshal(event.Data, &payment); err != nil {
		return err
	}

	if order, ok := s.orders[payment.OrderID]; ok {
		order.Status = "canceled"
		s.logger.Info("order canceled due to payment failure", "orderId", order.ID)

		// Publish order canceled event (triggers inventory release)
		orderData, _ := json.Marshal(order)
		return s.eventBus.Publish(ctx, Event{
			ID:            uuid.New().String(),
			Type:          OrderCanceled,
			CorrelationID: order.ID,
			Timestamp:     time.Now(),
			Data:          orderData,
		})
	}
	return nil
}

// InventoryService handles inventory operations
type InventoryService struct {
	eventBus     *EventBus
	inventory    map[string]int
	reservations map[string]InventoryReservation
	logger       *slog.Logger
}

func NewInventoryService(eventBus *EventBus) *InventoryService {
	return &InventoryService{
		eventBus: eventBus,
		inventory: map[string]int{
			"PROD-001": 100,
			"PROD-002": 50,
			"PROD-003": 200,
		},
		reservations: make(map[string]InventoryReservation),
		logger:       slog.Default(),
	}
}

func (s *InventoryService) HandleOrderCreated(ctx context.Context, event Event) error {
	var order Order
	if err := json.Unmarshal(event.Data, &order); err != nil {
		return err
	}

	// Check and reserve inventory
	for _, item := range order.Items {
		available, ok := s.inventory[item.ProductID]
		if !ok || available < item.Quantity {
			// Inventory not available
			failData, _ := json.Marshal(map[string]string{
				"order_id": order.ID,
				"reason":   fmt.Sprintf("insufficient inventory for %s", item.ProductID),
			})
			return s.eventBus.Publish(ctx, Event{
				ID:            uuid.New().String(),
				Type:          InventoryFailed,
				CorrelationID: order.ID,
				Timestamp:     time.Now(),
				Data:          failData,
			})
		}
	}

	// Reserve inventory
	reservation := InventoryReservation{
		OrderID:       order.ID,
		ReservationID: uuid.New().String(),
		Items:         order.Items,
	}

	for _, item := range order.Items {
		s.inventory[item.ProductID] -= item.Quantity
	}
	s.reservations[reservation.ReservationID] = reservation

	reservationData, _ := json.Marshal(reservation)
	s.logger.Info("inventory reserved", "orderId", order.ID, "reservationId", reservation.ReservationID)

	return s.eventBus.Publish(ctx, Event{
		ID:            uuid.New().String(),
		Type:          InventoryReserved,
		CorrelationID: order.ID,
		Timestamp:     time.Now(),
		Data:          reservationData,
	})
}

func (s *InventoryService) HandleOrderCanceled(ctx context.Context, event Event) error {
	var order Order
	if err := json.Unmarshal(event.Data, &order); err != nil {
		return err
	}

	// Find and release reservation
	for id, res := range s.reservations {
		if res.OrderID == order.ID {
			for _, item := range res.Items {
				s.inventory[item.ProductID] += item.Quantity
			}
			delete(s.reservations, id)
			s.logger.Info("inventory released", "orderId", order.ID)
			break
		}
	}

	return nil
}

// PaymentService handles payment processing
type PaymentService struct {
	eventBus *EventBus
	payments map[string]PaymentResult
	logger   *slog.Logger
}

func NewPaymentService(eventBus *EventBus) *PaymentService {
	return &PaymentService{
		eventBus: eventBus,
		payments: make(map[string]PaymentResult),
		logger:   slog.Default(),
	}
}

func (s *PaymentService) HandleInventoryReserved(ctx context.Context, event Event) error {
	var reservation InventoryReservation
	if err := json.Unmarshal(event.Data, &reservation); err != nil {
		return err
	}

	// Calculate total (simplified)
	var totalCents int64
	for _, item := range reservation.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
	}

	// Simulate payment processing (90% success rate)
	payment := PaymentResult{
		OrderID:   reservation.OrderID,
		PaymentID: uuid.New().String(),
		AmountCents: totalCents,
	}

	// Simulate occasional payment failure
	if time.Now().UnixNano()%10 == 0 {
		payment.Status = "failed"
		paymentData, _ := json.Marshal(payment)
		s.logger.Info("payment failed", "orderId", payment.OrderID)
		return s.eventBus.Publish(ctx, Event{
			ID:            uuid.New().String(),
			Type:          PaymentFailed,
			CorrelationID: reservation.OrderID,
			Timestamp:     time.Now(),
			Data:          paymentData,
		})
	}

	payment.Status = "success"
	s.payments[payment.PaymentID] = payment

	paymentData, _ := json.Marshal(payment)
	s.logger.Info("payment processed", "orderId", payment.OrderID, "paymentId", payment.PaymentID)

	return s.eventBus.Publish(ctx, Event{
		ID:            uuid.New().String(),
		Type:          PaymentProcessed,
		CorrelationID: reservation.OrderID,
		Timestamp:     time.Now(),
		Data:          paymentData,
	})
}

func (s *PaymentService) HandleOrderCanceled(ctx context.Context, event Event) error {
	var order Order
	if err := json.Unmarshal(event.Data, &order); err != nil {
		return err
	}

	// Refund payment if exists
	for id, payment := range s.payments {
		if payment.OrderID == order.ID && payment.Status == "success" {
			s.payments[id] = PaymentResult{
				OrderID:   payment.OrderID,
				PaymentID: payment.PaymentID,
				AmountCents: payment.AmountCents,
				Status:    "refunded",
			}
			s.logger.Info("payment refunded", "orderId", order.ID)
			break
		}
	}

	return nil
}

// SagaEventConsumer consumes events and routes to handlers
type SagaEventConsumer struct {
	consumer        sarama.ConsumerGroup
	orderService    *OrderService
	inventoryService *InventoryService
	paymentService  *PaymentService
	logger          *slog.Logger
}

func NewSagaEventConsumer(
	brokers []string,
	groupID string,
	orderSvc *OrderService,
	inventorySvc *InventoryService,
	paymentSvc *PaymentService,
) (*SagaEventConsumer, error) {
	config := sarama.NewConfig()
	config.Consumer.Group.Rebalance.Strategy = sarama.BalanceStrategyRoundRobin
	config.Consumer.Offsets.Initial = sarama.OffsetNewest

	consumer, err := sarama.NewConsumerGroup(brokers, groupID, config)
	if err != nil {
		return nil, err
	}

	return &SagaEventConsumer{
		consumer:         consumer,
		orderService:     orderSvc,
		inventoryService: inventorySvc,
		paymentService:   paymentSvc,
		logger:           slog.Default(),
	}, nil
}

func (c *SagaEventConsumer) Setup(_ sarama.ConsumerGroupSession) error   { return nil }
func (c *SagaEventConsumer) Cleanup(_ sarama.ConsumerGroupSession) error { return nil }

func (c *SagaEventConsumer) ConsumeClaim(session sarama.ConsumerGroupSession, claim sarama.ConsumerGroupClaim) error {
	for msg := range claim.Messages() {
		var event Event
		if err := json.Unmarshal(msg.Value, &event); err != nil {
			c.logger.Error("failed to unmarshal event", "error", err)
			continue
		}

		ctx := context.Background()

		switch event.Type {
		case OrderCreated:
			c.inventoryService.HandleOrderCreated(ctx, event)
		case InventoryReserved:
			c.orderService.HandleInventoryReserved(ctx, event)
			c.paymentService.HandleInventoryReserved(ctx, event)
		case InventoryFailed:
			// Order service handles inventory failure
		case PaymentProcessed:
			c.orderService.HandlePaymentProcessed(ctx, event)
		case PaymentFailed:
			c.orderService.HandlePaymentFailed(ctx, event)
		case OrderCanceled:
			c.inventoryService.HandleOrderCanceled(ctx, event)
			c.paymentService.HandleOrderCanceled(ctx, event)
		}

		session.MarkMessage(msg, "")
	}
	return nil
}

func (c *SagaEventConsumer) Start(ctx context.Context, topics []string) error {
	return c.consumer.Consume(ctx, topics, c)
}

func main() {
	brokers := []string{"localhost:9092"}
	topic := "saga-events"

	eventBus, err := NewEventBus(brokers, topic)
	if err != nil {
		slog.Error("failed to create event bus", "error", err)
		os.Exit(1)
	}

	orderSvc := NewOrderService(eventBus)
	inventorySvc := NewInventoryService(eventBus)
	paymentSvc := NewPaymentService(eventBus)

	consumer, err := NewSagaEventConsumer(brokers, "saga-consumer", orderSvc, inventorySvc, paymentSvc)
	if err != nil {
		slog.Error("failed to create consumer", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())

	// Start consumer in background
	go func() {
		for {
			if err := consumer.Start(ctx, []string{topic}); err != nil {
				slog.Error("consumer error", "error", err)
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()

	// Create a test order
	time.Sleep(2 * time.Second)

	testOrder := &Order{
		CustomerID: "CUST-001",
		Items: []OrderItem{
			{ProductID: "PROD-001", Quantity: 2, PriceCents: 2999},
			{ProductID: "PROD-002", Quantity: 1, PriceCents: 4999},
		},
		TotalAmountCents: 10997,
	}

	if err := orderSvc.CreateOrder(ctx, testOrder); err != nil {
		slog.Error("failed to create order", "error", err)
	}

	// Wait for interrupt
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	cancel()
	slog.Info("shutting down")
}
```

### Exercise 2: Build a Saga Orchestrator with Persistence

**Challenge:** Create a saga orchestrator that persists state for crash recovery. The orchestrator stores saga state in PostgreSQL before and after each step, uses upsert semantics for idempotent writes, and provides a `RecoverIncomplete` method that queries for stale sagas on startup and resumes or compensates them based on their persisted status.

```go
// exercises/saga/orchestrator/solution/orchestrator.go
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	_ "github.com/lib/pq"
)

// SagaDefinition defines a saga's steps
type SagaDefinition struct {
	Name  string
	Steps []StepDefinition
}

type StepDefinition struct {
	Name           string
	Execute        func(ctx context.Context, data map[string]any) (map[string]any, error)
	Compensate     func(ctx context.Context, data map[string]any) error
	TimeoutSeconds int
	MaxRetries     int
}

// SagaExecution represents a saga instance
type SagaExecution struct {
	ID             string                 `json:"id"`
	DefinitionName string                 `json:"definition_name"`
	Status         string                 `json:"status"` // running, completed, compensating, compensated, failed
	CurrentStep    int                    `json:"current_step"`
	StepResults    map[string]any `json:"step_results"`
	Error          string                 `json:"error,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
}

// SagaOrchestrator manages saga execution
type SagaOrchestrator struct {
	db          *sql.DB
	definitions map[string]*SagaDefinition
	logger      *slog.Logger
}

func NewSagaOrchestrator(db *sql.DB) *SagaOrchestrator {
	return &SagaOrchestrator{
		db:          db,
		definitions: make(map[string]*SagaDefinition),
		logger:      slog.Default(),
	}
}

// RegisterSaga registers a saga definition
func (o *SagaOrchestrator) RegisterSaga(def *SagaDefinition) {
	o.definitions[def.Name] = def
}

// StartSaga begins a new saga execution
func (o *SagaOrchestrator) StartSaga(ctx context.Context, definitionName string, input map[string]any) (string, error) {
	def, ok := o.definitions[definitionName]
	if !ok {
		return "", fmt.Errorf("saga definition not found: %s", definitionName)
	}

	execution := &SagaExecution{
		ID:             uuid.New().String(),
		DefinitionName: definitionName,
		Status:         "running",
		CurrentStep:    0,
		StepResults:    map[string]any{"input": input},
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := o.persistExecution(ctx, execution); err != nil {
		return "", fmt.Errorf("persist saga: %w", err)
	}

	go o.executeSaga(context.Background(), execution, def)

	return execution.ID, nil
}

// executeSaga runs the saga steps
func (o *SagaOrchestrator) executeSaga(ctx context.Context, execution *SagaExecution, def *SagaDefinition) {
	o.logger.Info("starting saga execution", "sagaId", execution.ID, "definition", def.Name)

	for i := execution.CurrentStep; i < len(def.Steps); i++ {
		step := def.Steps[i]
		execution.CurrentStep = i

		// Create step context with timeout
		stepCtx := ctx
		if step.TimeoutSeconds > 0 {
			var cancel context.CancelFunc
			stepCtx, cancel = context.WithTimeout(ctx, time.Duration(step.TimeoutSeconds)*time.Second)
			defer cancel()
		}

		// Execute step with retries
		var result map[string]any
		var err error

		maxRetries := step.MaxRetries
		if maxRetries == 0 {
			maxRetries = 3
		}

		for attempt := 1; attempt <= maxRetries; attempt++ {
			result, err = step.Execute(stepCtx, execution.StepResults)
			if err == nil {
				break
			}

			o.logger.Warn("step attempt failed",
				"sagaId", execution.ID,
				"step", step.Name,
				"attempt", attempt,
				"error", err,
			)

			if attempt < maxRetries {
				time.Sleep(time.Duration(attempt) * time.Second)
			}
		}

		if err != nil {
			execution.Status = "compensating"
			execution.Error = err.Error()
			o.persistExecution(ctx, execution)

			o.logger.Error("step failed, starting compensation",
				"sagaId", execution.ID,
				"step", step.Name,
				"error", err,
			)

			o.compensateSaga(ctx, execution, def, i-1)
			return
		}

		// Store step result
		for k, v := range result {
			execution.StepResults[k] = v
		}
		execution.UpdatedAt = time.Now()

		if err := o.persistExecution(ctx, execution); err != nil {
			o.logger.Error("failed to persist step result", "error", err)
		}

		o.logger.Info("step completed",
			"sagaId", execution.ID,
			"step", step.Name,
		)
	}

	execution.Status = "completed"
	execution.UpdatedAt = time.Now()
	o.persistExecution(ctx, execution)

	o.logger.Info("saga completed successfully", "sagaId", execution.ID)
}

// compensateSaga executes compensations in reverse
func (o *SagaOrchestrator) compensateSaga(ctx context.Context, execution *SagaExecution, def *SagaDefinition, fromStep int) {
	o.logger.Info("starting compensation", "sagaId", execution.ID, "fromStep", fromStep)

	for i := fromStep; i >= 0; i-- {
		step := def.Steps[i]

		if step.Compensate == nil {
			continue
		}

		// Retry compensation
		for attempt := 1; attempt <= 5; attempt++ {
			err := step.Compensate(ctx, execution.StepResults)
			if err == nil {
				o.logger.Info("compensation completed",
					"sagaId", execution.ID,
					"step", step.Name,
				)
				break
			}

			o.logger.Error("compensation attempt failed",
				"sagaId", execution.ID,
				"step", step.Name,
				"attempt", attempt,
				"error", err,
			)

			if attempt == 5 {
				// Compensation failed - need manual intervention
				execution.Status = "failed"
				execution.Error = fmt.Sprintf("compensation failed for step %s: %v", step.Name, err)
				o.persistExecution(ctx, execution)
				return
			}

			time.Sleep(time.Duration(attempt*attempt) * time.Second)
		}
	}

	execution.Status = "compensated"
	execution.UpdatedAt = time.Now()
	o.persistExecution(ctx, execution)

	o.logger.Info("saga compensation completed", "sagaId", execution.ID)
}

// persistExecution saves saga state to database
func (o *SagaOrchestrator) persistExecution(ctx context.Context, execution *SagaExecution) error {
	resultsJSON, err := json.Marshal(execution.StepResults)
	if err != nil {
		return err
	}

	_, err = o.db.ExecContext(ctx, `
		INSERT INTO saga_executions (id, definition_name, status, current_step, step_results, error, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE SET
			status = EXCLUDED.status,
			current_step = EXCLUDED.current_step,
			step_results = EXCLUDED.step_results,
			error = EXCLUDED.error,
			updated_at = EXCLUDED.updated_at
	`, execution.ID, execution.DefinitionName, execution.Status, execution.CurrentStep,
		resultsJSON, execution.Error, execution.CreatedAt, execution.UpdatedAt)

	return err
}

// RecoverIncomplete finds and resumes incomplete sagas
func (o *SagaOrchestrator) RecoverIncomplete(ctx context.Context) error {
	rows, err := o.db.QueryContext(ctx, `
		SELECT id, definition_name, status, current_step, step_results, error, created_at, updated_at
		FROM saga_executions
		WHERE status IN ('running', 'compensating')
		AND updated_at < NOW() - INTERVAL '5 minutes'
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var execution SagaExecution
		var resultsJSON []byte

		err := rows.Scan(
			&execution.ID,
			&execution.DefinitionName,
			&execution.Status,
			&execution.CurrentStep,
			&resultsJSON,
			&execution.Error,
			&execution.CreatedAt,
			&execution.UpdatedAt,
		)
		if err != nil {
			continue
		}

		if err := json.Unmarshal(resultsJSON, &execution.StepResults); err != nil {
			continue
		}

		def, ok := o.definitions[execution.DefinitionName]
		if !ok {
			continue
		}

		o.logger.Info("recovering saga", "sagaId", execution.ID, "status", execution.Status)

		if execution.Status == "compensating" {
			go o.compensateSaga(ctx, &execution, def, execution.CurrentStep)
		} else {
			go o.executeSaga(ctx, &execution, def)
		}
	}

	return nil
}

// GetSagaStatus retrieves saga execution status
func (o *SagaOrchestrator) GetSagaStatus(ctx context.Context, sagaID string) (*SagaExecution, error) {
	var execution SagaExecution
	var resultsJSON []byte

	err := o.db.QueryRowContext(ctx, `
		SELECT id, definition_name, status, current_step, step_results, error, created_at, updated_at
		FROM saga_executions WHERE id = $1
	`, sagaID).Scan(
		&execution.ID,
		&execution.DefinitionName,
		&execution.Status,
		&execution.CurrentStep,
		&resultsJSON,
		&execution.Error,
		&execution.CreatedAt,
		&execution.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	if err := json.Unmarshal(resultsJSON, &execution.StepResults); err != nil {
		return nil, err
	}

	return &execution, nil
}

// Example: Order Processing Saga Definition
func CreateOrderProcessingSaga(
	orderClient OrderClient,
	inventoryClient InventoryClient,
	paymentClient PaymentClient,
) *SagaDefinition {
	return &SagaDefinition{
		Name: "order_processing",
		Steps: []StepDefinition{
			{
				Name: "create_order",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					input := data["input"].(map[string]any)
					orderID, err := orderClient.CreateOrder(ctx, input)
					if err != nil {
						return nil, err
					}
					return map[string]any{"order_id": orderID}, nil
				},
				Compensate: func(ctx context.Context, data map[string]any) error {
					orderID := data["order_id"].(string)
					return orderClient.CancelOrder(ctx, orderID)
				},
				TimeoutSeconds: 30,
				MaxRetries:     3,
			},
			{
				Name: "reserve_inventory",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					orderID := data["order_id"].(string)
					input := data["input"].(map[string]any)
					items := input["items"].([]any)

					reservationID, err := inventoryClient.Reserve(ctx, orderID, items)
					if err != nil {
						return nil, err
					}
					return map[string]any{"reservation_id": reservationID}, nil
				},
				Compensate: func(ctx context.Context, data map[string]any) error {
					reservationID := data["reservation_id"].(string)
					return inventoryClient.Release(ctx, reservationID)
				},
				TimeoutSeconds: 30,
				MaxRetries:     5,
			},
			{
				Name: "process_payment",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					orderID := data["order_id"].(string)
					input := data["input"].(map[string]any)
					// JSON round-trips numbers as float64, so convert the
					// wire value back to integer cents at the boundary.
					amountCents := int64(input["amount_cents"].(float64))

					paymentID, err := paymentClient.Charge(ctx, orderID, amountCents)
					if err != nil {
						return nil, err
					}
					return map[string]any{"payment_id": paymentID}, nil
				},
				Compensate: func(ctx context.Context, data map[string]any) error {
					paymentID := data["payment_id"].(string)
					return paymentClient.Refund(ctx, paymentID)
				},
				TimeoutSeconds: 60,
				MaxRetries:     3,
			},
			{
				Name: "confirm_order",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					orderID := data["order_id"].(string)
					paymentID := data["payment_id"].(string)
					return nil, orderClient.ConfirmOrder(ctx, orderID, paymentID)
				},
				Compensate: nil, // Final step, no compensation
				TimeoutSeconds: 30,
				MaxRetries:     3,
			},
		},
	}
}

// Client interfaces
type OrderClient interface {
	CreateOrder(ctx context.Context, input map[string]any) (string, error)
	CancelOrder(ctx context.Context, orderID string) error
	ConfirmOrder(ctx context.Context, orderID, paymentID string) error
}

type InventoryClient interface {
	Reserve(ctx context.Context, orderID string, items []any) (string, error)
	Release(ctx context.Context, reservationID string) error
}

type PaymentClient interface {
	Charge(ctx context.Context, orderID string, amountCents int64) (string, error)
	Refund(ctx context.Context, paymentID string) error
}

func main() {
	// Database connection
	db, err := sql.Open("postgres", "postgres://user:pass@localhost/sagas?sslmode=disable")
	if err != nil {
		slog.Error("failed to connect to database", "error", err)
		return
	}
	defer db.Close()

	// Create schema
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS saga_executions (
			id TEXT PRIMARY KEY,
			definition_name TEXT NOT NULL,
			status TEXT NOT NULL,
			current_step INTEGER NOT NULL,
			step_results JSONB NOT NULL,
			error TEXT,
			created_at TIMESTAMP NOT NULL,
			updated_at TIMESTAMP NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_saga_status ON saga_executions(status);
		CREATE INDEX IF NOT EXISTS idx_saga_updated ON saga_executions(updated_at);
	`)
	if err != nil {
		slog.Error("failed to create schema", "error", err)
		return
	}

	// Create orchestrator
	orchestrator := NewSagaOrchestrator(db)

	// Register saga definition (with mock clients for demo)
	// In production, these would be real gRPC/HTTP clients
	orchestrator.RegisterSaga(&SagaDefinition{
		Name: "demo_saga",
		Steps: []StepDefinition{
			{
				Name: "step1",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					slog.Info("executing step 1")
					return map[string]any{"step1_result": "done"}, nil
				},
				Compensate: func(ctx context.Context, data map[string]any) error {
					slog.Info("compensating step 1")
					return nil
				},
			},
			{
				Name: "step2",
				Execute: func(ctx context.Context, data map[string]any) (map[string]any, error) {
					slog.Info("executing step 2")
					return map[string]any{"step2_result": "done"}, nil
				},
				Compensate: func(ctx context.Context, data map[string]any) error {
					slog.Info("compensating step 2")
					return nil
				},
			},
		},
	})

	// Recover any incomplete sagas from previous runs
	if err := orchestrator.RecoverIncomplete(context.Background()); err != nil {
		slog.Error("failed to recover incomplete sagas", "error", err)
	}

	// Start a new saga
	sagaID, err := orchestrator.StartSaga(context.Background(), "demo_saga", map[string]any{
		"user_id": "user-123",
		"amount":  99.99,
	})
	if err != nil {
		slog.Error("failed to start saga", "error", err)
		return
	}

	slog.Info("saga started", "sagaId", sagaID)

	// Wait and check status
	time.Sleep(3 * time.Second)

	status, err := orchestrator.GetSagaStatus(context.Background(), sagaID)
	if err != nil {
		slog.Error("failed to get status", "error", err)
		return
	}

	slog.Info("saga status", "status", status.Status, "results", status.StepResults)
}
```

---
