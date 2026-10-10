## 50.3 Orchestration-Based Saga

### Saga Orchestrator

The saga orchestrator is a single Go service that drives the entire distributed transaction by issuing commands to participants and awaiting their replies, maintaining explicit state for each saga instance in a persistent store. A state machine governs which command to send next and which compensation sequence to execute on failure, making the complete workflow visible in one place rather than scattered across event handlers. Using a database-backed state machine means the orchestrator can restart after a crash and resume exactly where it left off, without replaying the entire event history.

```go
// pkg/saga/orchestration/orchestrator.go
package orchestration

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
)

/*
Orchestration Saga:
- Central coordinator (orchestrator) controls saga
- Orchestrator tells services what to do
- Services report back to orchestrator
- Clear view of saga state

Pros:
- Centralized saga state
- Easier to manage complex sagas
- Better for many steps
- Easier testing

Cons:
- Single point of failure (mitigate with HA)
- Tighter coupling
- Orchestrator complexity
*/

// SagaStatus represents the status of a saga
type SagaStatus string

const (
	SagaStatusPending   SagaStatus = "pending"
	SagaStatusRunning   SagaStatus = "running"
	SagaStatusCompleted SagaStatus = "completed"
	SagaStatusFailed    SagaStatus = "failed"
	SagaStatusCompensating SagaStatus = "compensating"
	SagaStatusCompensated  SagaStatus = "compensated"
)

// StepStatus represents the status of a saga step
type StepStatus string

const (
	StepStatusPending     StepStatus = "pending"
	StepStatusExecuting   StepStatus = "executing"
	StepStatusCompleted   StepStatus = "completed"
	StepStatusFailed      StepStatus = "failed"
	StepStatusCompensating StepStatus = "compensating"
	StepStatusCompensated StepStatus = "compensated"
)

// SagaDefinition defines a saga with its steps
type SagaDefinition struct {
	Name  string
	Steps []StepDefinition
}

// StepDefinition defines a saga step
type StepDefinition struct {
	Name           string
	ServiceName    string
	ExecuteCommand string
	CompensateCommand string
	// Timeout for this step
	Timeout time.Duration
	// Retry configuration
	MaxRetries int
	RetryDelay time.Duration
}

// SagaState represents the current state of a saga instance
type SagaState struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Status         SagaStatus      `json:"status"`
	CurrentStep    int             `json:"current_step"`
	Data           json.RawMessage `json:"data"`
	Steps          []StepState     `json:"steps"`
	Error          string          `json:"error,omitempty"`
	StartedAt      time.Time       `json:"started_at"`
	CompletedAt    *time.Time      `json:"completed_at,omitempty"`
	LastUpdatedAt  time.Time       `json:"last_updated_at"`
}

// StepState represents the state of a saga step
type StepState struct {
	Name        string          `json:"name"`
	Status      StepStatus      `json:"status"`
	Request     json.RawMessage `json:"request,omitempty"`
	Response    json.RawMessage `json:"response,omitempty"`
	Error       string          `json:"error,omitempty"`
	StartedAt   *time.Time      `json:"started_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
	Retries     int             `json:"retries"`
}

// SagaRepository persists saga state
type SagaRepository interface {
	Create(ctx context.Context, state *SagaState) error
	Update(ctx context.Context, state *SagaState) error
	Get(ctx context.Context, id string) (*SagaState, error)
	GetPending(ctx context.Context) ([]*SagaState, error)
}

// CommandSender sends commands to services
type CommandSender interface {
	Send(ctx context.Context, serviceName, command string, data any) error
	SendAndWait(ctx context.Context, serviceName, command string, data any, timeout time.Duration) (json.RawMessage, error)
}

// Orchestrator manages saga execution
type Orchestrator struct {
	definitions map[string]SagaDefinition
	repo        SagaRepository
	sender      CommandSender
	logger      *slog.Logger
	mu          sync.RWMutex
}

// NewOrchestrator creates a new saga orchestrator
func NewOrchestrator(repo SagaRepository, sender CommandSender, logger *slog.Logger) *Orchestrator {
	return &Orchestrator{
		definitions: make(map[string]SagaDefinition),
		repo:        repo,
		sender:      sender,
		logger:      logger,
	}
}

// RegisterSaga registers a saga definition
func (o *Orchestrator) RegisterSaga(def SagaDefinition) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.definitions[def.Name] = def
}

// StartSaga starts a new saga instance
func (o *Orchestrator) StartSaga(ctx context.Context, sagaName string, data any) (string, error) {
	o.mu.RLock()
	def, exists := o.definitions[sagaName]
	o.mu.RUnlock()

	if !exists {
		return "", fmt.Errorf("saga not found: %s", sagaName)
	}

	dataJSON, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("marshal data: %w", err)
	}

	// Initialize saga state
	state := &SagaState{
		ID:            uuid.New().String(),
		Name:          sagaName,
		Status:        SagaStatusPending,
		CurrentStep:   0,
		Data:          dataJSON,
		Steps:         make([]StepState, len(def.Steps)),
		StartedAt:     time.Now().UTC(),
		LastUpdatedAt: time.Now().UTC(),
	}

	for i, step := range def.Steps {
		state.Steps[i] = StepState{
			Name:   step.Name,
			Status: StepStatusPending,
		}
	}

	// Persist initial state
	if err := o.repo.Create(ctx, state); err != nil {
		return "", fmt.Errorf("create saga state: %w", err)
	}

	// Start execution
	go o.executeSaga(context.Background(), state, def)

	return state.ID, nil
}

func (o *Orchestrator) executeSaga(ctx context.Context, state *SagaState, def SagaDefinition) {
	state.Status = SagaStatusRunning
	o.updateState(ctx, state)

	o.logger.Info("Starting saga execution",
		"saga_id", state.ID,
		"saga_name", state.Name,
	)

	for i := state.CurrentStep; i < len(def.Steps); i++ {
		stepDef := def.Steps[i]
		stepState := &state.Steps[i]

		o.logger.Info("Executing saga step",
			"saga_id", state.ID,
			"step", stepDef.Name,
			"step_index", i,
		)

		err := o.executeStep(ctx, state, stepDef, stepState)
		if err != nil {
			o.logger.Error("Saga step failed",
				"saga_id", state.ID,
				"step", stepDef.Name,
				"error", err,
			)

			state.Error = err.Error()
			state.Status = SagaStatusFailed

			// Start compensation
			o.compensate(ctx, state, def, i-1)
			return
		}

		state.CurrentStep = i + 1
		o.updateState(ctx, state)
	}

	// All steps completed successfully
	now := time.Now().UTC()
	state.CompletedAt = &now
	state.Status = SagaStatusCompleted
	o.updateState(ctx, state)

	o.logger.Info("Saga completed successfully",
		"saga_id", state.ID,
		"saga_name", state.Name,
	)
}

func (o *Orchestrator) executeStep(ctx context.Context, state *SagaState, stepDef StepDefinition, stepState *StepState) error {
	now := time.Now().UTC()
	stepState.StartedAt = &now
	stepState.Status = StepStatusExecuting

	// Build request from saga data
	request := state.Data

	// Set timeout
	timeout := stepDef.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}

	// Retry loop
	var lastErr error
	for attempt := 0; attempt <= stepDef.MaxRetries; attempt++ {
		if attempt > 0 {
			o.logger.Info("Retrying saga step",
				"saga_id", state.ID,
				"step", stepDef.Name,
				"attempt", attempt,
			)
			time.Sleep(stepDef.RetryDelay)
		}

		stepState.Retries = attempt
		stepState.Request = request

		// Execute step
		ctx, cancel := context.WithTimeout(ctx, timeout)
		response, err := o.sender.SendAndWait(ctx, stepDef.ServiceName, stepDef.ExecuteCommand, request, timeout)
		cancel()

		if err != nil {
			lastErr = err
			stepState.Error = err.Error()
			continue
		}

		// Success
		completed := time.Now().UTC()
		stepState.Response = response
		stepState.CompletedAt = &completed
		stepState.Status = StepStatusCompleted
		stepState.Error = ""

		return nil
	}

	stepState.Status = StepStatusFailed
	return fmt.Errorf("step %s failed after %d attempts: %w", stepDef.Name, stepDef.MaxRetries+1, lastErr)
}

func (o *Orchestrator) compensate(ctx context.Context, state *SagaState, def SagaDefinition, fromStep int) {
	state.Status = SagaStatusCompensating
	o.updateState(ctx, state)

	o.logger.Info("Starting saga compensation",
		"saga_id", state.ID,
		"from_step", fromStep,
	)

	// Compensate in reverse order
	for i := fromStep; i >= 0; i-- {
		stepDef := def.Steps[i]
		stepState := &state.Steps[i]

		// Only compensate completed steps
		if stepState.Status != StepStatusCompleted {
			continue
		}

		if stepDef.CompensateCommand == "" {
			o.logger.Warn("No compensation command for step",
				"saga_id", state.ID,
				"step", stepDef.Name,
			)
			continue
		}

		o.logger.Info("Compensating saga step",
			"saga_id", state.ID,
			"step", stepDef.Name,
		)

		stepState.Status = StepStatusCompensating

		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := o.sender.SendAndWait(ctx, stepDef.ServiceName, stepDef.CompensateCommand, stepState.Response, 30*time.Second)
		cancel()

		if err != nil {
			o.logger.Error("Compensation failed",
				"saga_id", state.ID,
				"step", stepDef.Name,
				"error", err,
			)
			// Continue with other compensations
			continue
		}

		stepState.Status = StepStatusCompensated
	}

	now := time.Now().UTC()
	state.CompletedAt = &now
	state.Status = SagaStatusCompensated
	o.updateState(ctx, state)

	o.logger.Info("Saga compensation completed",
		"saga_id", state.ID,
	)
}

func (o *Orchestrator) updateState(ctx context.Context, state *SagaState) {
	state.LastUpdatedAt = time.Now().UTC()
	if err := o.repo.Update(ctx, state); err != nil {
		o.logger.Error("Failed to update saga state",
			"saga_id", state.ID,
			"error", err,
		)
	}
}

// GetSagaStatus retrieves saga status
func (o *Orchestrator) GetSagaStatus(ctx context.Context, sagaID string) (*SagaState, error) {
	return o.repo.Get(ctx, sagaID)
}

// RecoverPendingSagas recovers incomplete sagas after restart
func (o *Orchestrator) RecoverPendingSagas(ctx context.Context) error {
	sagas, err := o.repo.GetPending(ctx)
	if err != nil {
		return fmt.Errorf("get pending sagas: %w", err)
	}

	for _, state := range sagas {
		o.mu.RLock()
		def, exists := o.definitions[state.Name]
		o.mu.RUnlock()

		if !exists {
			o.logger.Warn("Cannot recover saga - definition not found",
				"saga_id", state.ID,
				"saga_name", state.Name,
			)
			continue
		}

		o.logger.Info("Recovering saga",
			"saga_id", state.ID,
			"saga_name", state.Name,
			"status", state.Status,
		)

		go o.executeSaga(context.Background(), state, def)
	}

	return nil
}
```

### Order Saga Definition

The order saga definition declares a slice of named steps in execution order, each with a forward action and a compensation action. The orchestrator iterates this slice, executing each step's `Execute` function and prepending it to the compensation stack on success. Any step failure triggers the stack unwind so compensations run in reverse order. Defining steps as data rather than hardcoded control flow allows the orchestrator to be tested independently of any individual service, and new saga types can be added by composing steps without touching the execution engine.

```go
// internal/saga/order_saga.go
package saga

import (
	"time"

	"example.com/saga/pkg/saga/orchestration"
)

// OrderSagaData represents the data for order saga
type OrderSagaData struct {
	OrderID     string      `json:"order_id"`
	CustomerID  string      `json:"customer_id"`
	TotalAmountCents int64  `json:"total_amount_cents"`
	Items       []OrderItem `json:"items"`
}

type OrderItem struct {
	ProductID string  `json:"product_id"`
	Quantity  int     `json:"quantity"`
	PriceCents int64  `json:"price_cents"`
}

// NewOrderSagaDefinition creates the order saga definition
func NewOrderSagaDefinition() orchestration.SagaDefinition {
	return orchestration.SagaDefinition{
		Name: "CreateOrder",
		Steps: []orchestration.StepDefinition{
			{
				Name:              "CreateOrder",
				ServiceName:       "order-service",
				ExecuteCommand:    "CreateOrder",
				CompensateCommand: "CancelOrder",
				Timeout:           10 * time.Second,
				MaxRetries:        2,
				RetryDelay:        1 * time.Second,
			},
			{
				Name:              "ReserveInventory",
				ServiceName:       "inventory-service",
				ExecuteCommand:    "ReserveInventory",
				CompensateCommand: "ReleaseInventory",
				Timeout:           10 * time.Second,
				MaxRetries:        2,
				RetryDelay:        1 * time.Second,
			},
			{
				Name:              "ProcessPayment",
				ServiceName:       "payment-service",
				ExecuteCommand:    "ProcessPayment",
				CompensateCommand: "RefundPayment",
				Timeout:           30 * time.Second,
				MaxRetries:        3,
				RetryDelay:        2 * time.Second,
			},
			{
				Name:              "ConfirmOrder",
				ServiceName:       "order-service",
				ExecuteCommand:    "ConfirmOrder",
				CompensateCommand: "", // No compensation - final step
				Timeout:           10 * time.Second,
				MaxRetries:        2,
				RetryDelay:        1 * time.Second,
			},
		},
	}
}
```

### Saga Repository (PostgreSQL)

The orchestrator's state machine is only as durable as its persistence layer. This PostgreSQL repository stores each saga as a row with its current status, step index, and a JSONB column holding the per-step state snapshots. The `GetPending` method returns all sagas in non-terminal states, which the orchestrator calls on startup to resume interrupted workflows. Using `JSONB` for the steps column avoids the need for a separate join table while still allowing PostgreSQL to index into the step data if needed for operational queries.

```go
// internal/saga/repository.go
package saga

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"example.com/saga/pkg/saga/orchestration"
)

// PostgresSagaRepository implements SagaRepository using PostgreSQL
type PostgresSagaRepository struct {
	db *sql.DB
}

// NewPostgresSagaRepository creates a new repository
func NewPostgresSagaRepository(db *sql.DB) (*PostgresSagaRepository, error) {
	repo := &PostgresSagaRepository{db: db}
	if err := repo.createSchema(); err != nil {
		return nil, err
	}
	return repo, nil
}

func (r *PostgresSagaRepository) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS sagas (
			id UUID PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			status VARCHAR(50) NOT NULL,
			current_step INT NOT NULL DEFAULT 0,
			data JSONB NOT NULL,
			steps JSONB NOT NULL,
			error TEXT,
			started_at TIMESTAMP WITH TIME ZONE NOT NULL,
			completed_at TIMESTAMP WITH TIME ZONE,
			last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_sagas_status ON sagas(status);
		CREATE INDEX IF NOT EXISTS idx_sagas_name ON sagas(name);
	`

	_, err := r.db.Exec(query)
	return err
}

// Create creates a new saga state
func (r *PostgresSagaRepository) Create(ctx context.Context, state *orchestration.SagaState) error {
	stepsJSON, err := json.Marshal(state.Steps)
	if err != nil {
		return err
	}

	query := `
		INSERT INTO sagas (id, name, status, current_step, data, steps, error, started_at, completed_at, last_updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`

	_, err = r.db.ExecContext(ctx, query,
		state.ID,
		state.Name,
		state.Status,
		state.CurrentStep,
		state.Data,
		stepsJSON,
		state.Error,
		state.StartedAt,
		state.CompletedAt,
		state.LastUpdatedAt,
	)

	return err
}

// Update updates saga state
func (r *PostgresSagaRepository) Update(ctx context.Context, state *orchestration.SagaState) error {
	stepsJSON, err := json.Marshal(state.Steps)
	if err != nil {
		return err
	}

	query := `
		UPDATE sagas
		SET status = $1, current_step = $2, data = $3, steps = $4,
		    error = $5, completed_at = $6, last_updated_at = $7
		WHERE id = $8
	`

	_, err = r.db.ExecContext(ctx, query,
		state.Status,
		state.CurrentStep,
		state.Data,
		stepsJSON,
		state.Error,
		state.CompletedAt,
		state.LastUpdatedAt,
		state.ID,
	)

	return err
}

// Get retrieves saga state by ID
func (r *PostgresSagaRepository) Get(ctx context.Context, id string) (*orchestration.SagaState, error) {
	query := `
		SELECT id, name, status, current_step, data, steps, error, started_at, completed_at, last_updated_at
		FROM sagas WHERE id = $1
	`

	var state orchestration.SagaState
	var stepsJSON []byte

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&state.ID,
		&state.Name,
		&state.Status,
		&state.CurrentStep,
		&state.Data,
		&stepsJSON,
		&state.Error,
		&state.StartedAt,
		&state.CompletedAt,
		&state.LastUpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	if err := json.Unmarshal(stepsJSON, &state.Steps); err != nil {
		return nil, err
	}

	return &state, nil
}

// GetPending retrieves incomplete sagas for recovery
func (r *PostgresSagaRepository) GetPending(ctx context.Context) ([]*orchestration.SagaState, error) {
	query := `
		SELECT id, name, status, current_step, data, steps, error, started_at, completed_at, last_updated_at
		FROM sagas
		WHERE status IN ('pending', 'running', 'compensating')
		ORDER BY started_at
	`

	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sagas []*orchestration.SagaState
	for rows.Next() {
		var state orchestration.SagaState
		var stepsJSON []byte

		err := rows.Scan(
			&state.ID,
			&state.Name,
			&state.Status,
			&state.CurrentStep,
			&state.Data,
			&stepsJSON,
			&state.Error,
			&state.StartedAt,
			&state.CompletedAt,
			&state.LastUpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(stepsJSON, &state.Steps); err != nil {
			return nil, err
		}

		sagas = append(sagas, &state)
	}

	return sagas, rows.Err()
}
```

### Command Sender with gRPC

The saga orchestrator uses a gRPC command sender to dispatch commands to each participant service, using HTTP/2 multiplexing to keep the number of open connections low when commanding many services in sequence. Wrapping the gRPC call in a context with a per-command deadline ensures that a non-responsive participant does not stall the entire saga indefinitely, and the typed Proto response makes compensation logic straightforward. The orchestrator maps specific gRPC status codes to structured failure reasons rather than parsing error strings.

```go
// internal/saga/grpc_sender.go
package saga

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// GRPCCommandSender sends commands via gRPC
type GRPCCommandSender struct {
	services   map[string]string // service name -> address
	clients    map[string]*grpc.ClientConn
	mu         sync.RWMutex
}

// NewGRPCCommandSender creates a new command sender
func NewGRPCCommandSender(services map[string]string) (*GRPCCommandSender, error) {
	sender := &GRPCCommandSender{
		services: services,
		clients:  make(map[string]*grpc.ClientConn),
	}

	// Establish connections
	for name, addr := range services {
		conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return nil, fmt.Errorf("connect to %s: %w", name, err)
		}
		sender.clients[name] = conn
	}

	return sender, nil
}

// Send sends a command without waiting for response
func (s *GRPCCommandSender) Send(ctx context.Context, serviceName, command string, data any) error {
	// Implementation would use gRPC streaming or fire-and-forget
	return nil
}

// SendAndWait sends a command and waits for response
func (s *GRPCCommandSender) SendAndWait(ctx context.Context, serviceName, command string, data any, timeout time.Duration) (json.RawMessage, error) {
	s.mu.RLock()
	conn, exists := s.clients[serviceName]
	s.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("service not found: %s", serviceName)
	}

	// In real implementation, this would call the appropriate gRPC method
	// For demo, we'll simulate the response
	_ = conn // Use connection

	// Simulate different commands
	switch command {
	case "CreateOrder":
		return json.Marshal(map[string]any{
			"order_id": "order-123",
			"status":   "created",
		})

	case "ReserveInventory":
		return json.Marshal(map[string]any{
			"reservation_id": "res-123",
			"status":         "reserved",
		})

	case "ProcessPayment":
		return json.Marshal(map[string]any{
			"payment_id": "pay-123",
			"status":     "completed",
		})

	case "ConfirmOrder":
		return json.Marshal(map[string]any{
			"order_id": "order-123",
			"status":   "confirmed",
		})

	case "CancelOrder":
		return json.Marshal(map[string]any{
			"status": "canceled",
		})

	case "ReleaseInventory":
		return json.Marshal(map[string]any{
			"status": "released",
		})

	case "RefundPayment":
		return json.Marshal(map[string]any{
			"status": "refunded",
		})

	default:
		return nil, fmt.Errorf("unknown command: %s", command)
	}
}

// Close closes all connections
func (s *GRPCCommandSender) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, conn := range s.clients {
		conn.Close()
	}

	return nil
}
```

### Junior -> FAANG: Understanding the Orchestrator State Machine

The orchestrator in this section is a state machine with a well-defined set of legal transitions. Understanding those transitions prevents you from writing code that gets the orchestrator into an impossible state.

Legal forward transitions: `pending -> running -> completed`. Legal failure transitions: `running -> failed -> compensating -> compensated`. The illegal states are any terminal status (`completed`, `compensated`, `failed`) transitioning to any other status. The repository's `Update` method must enforce this by checking the current status before applying the transition, or by using an optimistic lock (a `version` column that increments on each write and is included in the `WHERE` clause of the UPDATE, which fails silently if another writer updated the row first).

The `go o.executeSaga(context.Background(), state, def)` call in `StartSaga` launches a goroutine that is detached from the caller's context. This is intentional: the saga must outlive the HTTP request that started it. But it creates a goroutine leak if the orchestrator shuts down without waiting for in-flight goroutines to complete. Add a `sync.WaitGroup` to the orchestrator, call `wg.Add(1)` before launching each saga goroutine, call `wg.Done()` when it finishes, and call `wg.Wait()` in the shutdown path.

The retry delay in `executeStep` uses `time.Sleep(stepDef.RetryDelay)`, which is a fixed delay. In production, use exponential backoff with jitter: `time.Sleep(time.Duration(attempt) * stepDef.RetryDelay * time.Duration(rand.Intn(100)+50) / 100)`. Fixed delays cause retry thundering herds when many sagas fail simultaneously because of a downstream outage and all start retrying at the same interval.

### Senior @ FAANG: Production Hardening for Orchestration-Based Sagas

The orchestrator in this section handles the happy path and the single-failure path correctly. Production requires handling a larger set of failure scenarios that the current implementation silently mishandles.

**Compensation of a step currently executing.** The `compensate` function skips steps whose status is not `StepStatusCompleted`. But what if a step is in `StepStatusExecuting` when the orchestrator decides to compensate? This happens when the orchestrator's context is canceled (process shutdown) while a step is in flight. The step may or may not have completed on the remote service. The safe strategy is to treat `executing` as "potentially completed" and attempt compensation with an idempotency key. If the step did not complete, the compensation is a no-op (nothing to undo). If it did complete, the compensation reverses it. This requires that every compensation handler checks whether the forward action actually executed before undoing it.

**Distributed lock for multi-instance orchestrators.** The current implementation has no mechanism to prevent two orchestrator instances from picking up the same saga from `GetPending` on restart. Both instances would run `executeSaga` concurrently, potentially sending duplicate commands to participants. The fix uses `SELECT ... FOR UPDATE SKIP LOCKED` when claiming sagas for recovery, combined with a lease column that is periodically renewed and expires after a configurable TTL. Any instance that fails to renew its lease releases the saga for another instance to claim.

**Version-aware step resumption.** The `executeSaga` function resumes from `state.CurrentStep`, but `CurrentStep` is updated only after a step fully completes and the state is persisted. If the orchestrator crashes between completing a step and persisting `CurrentStep`, it will re-execute the step on restart. All step execute functions must be idempotent under this condition. The canonical pattern is to include the step number and saga ID in the idempotency key sent to the participant service: `fmt.Sprintf("%s:step:%d", state.ID, stepIndex)`. The participant returns the same result for any call with the same key, regardless of whether it is a first call or a retry.

**Saga definition versioning.** The `definitions` map is populated at startup from Go code. If you deploy a new version of the orchestrator with a modified saga definition (different step names, different step order, added steps), in-progress sagas loaded from the database will have state referencing step names that no longer exist in the new definition, or will resume from a step index that now points to a different step. This is the orchestration equivalent of Temporal's non-determinism problem. Solutions include: never modify a running saga definition (use a `version` field in the definition and pin each saga instance to the version it started with), or implement a migration that advances or compensates all in-progress sagas under the old definition before deploying the new one.

**Command sender circuit breaking.** The `GRPCCommandSender.SendAndWait` implementation has no circuit breaker. If the payment service is down, every saga that reaches the payment step will wait for the timeout before failing and triggering compensation. With a 30-second timeout and 1,000 concurrent sagas hitting the payment step, that is 1,000 goroutines blocked for 30 seconds each, consuming connection pool slots and memory. Add a circuit breaker (the `github.com/sony/gobreaker` package is the standard Go choice) that opens after a configurable number of consecutive failures and fails fast for subsequent calls, allowing compensation to start immediately rather than waiting for each timeout to expire.

---
