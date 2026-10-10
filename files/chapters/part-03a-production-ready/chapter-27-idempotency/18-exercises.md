## Exercises

### Exercise 1: Build an Idempotency Client Library

Create a client library that automatically handles idempotency keys for API calls.

**Requirements:**
- Automatic key generation
- Key storage for retries
- Request/response correlation
- Configurable retry behavior

**Solution:**

```go
package idempotent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Client is an idempotent HTTP client
type Client struct {
	httpClient *http.Client
	store      KeyStore
	config     *ClientConfig
}

// ClientConfig configures the idempotent client
type ClientConfig struct {
	MaxRetries     int
	RetryDelay     time.Duration
	KeyTTL         time.Duration
	AutoGenerateKey bool
}

// KeyStore stores request keys for retry correlation
type KeyStore interface {
	Get(requestHash string) (string, bool)
	Set(requestHash, key string, ttl time.Duration)
	Delete(requestHash string)
}

// MemoryKeyStore is an in-memory key store
type MemoryKeyStore struct {
	mu    sync.RWMutex
	keys  map[string]keyEntry
}

type keyEntry struct {
	key       string
	expiresAt time.Time
}

func NewMemoryKeyStore() *MemoryKeyStore {
	store := &MemoryKeyStore{
		keys: make(map[string]keyEntry),
	}
	go store.cleanup()
	return store
}

func (s *MemoryKeyStore) Get(requestHash string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entry, ok := s.keys[requestHash]
	if !ok || time.Now().After(entry.expiresAt) {
		return "", false
	}
	return entry.key, true
}

func (s *MemoryKeyStore) Set(requestHash, key string, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.keys[requestHash] = keyEntry{
		key:       key,
		expiresAt: time.Now().Add(ttl),
	}
}

func (s *MemoryKeyStore) Delete(requestHash string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.keys, requestHash)
}

func (s *MemoryKeyStore) cleanup() {
	ticker := time.NewTicker(time.Minute)
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		for hash, entry := range s.keys {
			if now.After(entry.expiresAt) {
				delete(s.keys, hash)
			}
		}
		s.mu.Unlock()
	}
}

// NewClient creates a new idempotent HTTP client
func NewClient(config *ClientConfig) *Client {
	if config == nil {
		config = &ClientConfig{
			MaxRetries:      3,
			RetryDelay:      time.Second,
			KeyTTL:          24 * time.Hour,
			AutoGenerateKey: true,
		}
	}

	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		store:      NewMemoryKeyStore(),
		config:     config,
	}
}

// Do performs an idempotent HTTP request
func (c *Client) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
	// Read and hash the request for correlation
	var bodyBytes []byte
	if req.Body != nil {
		bodyBytes, _ = io.ReadAll(req.Body)
		req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	requestHash := c.hashRequest(req.Method, req.URL.String(), bodyBytes)

	// Get or generate idempotency key
	idempotencyKey := req.Header.Get("Idempotency-Key")
	if idempotencyKey == "" {
		if existingKey, found := c.store.Get(requestHash); found {
			idempotencyKey = existingKey
		} else if c.config.AutoGenerateKey {
			idempotencyKey = uuid.New().String()
			c.store.Set(requestHash, idempotencyKey, c.config.KeyTTL)
		}
	}

	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}

	// Perform request with retries
	var lastErr error
	for attempt := 0; attempt <= c.config.MaxRetries; attempt++ {
		// Reset body for retry
		if bodyBytes != nil {
			req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(c.config.RetryDelay * time.Duration(attempt+1))
			continue
		}

		// Check if this is a replayed response
		if resp.Header.Get("Idempotency-Replay") == "true" {
			// Response was replayed from cache
		}

		// Success or non-retryable error
		if resp.StatusCode < 500 && resp.StatusCode != 429 {
			// Clean up stored key on success
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				c.store.Delete(requestHash)
			}
			return resp, nil
		}

		resp.Body.Close()
		lastErr = &HTTPError{StatusCode: resp.StatusCode}
		time.Sleep(c.config.RetryDelay * time.Duration(attempt+1))
	}

	return nil, lastErr
}

// Post performs an idempotent POST request
func (c *Client) Post(ctx context.Context, url string, body any) (*http.Response, error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	return c.Do(ctx, req)
}

func (c *Client) hashRequest(method, url string, body []byte) string {
	h := sha256.New()
	h.Write([]byte(method))
	h.Write([]byte(url))
	h.Write(body)
	return hex.EncodeToString(h.Sum(nil)[:16])
}

type HTTPError struct {
	StatusCode int
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP error: %d", e.StatusCode)
}

// Usage example:
func ExampleUsage() {
	client := NewClient(&ClientConfig{
		MaxRetries:      3,
		RetryDelay:      500 * time.Millisecond,
		KeyTTL:          24 * time.Hour,
		AutoGenerateKey: true,
	})

	ctx := context.Background()

	// Make idempotent payment request
	resp, err := client.Post(ctx, "https://api.example.com/payments", map[string]any{
		"amount_cents": 10000,
		"currency":     "USD",
	})
	if err != nil {
		log.Printf("Payment failed: %v", err)
		return
	}
	defer resp.Body.Close()

	// If this exact request was already made, we get the same response
	// without creating a duplicate payment
}
```

### Exercise 2: Implement Distributed Deduplication with Bloom Filters

Build a space-efficient deduplication system using Bloom filters.

**Requirements:**
- Probabilistic duplicate detection
- Configurable false positive rate
- Fallback to authoritative store
- Memory-efficient for millions of keys

**Solution:**

```go
package dedup

import (
	"context"
	"hash/fnv"
	"log"
	"math"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// BloomFilter is a probabilistic data structure for set membership
type BloomFilter struct {
	bits    []bool
	size    uint64
	hashes  uint64
	mu      sync.RWMutex
}

// NewBloomFilter creates a new Bloom filter
// n = expected number of elements
// p = false positive probability (e.g., 0.01 for 1%)
func NewBloomFilter(n uint64, p float64) *BloomFilter {
	// Calculate optimal size and hash count
	// m = -n * ln(p) / (ln(2)^2)
	m := uint64(math.Ceil(-float64(n) * math.Log(p) / math.Pow(math.Log(2), 2)))
	// k = m/n * ln(2)
	k := uint64(math.Ceil(float64(m) / float64(n) * math.Log(2)))

	return &BloomFilter{
		bits:   make([]bool, m),
		size:   m,
		hashes: k,
	}
}

// Add adds an element to the filter
func (bf *BloomFilter) Add(data []byte) {
	bf.mu.Lock()
	defer bf.mu.Unlock()

	for i := uint64(0); i < bf.hashes; i++ {
		idx := bf.hash(data, i) % bf.size
		bf.bits[idx] = true
	}
}

// Contains checks if an element might be in the filter
func (bf *BloomFilter) Contains(data []byte) bool {
	bf.mu.RLock()
	defer bf.mu.RUnlock()

	for i := uint64(0); i < bf.hashes; i++ {
		idx := bf.hash(data, i) % bf.size
		if !bf.bits[idx] {
			return false // Definitely not in set
		}
	}
	return true // Probably in set (might be false positive)
}

// hash generates multiple hash values using double hashing
func (bf *BloomFilter) hash(data []byte, i uint64) uint64 {
	h1 := fnv.New64a()
	h1.Write(data)
	hash1 := h1.Sum64()

	h2 := fnv.New64()
	h2.Write(data)
	hash2 := h2.Sum64()

	// Double hashing: h(i) = h1 + i * h2
	return hash1 + i*hash2
}

// BloomDeduplicator combines Bloom filter with authoritative store
type BloomDeduplicator struct {
	bloom      *BloomFilter
	store      AuthoritativeStore
	ttl        time.Duration
	falsePositives int64
	truePositives  int64
	mu         sync.Mutex
}

// AuthoritativeStore is the fallback store for confirmed duplicates
type AuthoritativeStore interface {
	Exists(ctx context.Context, key string) (bool, error)
	Set(ctx context.Context, key string, ttl time.Duration) error
}

// NewBloomDeduplicator creates a new deduplicator with Bloom filter
func NewBloomDeduplicator(expectedKeys uint64, falsePositiveRate float64, store AuthoritativeStore, ttl time.Duration) *BloomDeduplicator {
	return &BloomDeduplicator{
		bloom: NewBloomFilter(expectedKeys, falsePositiveRate),
		store: store,
		ttl:   ttl,
	}
}

// IsDuplicate checks if a key has been seen before
func (d *BloomDeduplicator) IsDuplicate(ctx context.Context, key string) (bool, error) {
	keyBytes := []byte(key)

	// Fast path: if not in Bloom filter, definitely not a duplicate
	if !d.bloom.Contains(keyBytes) {
		return false, nil
	}

	// Bloom filter says "maybe" - check authoritative store
	exists, err := d.store.Exists(ctx, key)
	if err != nil {
		return false, err
	}

	d.mu.Lock()
	if exists {
		d.truePositives++
	} else {
		d.falsePositives++
	}
	d.mu.Unlock()

	return exists, nil
}

// MarkProcessed marks a key as processed
func (d *BloomDeduplicator) MarkProcessed(ctx context.Context, key string) error {
	// Add to Bloom filter (instant)
	d.bloom.Add([]byte(key))

	// Add to authoritative store (persistent)
	return d.store.Set(ctx, key, d.ttl)
}

// Stats returns deduplication statistics
func (d *BloomDeduplicator) Stats() (falsePositives, truePositives int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.falsePositives, d.truePositives
}

// RedisAuthoritativeStore implements AuthoritativeStore with Redis
type RedisAuthoritativeStore struct {
	client *redis.Client
	prefix string
}

func (s *RedisAuthoritativeStore) Exists(ctx context.Context, key string) (bool, error) {
	result, err := s.client.Exists(ctx, s.prefix+key).Result()
	return result > 0, err
}

func (s *RedisAuthoritativeStore) Set(ctx context.Context, key string, ttl time.Duration) error {
	return s.client.Set(ctx, s.prefix+key, "1", ttl).Err()
}

// Usage example:
func ExampleBloomDedup() {
	redisStore := &RedisAuthoritativeStore{
		client: redis.NewClient(&redis.Options{Addr: "localhost:6379"}),
		prefix: "dedup:",
	}

	// Expect 1 million keys with 0.1% false positive rate
	dedup := NewBloomDeduplicator(1_000_000, 0.001, redisStore, 24*time.Hour)

	ctx := context.Background()
	messageID := "msg-123456"

	// Check if duplicate
	isDup, err := dedup.IsDuplicate(ctx, messageID)
	if err != nil {
		log.Printf("Error checking duplicate: %v", err)
		return
	}

	if isDup {
		log.Printf("Duplicate message: %s", messageID)
		return
	}

	// Process message
	processMessage(messageID)

	// Mark as processed
	if err := dedup.MarkProcessed(ctx, messageID); err != nil {
		log.Printf("Error marking processed: %v", err)
	}
}
```

### Exercise 3: Build a Compensation Queue for Failed Sagas

Implement a durable compensation queue that handles saga rollbacks.

**Requirements:**
- Persistent storage for compensation tasks
- Retry with exponential backoff
- Dead letter queue for failed compensations
- Metrics and monitoring

**Solution:**

```go
package compensation

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/google/uuid"
)

// CompensationTask represents a task to be compensated
type CompensationTask struct {
	ID             string                 `json:"id"`
	SagaID         string                 `json:"saga_id"`
	StepName       string                 `json:"step_name"`
	StepIndex      int                    `json:"step_index"`
	Payload        map[string]any `json:"payload"`
	Status         TaskStatus             `json:"status"`
	Attempts       int                    `json:"attempts"`
	MaxAttempts    int                    `json:"max_attempts"`
	LastError      string                 `json:"last_error,omitempty"`
	NextRetryAt    *time.Time             `json:"next_retry_at,omitempty"`
	CreatedAt      time.Time              `json:"created_at"`
	CompletedAt    *time.Time             `json:"completed_at,omitempty"`
}

type TaskStatus string

const (
	TaskStatusPending   TaskStatus = "pending"
	TaskStatusRunning   TaskStatus = "running"
	TaskStatusCompleted TaskStatus = "completed"
	TaskStatusFailed    TaskStatus = "failed"
	TaskStatusDLQ       TaskStatus = "dlq" // Dead letter queue
)

// CompensationHandler is a function that performs compensation
type CompensationHandler func(ctx context.Context, payload map[string]any) error

// CompensationQueue manages compensation tasks
type CompensationQueue struct {
	db           *sql.DB
	handlers     map[string]CompensationHandler
	logger       *slog.Logger
	workerCount  int
	pollInterval time.Duration
	metrics      *QueueMetrics
}

// QueueMetrics tracks queue performance
type QueueMetrics struct {
	TasksCreated    int64
	TasksCompleted  int64
	TasksFailed     int64
	TasksRetried    int64
	TasksInDLQ      int64
	AverageLatency  time.Duration
}

// QueueConfig configures the compensation queue
type QueueConfig struct {
	WorkerCount  int
	PollInterval time.Duration
	MaxAttempts  int
	BaseDelay    time.Duration
	MaxDelay     time.Duration
}

// DefaultQueueConfig returns default configuration
func DefaultQueueConfig() *QueueConfig {
	return &QueueConfig{
		WorkerCount:  5,
		PollInterval: time.Second,
		MaxAttempts:  5,
		BaseDelay:    time.Second,
		MaxDelay:     5 * time.Minute,
	}
}

// NewCompensationQueue creates a new compensation queue
func NewCompensationQueue(db *sql.DB, config *QueueConfig, logger *slog.Logger) *CompensationQueue {
	if config == nil {
		config = DefaultQueueConfig()
	}

	return &CompensationQueue{
		db:           db,
		handlers:     make(map[string]CompensationHandler),
		logger:       logger,
		workerCount:  config.WorkerCount,
		pollInterval: config.PollInterval,
		metrics:      &QueueMetrics{},
	}
}

// RegisterHandler registers a compensation handler for a step
func (q *CompensationQueue) RegisterHandler(stepName string, handler CompensationHandler) {
	q.handlers[stepName] = handler
}

// Enqueue adds a compensation task to the queue
func (q *CompensationQueue) Enqueue(ctx context.Context, sagaID, stepName string, stepIndex int, payload map[string]any) error {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	task := &CompensationTask{
		ID:          uuid.New().String(),
		SagaID:      sagaID,
		StepName:    stepName,
		StepIndex:   stepIndex,
		Status:      TaskStatusPending,
		MaxAttempts: 5,
		CreatedAt:   time.Now(),
	}

	query := `
		INSERT INTO compensation_tasks
		(id, saga_id, step_name, step_index, payload, status, attempts, max_attempts, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`

	_, err = q.db.ExecContext(ctx, query,
		task.ID, task.SagaID, task.StepName, task.StepIndex,
		payloadJSON, task.Status, 0, task.MaxAttempts, task.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to enqueue task: %w", err)
	}

	q.metrics.TasksCreated++
	q.logger.Info("compensation task enqueued",
		"task_id", task.ID,
		"saga_id", sagaID,
		"step_name", stepName,
	)

	return nil
}

// Start begins processing compensation tasks
func (q *CompensationQueue) Start(ctx context.Context) {
	for i := 0; i < q.workerCount; i++ {
		go q.worker(ctx, i)
	}
}

// worker processes compensation tasks
func (q *CompensationQueue) worker(ctx context.Context, workerID int) {
	q.logger.Info("compensation worker started", "worker_id", workerID)

	ticker := time.NewTicker(q.pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			q.logger.Info("compensation worker stopped", "worker_id", workerID)
			return
		case <-ticker.C:
			if err := q.processNextTask(ctx); err != nil {
				if !errors.Is(err, sql.ErrNoRows) {
					q.logger.Error("failed to process task", "worker_id", workerID, "error", err)
				}
			}
		}
	}
}

// processNextTask processes the next available task
func (q *CompensationQueue) processNextTask(ctx context.Context) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get and lock next task
	query := `
		SELECT id, saga_id, step_name, step_index, payload, attempts, max_attempts, created_at
		FROM compensation_tasks
		WHERE status = $1
		  AND (next_retry_at IS NULL OR next_retry_at <= NOW())
		ORDER BY created_at
		LIMIT 1
		FOR UPDATE SKIP LOCKED
	`

	var task CompensationTask
	var payloadJSON []byte

	err = tx.QueryRowContext(ctx, query, TaskStatusPending).Scan(
		&task.ID, &task.SagaID, &task.StepName, &task.StepIndex,
		&payloadJSON, &task.Attempts, &task.MaxAttempts, &task.CreatedAt,
	)
	if err != nil {
		return err
	}

	if err := json.Unmarshal(payloadJSON, &task.Payload); err != nil {
		return err
	}

	// Mark as running
	_, err = tx.ExecContext(ctx,
		"UPDATE compensation_tasks SET status = $1 WHERE id = $2",
		TaskStatusRunning, task.ID,
	)
	if err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	// Execute compensation
	startTime := time.Now()
	execErr := q.executeCompensation(ctx, &task)
	duration := time.Since(startTime)

	// Update task status
	return q.updateTaskStatus(ctx, &task, execErr, duration)
}

// executeCompensation runs the compensation handler
func (q *CompensationQueue) executeCompensation(ctx context.Context, task *CompensationTask) error {
	handler, ok := q.handlers[task.StepName]
	if !ok {
		return fmt.Errorf("no handler registered for step: %s", task.StepName)
	}

	// Create timeout context
	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	return handler(execCtx, task.Payload)
}

// updateTaskStatus updates task after execution
func (q *CompensationQueue) updateTaskStatus(ctx context.Context, task *CompensationTask, execErr error, duration time.Duration) error {
	task.Attempts++

	if execErr == nil {
		// Success
		now := time.Now()
		task.Status = TaskStatusCompleted
		task.CompletedAt = &now
		q.metrics.TasksCompleted++

		q.logger.Info("compensation completed",
			"task_id", task.ID,
			"saga_id", task.SagaID,
			"step_name", task.StepName,
			"duration", duration,
		)
	} else if task.Attempts >= task.MaxAttempts {
		// Move to DLQ
		task.Status = TaskStatusDLQ
		task.LastError = execErr.Error()
		q.metrics.TasksInDLQ++

		q.logger.Error("compensation moved to DLQ",
			"task_id", task.ID,
			"saga_id", task.SagaID,
			"step_name", task.StepName,
			"attempts", task.Attempts,
			"error", execErr,
		)
	} else {
		// Schedule retry with exponential backoff
		task.Status = TaskStatusPending
		task.LastError = execErr.Error()
		nextRetry := q.calculateNextRetry(task.Attempts)
		task.NextRetryAt = &nextRetry
		q.metrics.TasksRetried++

		q.logger.Warn("compensation failed, scheduling retry",
			"task_id", task.ID,
			"saga_id", task.SagaID,
			"step_name", task.StepName,
			"attempt", task.Attempts,
			"next_retry", nextRetry,
			"error", execErr,
		)
	}

	query := `
		UPDATE compensation_tasks
		SET status = $1, attempts = $2, last_error = $3, next_retry_at = $4, completed_at = $5
		WHERE id = $6
	`

	_, err := q.db.ExecContext(ctx, query,
		task.Status, task.Attempts, task.LastError, task.NextRetryAt, task.CompletedAt, task.ID,
	)
	return err
}

// calculateNextRetry calculates the next retry time with exponential backoff
func (q *CompensationQueue) calculateNextRetry(attempts int) time.Time {
	// Exponential backoff: base * 2^attempts, capped at max
	delay := time.Second * time.Duration(math.Pow(2, float64(attempts)))
	maxDelay := 5 * time.Minute
	if delay > maxDelay {
		delay = maxDelay
	}
	return time.Now().Add(delay)
}

// GetDLQTasks retrieves tasks in the dead letter queue
func (q *CompensationQueue) GetDLQTasks(ctx context.Context, limit int) ([]*CompensationTask, error) {
	query := `
		SELECT id, saga_id, step_name, step_index, payload, attempts, last_error, created_at
		FROM compensation_tasks
		WHERE status = $1
		ORDER BY created_at
		LIMIT $2
	`

	rows, err := q.db.QueryContext(ctx, query, TaskStatusDLQ, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tasks []*CompensationTask
	for rows.Next() {
		var task CompensationTask
		var payloadJSON []byte

		if err := rows.Scan(
			&task.ID, &task.SagaID, &task.StepName, &task.StepIndex,
			&payloadJSON, &task.Attempts, &task.LastError, &task.CreatedAt,
		); err != nil {
			return nil, err
		}

		json.Unmarshal(payloadJSON, &task.Payload)
		task.Status = TaskStatusDLQ
		tasks = append(tasks, &task)
	}

	return tasks, rows.Err()
}

// RetryDLQTask moves a task from DLQ back to pending
func (q *CompensationQueue) RetryDLQTask(ctx context.Context, taskID string) error {
	query := `
		UPDATE compensation_tasks
		SET status = $1, attempts = 0, last_error = NULL, next_retry_at = NULL
		WHERE id = $2 AND status = $3
	`

	result, err := q.db.ExecContext(ctx, query, TaskStatusPending, taskID, TaskStatusDLQ)
	if err != nil {
		return err
	}

	affected, _ := result.RowsAffected()
	if affected == 0 {
		return fmt.Errorf("task not found or not in DLQ: %s", taskID)
	}

	q.metrics.TasksInDLQ--
	return nil
}

// GetMetrics returns queue metrics
func (q *CompensationQueue) GetMetrics() *QueueMetrics {
	return q.metrics
}

// Usage example:
func ExampleCompensationQueue() {
	db, _ := sql.Open("postgres", "postgres://localhost/sagas")

	queue := NewCompensationQueue(db, nil, slog.Default())

	// Register handlers
	queue.RegisterHandler("reserve_inventory", func(ctx context.Context, payload map[string]any) error {
		reservationID := payload["reservation_id"].(string)
		// Release the reservation
		return releaseInventoryReservation(ctx, reservationID)
	})

	queue.RegisterHandler("charge_payment", func(ctx context.Context, payload map[string]any) error {
		paymentID := payload["payment_id"].(string)
		// Refund the payment
		return refundPayment(ctx, paymentID)
	})

	// Start processing
	ctx := context.Background()
	queue.Start(ctx)

	// Enqueue compensation task
	queue.Enqueue(ctx, "saga-123", "charge_payment", 1, map[string]any{
		"payment_id":   "pay-456",
		"amount_cents": 10000,
	})
}
```

These exercises provide hands-on practice with:
1. Client-side idempotency handling with automatic key management
2. Space-efficient deduplication using probabilistic data structures
3. Reliable compensation handling for saga rollbacks

### Senior at FAANG Track

4. Audit one service's mutation endpoints. Add idempotency where missing. Write tests verifying retry safety.

### Staff / Principal Track

5. Drive org-wide idempotency standard. Prioritize payment and billing services. Measure coverage. Close gaps systematically.

6. Audit event publishing paths. Ensure all use outbox pattern or equivalent dual-write-safe mechanism.
