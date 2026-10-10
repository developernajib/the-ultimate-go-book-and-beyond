## 52F.10 Complete Example: Event-Driven Order Processing System

This section brings together the patterns from previous sections into a complete event-driven order processing system. The system uses four Kafka topics (orders, processed results, retry queue, and dead letter queue), exponential backoff retries, idempotent producers, and an HTTP metrics endpoint for Prometheus.

> **Client note:** this example uses `IBM/sarama` because its explicit producer/consumer-group API keeps each moving part visible. For a new production service follow this chapter's client guidance and prefer `twmb/franz-go` - the topic, retry, and idempotency patterns transfer unchanged.

```
┌──────────────────────────────────────────────────────────────────┐
│              Event-Driven Order Processing System                │
│                                                                  │
│  ┌──────────────┐    orders     ┌──────────────────────┐         │
│  │              │ ─────────────►│                      │         │
│  │ Order Service│               │   Kafka Cluster      │         │
│  │  (Producer)  │               │                      │         │
│  │              │               │  Topics:             │         │
│  └──────────────┘               │   • orders           │         │
│                                 │   • orders-processed │         │
│                                 │   • orders-dlq       │         │
│                                 │   • orders-retry     │         │
│                                 └──────┬───────────────┘         │
│                                        │                         │
│                    ┌───────────────────┬┘                        │
│                    ▼                   ▼                         │
│  ┌──────────────────────┐  ┌──────────────────────┐              │
│  │   Order Processor    │  │    DLQ Processor     │              │
│  │  (Consumer Group)    │  │   (Retry Handler)    │              │
│  │                      │  │                      │              │
│  │  • Validate order    │  │  • Exponential       │              │
│  │  • Check inventory   │  │    backoff           │              │
│  │  • Process payment   │  │  • Max retry count   │              │
│  │  • Emit result       │  │  • Alert on exhaust  │              │
│  └──────────────────────┘  └──────────────────────┘              │
│           │                         │                            │
│           ▼                         ▼                            │
│  ┌──────────────────────────────────────────────┐                │
│  │              Monitoring Dashboard            │                │
│  │  • Consumer lag    • Error rates             │                │
│  │  • Throughput      • DLQ depth               │                │
│  │  • Latency p50/p99 • Retry counts            │                │
│  └──────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────┘
```

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/IBM/sarama"
)

// --- Domain Models ---

// OrderStatus represents the processing state of an order.
type OrderStatus string

const (
	OrderStatusPending    OrderStatus = "pending"
	OrderStatusProcessing OrderStatus = "processing"
	OrderStatusCompleted  OrderStatus = "completed"
	OrderStatusFailed     OrderStatus = "failed"
	OrderStatusRetrying   OrderStatus = "retrying"
)

// Order represents a customer order.
type Order struct {
	ID               string      `json:"id"`
	CustomerID       string      `json:"customer_id"`
	Items            []OrderItem `json:"items"`
	TotalAmountCents int64       `json:"total_amount_cents"`
	Currency         string      `json:"currency"`
	Status           OrderStatus `json:"status"`
	CreatedAt        time.Time   `json:"created_at"`
	UpdatedAt        time.Time   `json:"updated_at"`
}

// OrderItem represents a single item in an order.
type OrderItem struct {
	ProductID  string `json:"product_id"`
	Name       string `json:"name"`
	Quantity   int    `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// OrderResult represents the outcome of processing an order.
type OrderResult struct {
	OrderID     string      `json:"order_id"`
	Status      OrderStatus `json:"status"`
	Message     string      `json:"message"`
	ProcessedAt time.Time   `json:"processed_at"`
	ProcessorID string      `json:"processor_id"`
}

// RetryMessage wraps an order with retry metadata.
type RetryMessage struct {
	Order       Order     `json:"order"`
	RetryCount  int       `json:"retry_count"`
	MaxRetries  int       `json:"max_retries"`
	LastError   string    `json:"last_error"`
	FirstFailAt time.Time `json:"first_fail_at"`
	NextRetryAt time.Time `json:"next_retry_at"`
}

// --- Topic Configuration ---

const (
	TopicOrders          = "orders"
	TopicOrdersProcessed = "orders-processed"
	TopicOrdersDLQ       = "orders-dlq"
	TopicOrdersRetry     = "orders-retry"
)

// --- Metrics ---

// SystemMetrics tracks system-wide processing statistics.
type SystemMetrics struct {
	OrdersReceived  atomic.Int64
	OrdersProcessed atomic.Int64
	OrdersFailed    atomic.Int64
	OrdersRetried   atomic.Int64
	OrdersDLQ       atomic.Int64
	ProcessingTime  atomic.Int64 // nanoseconds total
	processCount    atomic.Int64
}

// Snapshot returns a point-in-time copy of the metrics.
func (m *SystemMetrics) Snapshot() map[string]int64 {
	count := m.processCount.Load()
	var avgNs int64
	if count > 0 {
		avgNs = m.ProcessingTime.Load() / count
	}

	return map[string]int64{
		"orders_received":       m.OrdersReceived.Load(),
		"orders_processed":      m.OrdersProcessed.Load(),
		"orders_failed":         m.OrdersFailed.Load(),
		"orders_retried":        m.OrdersRetried.Load(),
		"orders_dlq":            m.OrdersDLQ.Load(),
		"avg_processing_time_ms": avgNs / int64(time.Millisecond),
	}
}

func (m *SystemMetrics) RecordProcessingTime(d time.Duration) {
	m.ProcessingTime.Add(int64(d))
	m.processCount.Add(1)
}

// --- Order Service (Producer) ---

// OrderService handles order creation and publishing to Kafka.
type OrderService struct {
	producer sarama.SyncProducer
	metrics  *SystemMetrics
	logger   *slog.Logger
}

// NewOrderService creates a new order service with a Kafka producer.
func NewOrderService(brokers []string, metrics *SystemMetrics, logger *slog.Logger) (*OrderService, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Producer.Return.Successes = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Idempotent = true
	config.Producer.Retry.Max = 5
	config.Producer.Retry.Backoff = 100 * time.Millisecond
	config.Net.MaxOpenRequests = 1
	config.Producer.Compression = sarama.CompressionSnappy

	producer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating producer: %w", err)
	}

	return &OrderService{
		producer: producer,
		metrics:  metrics,
		logger:   logger,
	}, nil
}

// CreateOrder validates and publishes an order to Kafka.
func (s *OrderService) CreateOrder(ctx context.Context, order Order) error {
	// Validate the order.
	if err := s.validateOrder(order); err != nil {
		return fmt.Errorf("order validation failed: %w", err)
	}

	// Set defaults.
	order.ID = uuid.New().String()
	order.Status = OrderStatusPending
	order.CreatedAt = time.Now()
	order.UpdatedAt = time.Now()

	// Calculate total.
	var totalCents int64
	for _, item := range order.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
	}
	order.TotalAmountCents = totalCents

	// Serialize and publish.
	value, err := json.Marshal(order)
	if err != nil {
		return fmt.Errorf("marshaling order: %w", err)
	}

	msg := &sarama.ProducerMessage{
		Topic: TopicOrders,
		Key:   sarama.StringEncoder(order.CustomerID),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{Key: []byte("event_type"), Value: []byte("order_created")},
			{Key: []byte("correlation_id"), Value: []byte(order.ID)},
		},
		Timestamp: time.Now(),
	}

	partition, offset, err := s.producer.SendMessage(msg)
	if err != nil {
		return fmt.Errorf("publishing order: %w", err)
	}

	s.metrics.OrdersReceived.Add(1)
	s.logger.Info("order published",
		"order_id", order.ID,
		"customer_id", order.CustomerID,
		"total_cents", order.TotalAmountCents,
		"partition", partition,
		"offset", offset,
	)

	return nil
}

func (s *OrderService) validateOrder(order Order) error {
	if order.CustomerID == "" {
		return errors.New("customer_id is required")
	}
	if len(order.Items) == 0 {
		return errors.New("at least one item is required")
	}
	for _, item := range order.Items {
		if item.ProductID == "" {
			return errors.New("product_id is required for all items")
		}
		if item.Quantity <= 0 {
			return errors.New("quantity must be positive")
		}
		if item.PriceCents < 0 {
			return errors.New("price cannot be negative")
		}
	}
	if order.Currency == "" {
		order.Currency = "USD"
	}
	return nil
}

// Close shuts down the producer.
func (s *OrderService) Close() error {
	return s.producer.Close()
}

// --- Order Processor (Consumer) ---

// OrderProcessor consumes and processes orders from Kafka.
type OrderProcessor struct {
	resultProducer sarama.SyncProducer
	retryProducer  sarama.SyncProducer
	metrics        *SystemMetrics
	logger         *slog.Logger
	processorID    string
	maxRetries     int
}

// NewOrderProcessor creates a new order processor.
func NewOrderProcessor(
	brokers []string,
	processorID string,
	metrics *SystemMetrics,
	logger *slog.Logger,
) (*OrderProcessor, error) {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0
	config.Producer.Return.Successes = true
	config.Producer.RequiredAcks = sarama.WaitForAll
	config.Producer.Idempotent = true
	config.Net.MaxOpenRequests = 1

	resultProducer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		return nil, fmt.Errorf("creating result producer: %w", err)
	}

	retryProducer, err := sarama.NewSyncProducer(brokers, config)
	if err != nil {
		resultProducer.Close()
		return nil, fmt.Errorf("creating retry producer: %w", err)
	}

	return &OrderProcessor{
		resultProducer: resultProducer,
		retryProducer:  retryProducer,
		metrics:        metrics,
		logger:         logger,
		processorID:    processorID,
		maxRetries:     5,
	}, nil
}

// Setup is called at the beginning of a new consumer group session.
func (p *OrderProcessor) Setup(session sarama.ConsumerGroupSession) error {
	p.logger.Info("processor session started",
		"processor_id", p.processorID,
		"member_id", session.MemberID(),
		"generation", session.GenerationID(),
	)
	return nil
}

// Cleanup is called at the end of a consumer group session.
func (p *OrderProcessor) Cleanup(session sarama.ConsumerGroupSession) error {
	p.logger.Info("processor session ended", "processor_id", p.processorID)
	return nil
}

// ConsumeClaim processes messages from a claimed partition.
func (p *OrderProcessor) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	for msg := range claim.Messages() {
		start := time.Now()

		if err := p.processOrder(msg); err != nil {
			p.logger.Error("order processing failed",
				"error", err,
				"offset", msg.Offset,
				"partition", msg.Partition,
			)
		}

		p.metrics.RecordProcessingTime(time.Since(start))
		session.MarkMessage(msg, "")
	}
	return nil
}

func (p *OrderProcessor) processOrder(msg *sarama.ConsumerMessage) error {
	var order Order
	if err := json.Unmarshal(msg.Value, &order); err != nil {
		// Malformed message: send to DLQ immediately (no retry).
		return p.sendToDLQ(order, fmt.Sprintf("unmarshal error: %v", err), 0)
	}

	p.logger.Info("processing order",
		"order_id", order.ID,
		"customer_id", order.CustomerID,
		"total_cents", order.TotalAmountCents,
	)

	// Step 1: Validate inventory.
	if err := p.checkInventory(order); err != nil {
		return p.handleProcessingError(order, err, 0)
	}

	// Step 2: Process payment.
	if err := p.processPayment(order); err != nil {
		return p.handleProcessingError(order, err, 0)
	}

	// Step 3: Reserve inventory.
	if err := p.reserveInventory(order); err != nil {
		return p.handleProcessingError(order, err, 0)
	}

	// Step 4: Emit success result.
	result := OrderResult{
		OrderID:     order.ID,
		Status:      OrderStatusCompleted,
		Message:     "order processed successfully",
		ProcessedAt: time.Now(),
		ProcessorID: p.processorID,
	}

	if err := p.emitResult(result); err != nil {
		return fmt.Errorf("emitting result: %w", err)
	}

	p.metrics.OrdersProcessed.Add(1)
	p.logger.Info("order processed successfully",
		"order_id", order.ID,
		"processor_id", p.processorID,
	)

	return nil
}

func (p *OrderProcessor) checkInventory(order Order) error {
	// In production, this would call an inventory service.
	for _, item := range order.Items {
		if item.Quantity > 100 {
			return fmt.Errorf("insufficient inventory for product %s: requested %d",
				item.ProductID, item.Quantity,
			)
		}
	}
	return nil
}

func (p *OrderProcessor) processPayment(order Order) error {
	// In production, this would call a payment gateway.
	// Rejects transactions exceeding $10,000 (1,000,000 cents).
	if order.TotalAmountCents > 1000000 {
		return fmt.Errorf("payment declined: amount %d cents exceeds limit", order.TotalAmountCents)
	}
	return nil
}

func (p *OrderProcessor) reserveInventory(order Order) error {
	// In production, this would reserve items in the inventory service.
	return nil
}

func (p *OrderProcessor) handleProcessingError(order Order, err error, retryCount int) error {
	if retryCount >= p.maxRetries {
		p.logger.Error("max retries exceeded, sending to DLQ",
			"order_id", order.ID,
			"retry_count", retryCount,
			"error", err,
		)
		p.metrics.OrdersDLQ.Add(1)
		return p.sendToDLQ(order, err.Error(), retryCount)
	}

	// Send to retry topic with exponential backoff metadata.
	retryMsg := RetryMessage{
		Order:       order,
		RetryCount:  retryCount + 1,
		MaxRetries:  p.maxRetries,
		LastError:   err.Error(),
		FirstFailAt: time.Now(),
		NextRetryAt: time.Now().Add(p.calculateBackoff(retryCount)),
	}

	value, marshalErr := json.Marshal(retryMsg)
	if marshalErr != nil {
		return fmt.Errorf("marshaling retry message: %w", marshalErr)
	}

	msg := &sarama.ProducerMessage{
		Topic: TopicOrdersRetry,
		Key:   sarama.StringEncoder(order.CustomerID),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{Key: []byte("retry_count"), Value: []byte(fmt.Sprintf("%d", retryCount+1))},
			{Key: []byte("original_error"), Value: []byte(err.Error())},
			{Key: []byte("correlation_id"), Value: []byte(order.ID)},
		},
	}

	if _, _, sendErr := p.retryProducer.SendMessage(msg); sendErr != nil {
		return fmt.Errorf("sending to retry topic: %w", sendErr)
	}

	p.metrics.OrdersRetried.Add(1)
	p.logger.Warn("order sent to retry",
		"order_id", order.ID,
		"retry_count", retryCount+1,
		"next_retry_at", retryMsg.NextRetryAt,
	)

	return nil
}

func (p *OrderProcessor) calculateBackoff(retryCount int) time.Duration {
	// Exponential backoff: 1s, 2s, 4s, 8s, 16s (capped at 60s).
	backoff := time.Duration(math.Pow(2, float64(retryCount))) * time.Second
	maxBackoff := 60 * time.Second
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	return backoff
}

func (p *OrderProcessor) sendToDLQ(order Order, errMsg string, retryCount int) error {
	result := OrderResult{
		OrderID:     order.ID,
		Status:      OrderStatusFailed,
		Message:     errMsg,
		ProcessedAt: time.Now(),
		ProcessorID: p.processorID,
	}

	value, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshaling DLQ message: %w", err)
	}

	msg := &sarama.ProducerMessage{
		Topic: TopicOrdersDLQ,
		Key:   sarama.StringEncoder(order.CustomerID),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{Key: []byte("error"), Value: []byte(errMsg)},
			{Key: []byte("retry_count"), Value: []byte(fmt.Sprintf("%d", retryCount))},
			{Key: []byte("correlation_id"), Value: []byte(order.ID)},
		},
	}

	if _, _, sendErr := p.retryProducer.SendMessage(msg); sendErr != nil {
		return fmt.Errorf("sending to DLQ: %w", sendErr)
	}

	// Also emit a failed result to the processed topic.
	p.emitResult(result)
	p.metrics.OrdersFailed.Add(1)

	return nil
}

func (p *OrderProcessor) emitResult(result OrderResult) error {
	value, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("marshaling result: %w", err)
	}

	msg := &sarama.ProducerMessage{
		Topic: TopicOrdersProcessed,
		Key:   sarama.StringEncoder(result.OrderID),
		Value: sarama.ByteEncoder(value),
		Headers: []sarama.RecordHeader{
			{Key: []byte("status"), Value: []byte(string(result.Status))},
			{Key: []byte("correlation_id"), Value: []byte(result.OrderID)},
		},
	}

	_, _, err = p.resultProducer.SendMessage(msg)
	return err
}

// Close shuts down the processor's producers.
func (p *OrderProcessor) Close() error {
	p.resultProducer.Close()
	return p.retryProducer.Close()
}

// --- Retry Handler ---

// RetryHandler processes messages from the retry topic with backoff.
type RetryHandler struct {
	orderProcessor *OrderProcessor
	metrics        *SystemMetrics
	logger         *slog.Logger
}

// Setup is called at the beginning of a new consumer group session.
func (h *RetryHandler) Setup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("retry handler session started")
	return nil
}

// Cleanup is called at the end of a consumer group session.
func (h *RetryHandler) Cleanup(session sarama.ConsumerGroupSession) error {
	h.logger.Info("retry handler session ended")
	return nil
}

// ConsumeClaim processes retry messages.
func (h *RetryHandler) ConsumeClaim(
	session sarama.ConsumerGroupSession,
	claim sarama.ConsumerGroupClaim,
) error {
	for msg := range claim.Messages() {
		var retryMsg RetryMessage
		if err := json.Unmarshal(msg.Value, &retryMsg); err != nil {
			h.logger.Error("failed to unmarshal retry message",
				"error", err,
				"offset", msg.Offset,
			)
			session.MarkMessage(msg, "")
			continue
		}

		// Wait until the backoff period has elapsed.
		now := time.Now()
		if now.Before(retryMsg.NextRetryAt) {
			waitDuration := retryMsg.NextRetryAt.Sub(now)
			h.logger.Info("waiting for backoff",
				"order_id", retryMsg.Order.ID,
				"retry_count", retryMsg.RetryCount,
				"wait", waitDuration,
			)
			time.Sleep(waitDuration)
		}

		h.logger.Info("retrying order",
			"order_id", retryMsg.Order.ID,
			"retry_count", retryMsg.RetryCount,
			"max_retries", retryMsg.MaxRetries,
			"last_error", retryMsg.LastError,
		)

		// Reprocess the order.
		if err := h.orderProcessor.checkInventory(retryMsg.Order); err != nil {
			h.orderProcessor.handleProcessingError(retryMsg.Order, err, retryMsg.RetryCount)
			session.MarkMessage(msg, "")
			continue
		}

		if err := h.orderProcessor.processPayment(retryMsg.Order); err != nil {
			h.orderProcessor.handleProcessingError(retryMsg.Order, err, retryMsg.RetryCount)
			session.MarkMessage(msg, "")
			continue
		}

		// Success on retry.
		result := OrderResult{
			OrderID:     retryMsg.Order.ID,
			Status:      OrderStatusCompleted,
			Message:     fmt.Sprintf("completed after %d retries", retryMsg.RetryCount),
			ProcessedAt: time.Now(),
			ProcessorID: h.orderProcessor.processorID,
		}
		h.orderProcessor.emitResult(result)
		h.metrics.OrdersProcessed.Add(1)

		h.logger.Info("order retry succeeded",
			"order_id", retryMsg.Order.ID,
			"retry_count", retryMsg.RetryCount,
		)

		session.MarkMessage(msg, "")
	}
	return nil
}

// --- Monitoring Dashboard ---

// MonitoringServer serves metrics over HTTP.
type MonitoringServer struct {
	metrics *SystemMetrics
	logger  *slog.Logger
}

// NewMonitoringServer creates a new monitoring HTTP server.
func NewMonitoringServer(metrics *SystemMetrics, logger *slog.Logger) *MonitoringServer {
	return &MonitoringServer{
		metrics: metrics,
		logger:  logger,
	}
}

// Start begins serving the monitoring endpoints.
func (s *MonitoringServer) Start(addr string) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.metrics.Snapshot())
	})

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"healthy"}`))
	})

	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ready"}`))
	})

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		s.logger.Info("monitoring server started", "addr", addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			s.logger.Error("monitoring server error", "error", err)
		}
	}()

	return server
}

// --- Topic Setup ---

func createTopics(brokers []string, logger *slog.Logger) error {
	config := sarama.NewConfig()
	config.Version = sarama.V3_6_0_0

	admin, err := sarama.NewClusterAdmin(brokers, config)
	if err != nil {
		return fmt.Errorf("creating admin: %w", err)
	}
	defer admin.Close()

	topics := map[string]*sarama.TopicDetail{
		TopicOrders: {
			NumPartitions:     12,
			ReplicationFactor: 3,
			ConfigEntries: map[string]*string{
				"retention.ms":          strPtr("604800000"), // 7 days
				"min.insync.replicas":   strPtr("2"),
				"cleanup.policy":        strPtr("delete"),
			},
		},
		TopicOrdersProcessed: {
			NumPartitions:     12,
			ReplicationFactor: 3,
			ConfigEntries: map[string]*string{
				"retention.ms":          strPtr("2592000000"), // 30 days
				"min.insync.replicas":   strPtr("2"),
				"cleanup.policy":        strPtr("compact,delete"),
			},
		},
		TopicOrdersDLQ: {
			NumPartitions:     6,
			ReplicationFactor: 3,
			ConfigEntries: map[string]*string{
				"retention.ms":          strPtr("-1"), // infinite retention
				"min.insync.replicas":   strPtr("2"),
				"cleanup.policy":        strPtr("delete"),
			},
		},
		TopicOrdersRetry: {
			NumPartitions:     6,
			ReplicationFactor: 3,
			ConfigEntries: map[string]*string{
				"retention.ms":          strPtr("86400000"), // 1 day
				"min.insync.replicas":   strPtr("2"),
				"cleanup.policy":        strPtr("delete"),
			},
		},
	}

	for name, detail := range topics {
		err := admin.CreateTopic(name, detail, false)
		if err != nil {
			logger.Warn("topic creation (may already exist)",
				"topic", name,
				"error", err,
			)
		} else {
			logger.Info("topic created", "topic", name)
		}
	}

	return nil
}

func strPtr(s string) *string {
	return &s
}

// --- Main ---

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	brokers := []string{"localhost:9092"}
	metrics := &SystemMetrics{}

	// Create topics.
	if err := createTopics(brokers, logger); err != nil {
		logger.Error("failed to create topics", "error", err)
		os.Exit(1)
	}

	// Start monitoring server.
	monServer := NewMonitoringServer(metrics, logger)
	httpServer := monServer.Start(":8080")

	// Create order service (producer).
	orderService, err := NewOrderService(brokers, metrics, logger)
	if err != nil {
		logger.Error("failed to create order service", "error", err)
		os.Exit(1)
	}
	defer orderService.Close()

	// Create order processor (consumer).
	processor, err := NewOrderProcessor(brokers, "processor-1", metrics, logger)
	if err != nil {
		logger.Error("failed to create order processor", "error", err)
		os.Exit(1)
	}
	defer processor.Close()

	// Set up consumer groups.
	consumerConfig := sarama.NewConfig()
	consumerConfig.Version = sarama.V3_6_0_0
	consumerConfig.Consumer.Group.Rebalance.GroupStrategies = []sarama.BalanceStrategy{
		sarama.NewBalanceStrategyCooperativeSticky(),
	}
	consumerConfig.Consumer.Offsets.Initial = sarama.OffsetOldest
	consumerConfig.Consumer.Offsets.AutoCommit.Enable = true
	consumerConfig.Consumer.Offsets.AutoCommit.Interval = 1 * time.Second

	// Order processor consumer group.
	orderConsumer, err := sarama.NewConsumerGroup(brokers, "order-processors", consumerConfig)
	if err != nil {
		logger.Error("failed to create order consumer group", "error", err)
		os.Exit(1)
	}
	defer orderConsumer.Close()

	// Retry handler consumer group.
	retryConsumer, err := sarama.NewConsumerGroup(brokers, "retry-handlers", consumerConfig)
	if err != nil {
		logger.Error("failed to create retry consumer group", "error", err)
		os.Exit(1)
	}
	defer retryConsumer.Close()

	retryHandler := &RetryHandler{
		orderProcessor: processor,
		metrics:        metrics,
		logger:         logger,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	var wg sync.WaitGroup

	// Start order processor.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			if err := orderConsumer.Consume(ctx, []string{TopicOrders}, processor); err != nil {
				logger.Error("order consumer error", "error", err)
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()

	// Start retry handler.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			if err := retryConsumer.Consume(ctx, []string{TopicOrdersRetry}, retryHandler); err != nil {
				logger.Error("retry consumer error", "error", err)
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()

	// Generate sample orders for demonstration.
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()

		sampleOrders := []Order{
			{
				CustomerID: "cust-001",
				Currency:   "USD",
				Items: []OrderItem{
					{ProductID: "prod-001", Name: "Mechanical Keyboard", Quantity: 1, PriceCents: 14999},
					{ProductID: "prod-002", Name: "Mouse Pad", Quantity: 2, PriceCents: 2999},
				},
			},
			{
				CustomerID: "cust-002",
				Currency:   "USD",
				Items: []OrderItem{
					{ProductID: "prod-003", Name: "Monitor", Quantity: 1, PriceCents: 49999},
				},
			},
			{
				CustomerID: "cust-003",
				Currency:   "EUR",
				Items: []OrderItem{
					{ProductID: "prod-004", Name: "USB Hub", Quantity: 3, PriceCents: 3999},
					{ProductID: "prod-005", Name: "Cable", Quantity: 5, PriceCents: 999},
				},
			},
		}

		idx := 0
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				order := sampleOrders[idx%len(sampleOrders)]
				if err := orderService.CreateOrder(ctx, order); err != nil {
					logger.Error("failed to create order", "error", err)
				}
				idx++
			}
		}
	}()

	// Periodic metrics logging.
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				snapshot := metrics.Snapshot()
				logger.Info("system metrics",
					"received", snapshot["orders_received"],
					"processed", snapshot["orders_processed"],
					"failed", snapshot["orders_failed"],
					"retried", snapshot["orders_retried"],
					"dlq", snapshot["orders_dlq"],
					"avg_processing_ms", snapshot["avg_processing_time_ms"],
				)
			}
		}
	}()

	logger.Info("order processing system started",
		"brokers", brokers,
		"monitoring", "http://localhost:8080/metrics",
	)

	<-sigChan
	logger.Info("shutdown signal received, stopping gracefully...")
	cancel()
	wg.Wait()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	httpServer.Shutdown(shutdownCtx)

	logger.Info("system shut down cleanly")
}
```

> **System Design Insight**: The key architectural decisions here are: (1) separate topics for main flow, results, retries, and dead letters. (2) exponential backoff via a dedicated retry topic rather than blocking the main consumer. (3) idempotent producers for duplicate prevention. and (4) a monitoring layer exposing metrics via HTTP for Prometheus. In production, add distributed tracing (OpenTelemetry), circuit breakers for downstream services, and automatic scaling based on consumer lag.

### Junior -> FAANG: Reading Complete Examples as Architecture Patterns

A complete example like this section is not just code to run. It is a collection of architectural decisions that you should be able to explain in an interview. Walk through the system design and practice answering "why" for each choice:

**Why four separate topics instead of one?** Separating main flow, results, retries, and dead letters gives each concern its own retention, replication factor, and consumer group. The DLQ can have longer retention (90 days) so operators can investigate failures long after they occur. The retry topic can have shorter retention (1 day) because retries are transient. If everything shares one topic, you cannot configure retention per concern.

**Why exponential backoff via a retry topic instead of sleeping in the consumer?** Sleeping in the consumer means the partition is blocked: no other messages from that partition are processed during the sleep. A dedicated retry topic (with a header tracking retry count and next-retry timestamp) allows the main consumer to continue processing other messages while the retry consumer handles redelivery with a configurable delay.

**Why Prometheus metrics on the HTTP endpoint?** Prometheus scrapes metrics at regular intervals. Exposing metrics via an HTTP endpoint allows Prometheus to pull from any number of service instances without the service needing to know where Prometheus is. This is the standard observability pattern for Go services. Every production Kafka consumer should expose: messages processed total (counter), processing duration (histogram), errors total (counter by error type), and consumer lag (gauge, queried from the broker).

Practice describing this system in 2 minutes as if explaining it to a senior engineer in an interview. Cover the data flow, the error handling path, and the monitoring strategy. This is exactly what a systems design question about "building a reliable order processing system with Kafka" expects.

### Senior @ FAANG: Evaluating Complete System Designs for Production Readiness

At the senior level, the complete example is evaluated against production readiness criteria that go beyond "does it work." A bar-raiser reviewing this design would ask:

**What is the SLA for order processing latency, and how does the retry topology affect it?** If the business requires orders to be processed within 5 seconds of receipt, a retry topic with a 30-second backoff violates this SLA. The retry backoff schedule must be designed with the processing SLA in mind. For time-sensitive order processing, a circuit breaker pattern (stop processing if downstream is unhealthy, alert on-call, resume when healthy) may be more appropriate than exponential backoff.

**How does the system behave during a DLQ consumer outage?** If the DLQ consumer is down and the DLQ topic fills up, new messages can still be routed to the DLQ because the main consumer is not blocked. But if the DLQ topic hits its retention limit, old DLQ messages are deleted and the original failures are permanently lost. Set DLQ retention to a value that gives the on-call team enough time to detect and respond: typically 7-30 days. Alert on any non-zero DLQ message count.

**How does the idempotent producer interact with the retry loop?** The main consumer produces to the results topic as part of processing. If the consumer crashes after producing but before committing the Kafka offset, the message is redelivered and processed again. This produces a duplicate result. The idempotent producer prevents duplicate Kafka messages within a session, but it does not prevent the database side effect from executing twice. The handler must be idempotent at the database layer (`ON CONFLICT DO NOTHING` or equivalent).

**What is the operational runbook for a stuck DLQ?** A complete system design must include the operational procedure for a DLQ that has accumulated messages. The runbook should cover: how to inspect DLQ messages (structured headers with original topic/partition/offset and error message), how to fix the root cause, how to replay DLQ messages back to the main topic (a simple replay consumer that reads from DLQ and writes back to the main topic), and how to verify the replay succeeded. Without this runbook, the DLQ is a black hole where failures go to be forgotten.

---
