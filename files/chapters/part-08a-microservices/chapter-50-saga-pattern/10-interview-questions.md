## 50.8 Interview Questions

### Question 1: Compare choreography vs orchestration saga patterns

**Answer:**

```go
// pkg/saga/interview/comparison.go
package interview

/*
CHOREOGRAPHY vs ORCHESTRATION SAGA PATTERNS

1. CHOREOGRAPHY (Event-Based):
   - No central coordinator
   - Services react to domain events
   - Each service publishes events after completing its local transaction
   - Loose coupling, no single point of failure

   Flow: Service A → Event → Service B → Event → Service C

   Pros:
   - Loose coupling between services
   - No single point of failure
   - Simple for straightforward flows
   - Services are more autonomous

   Cons:
   - Hard to track saga state (scattered across services)
   - Risk of cyclic event dependencies
   - Difficult to understand overall flow
   - Complex compensation coordination
   - Testing requires full event infrastructure

2. ORCHESTRATION (Central Coordinator):
   - Dedicated saga orchestrator manages flow
   - Orchestrator calls each service and handles responses
   - Centralized state management

   Flow: Orchestrator → Service A → Orchestrator → Service B → Orchestrator

   Pros:
   - Clear saga state visibility
   - Easy to understand and debug
   - Simpler compensation logic
   - Better for complex multi-step sagas
   - Easier testing (mock services)

   Cons:
   - Orchestrator is single point of failure (mitigate with HA)
   - Tighter coupling to orchestrator
   - Orchestrator can become a bottleneck

WHEN TO USE WHICH:

Use Choreography when:
- Simple sagas (2-4 steps)
- Services are developed by different teams
- You need maximum autonomy
- Events are already the primary communication pattern

Use Orchestration when:
- Complex sagas (5+ steps)
- Need clear visibility into saga state
- Compensation logic is complex
- Single team owns the saga
- Using workflow engines (Temporal, Cadence)

HYBRID APPROACH:
Many systems use orchestration within a domain and choreography between domains.
*/
```

**What FAANG expects:** Candidates should not default to either pattern. The expected answer is "depends on visibility requirements, step count, and team topology, and most large systems hybridize." Bonus points for naming concrete engines (Temporal, Conductor, Restate) and for noting that choreography gets unmanageable past four participants because the implicit flow becomes impossible to debug from logs alone.

**Follow-ups:**
1. "Your choreography saga has an event loop where service A publishes X, service B consumes X and publishes Y, and service A consumes Y and publishes X again. How would you detect and break this at review time?" (Expected: static event-graph analysis in CI, saga-id correlation with depth counter, type-level contracts that make cycles impossible.)
2. "How do you test an orchestration saga end-to-end without standing up every downstream service?" (Expected: inject mock activity implementations at the Temporal worker layer, or use orchestrator with stubbed service clients, replay historical workflow executions.)
3. "When would you pick Netflix Conductor over Temporal?" (Expected: Conductor uses declarative JSON DSL editable by non-engineers, polyglot worker ecosystem without SDK parity requirement, existing Netflix-stack integration. Temporal wins on code-first workflows and Go ergonomics.)

### Question 2: How would you handle compensation failure in a saga?

**Answer:**

```go
// pkg/saga/interview/compensation_failure.go
package interview

import (
	"context"
	"time"
)

/*
HANDLING COMPENSATION FAILURE

Compensation can fail for various reasons:
1. Service unavailable
2. Network timeout
3. Business rule violation
4. Data already modified by another process

Strategies:

1. RETRY WITH BACKOFF
   - Retry compensation with exponential backoff
   - Set max retry limit
   - Use jitter to prevent thundering herd

2. DEAD LETTER QUEUE
   - After max retries, send to DLQ
   - Manual or automated processing of failed compensations
   - Preserve all context for debugging

3. ALERT AND MANUAL INTERVENTION
   - Alert operations team
   - Provide tools for manual compensation
   - Log all state for debugging

4. COMPENSATING COMPENSATION
   - Some systems have "compensation for compensation"
   - If compensation fails, try alternative approach
   - Example: If refund fails, issue store credit

5. EVENTUAL COMPENSATION
   - Accept temporary inconsistency
   - Background job retries periodically
   - Reconciliation process catches missed compensations
*/

// CompensationHandler demonstrates proper compensation failure handling
type CompensationHandler struct {
	maxRetries      int
	baseDelay       time.Duration
	dlq             DeadLetterQueue
	alerter         Alerter
	reconciler      Reconciler
}

type DeadLetterQueue interface {
	Enqueue(ctx context.Context, item any) error
}

type Alerter interface {
	Critical(ctx context.Context, msg string) error
}

type Reconciler interface {
	ScheduleReconciliation(sagaID string, delay time.Duration) error
}

type CompensationTask struct {
	SagaID   string
	StepName string
	Data     any
	Attempt  int
}

func (h *CompensationHandler) ExecuteCompensation(
	ctx context.Context,
	task CompensationTask,
	compensate func(ctx context.Context) error,
) error {
	var lastErr error

	for attempt := 1; attempt <= h.maxRetries; attempt++ {
		// Execute compensation
		if err := compensate(ctx); err != nil {
			lastErr = err

			// Exponential backoff with jitter
			delay := h.baseDelay * time.Duration(1<<uint(attempt-1))
			jitter := time.Duration(float64(delay) * 0.1) // 10% jitter
			time.Sleep(delay + jitter)
			continue
		}

		return nil // Success
	}

	// All retries failed - fallback strategies

	// 1. Send to dead letter queue
	task.Attempt = h.maxRetries
	if err := h.dlq.Enqueue(ctx, task); err != nil {
		// DLQ failed - critical alert
		h.alerter.Critical(ctx,
			"CRITICAL: Compensation failed and DLQ unavailable")
	}

	// 2. Alert operations
	h.alerter.Critical(ctx,
		"Compensation failed after max retries - manual intervention required")

	// 3. Schedule reconciliation
	h.reconciler.ScheduleReconciliation(task.SagaID, 1*time.Hour)

	return lastErr
}
```

**What FAANG expects:** A weak answer says "retry then log." A strong answer separates transient compensation failure (retry with jitter) from permanent compensation failure (move to a dead-letter saga state and page a human), and acknowledges that some compensations are semantically impossible so you need a compensation-of-last-resort like store credit, a cancellation email, or a manual runbook. Interviewers watch for the candidate stating that compensations must be idempotent because they *will* be retried more than once.

**Follow-ups:**
1. "Your refund compensation succeeded at the payment gateway but your service crashed before recording it locally. Next retry double-refunds the customer. How do you prevent this?" (Expected: idempotency key passed to the payment gateway, check gateway state before issuing refund, use transactional outbox for the local record.)
2. "How long should you retry compensation before giving up?" (Expected: not a fixed number, tie it to the business SLO for convergence time. After the SLO window, stop retrying and page. Silent infinite retries hide bugs.)
3. "What is a compensating-compensation and when is it a smell?" (Expected: it is a smell when it replaces proper idempotency. It is legitimate only when the first compensation permanently failed due to business reasons, such as the window for refund expired and you must issue store credit instead.)

### Question 3: How do you ensure saga consistency during a service crash?

**Answer:**

```go
// pkg/saga/interview/crash_recovery.go
package interview

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

/*
SAGA CONSISTENCY DURING CRASHES

The key challenge: A service might crash after executing a step
but before updating saga state, or vice versa.

Solutions:

1. TRANSACTIONAL OUTBOX PATTERN
   - Store saga state change and domain event in same transaction
   - Separate process publishes events from outbox
   - Guarantees at-least-once delivery

2. EVENT SOURCING
   - Store events instead of state
   - Replay events to reconstruct state
   - Natural audit trail

3. WORKFLOW ENGINES (Temporal/Cadence)
   - Durable execution with history
   - Automatic state persistence
   - Built-in crash recovery

4. SAGA STATE CHECKPOINTING
   - Persist state before and after each step
   - On recovery, check which steps completed
   - Resume or compensate based on state

5. IDEMPOTENT OPERATIONS
   - Make all steps idempotent
   - Safe to retry after crash
   - Use idempotency keys
*/

// SagaCheckpointer provides crash-safe saga execution
type SagaCheckpointer struct {
	db *sql.DB
}

type SagaCheckpoint struct {
	SagaID        string          `json:"saga_id"`
	CurrentStep   int             `json:"current_step"`
	StepStatus    string          `json:"step_status"` // "pending", "executing", "completed"
	StepData      json.RawMessage `json:"step_data"`
	CheckpointedAt time.Time      `json:"checkpointed_at"`
}

// ExecuteStepWithCheckpoint safely executes a step with checkpointing
func (c *SagaCheckpointer) ExecuteStepWithCheckpoint(
	ctx context.Context,
	sagaID string,
	stepIndex int,
	stepData any,
	execute func(ctx context.Context) error,
) error {
	// 1. Checkpoint BEFORE execution (mark as executing)
	if err := c.checkpoint(ctx, sagaID, stepIndex, "executing", stepData); err != nil {
		return err
	}

	// 2. Execute the step
	if err := execute(ctx); err != nil {
		// Mark as failed (will trigger compensation on recovery)
		c.checkpoint(ctx, sagaID, stepIndex, "failed", stepData)
		return err
	}

	// 3. Checkpoint AFTER execution (mark as completed)
	return c.checkpoint(ctx, sagaID, stepIndex, "completed", stepData)
}

func (c *SagaCheckpointer) checkpoint(
	ctx context.Context,
	sagaID string,
	stepIndex int,
	status string,
	data any,
) error {
	dataJSON, _ := json.Marshal(data)

	_, err := c.db.ExecContext(ctx, `
		INSERT INTO saga_checkpoints (saga_id, step_index, status, step_data, checkpointed_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (saga_id, step_index) DO UPDATE SET
			status = EXCLUDED.status,
			step_data = EXCLUDED.step_data,
			checkpointed_at = EXCLUDED.checkpointed_at
	`, sagaID, stepIndex, status, dataJSON, time.Now())

	return err
}

// RecoverSaga recovers a saga after crash
func (c *SagaCheckpointer) RecoverSaga(ctx context.Context, sagaID string) (*RecoveryPlan, error) {
	rows, err := c.db.QueryContext(ctx, `
		SELECT step_index, status, step_data FROM saga_checkpoints
		WHERE saga_id = $1
		ORDER BY step_index
	`, sagaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	plan := &RecoveryPlan{
		SagaID:           sagaID,
		CompletedSteps:   []int{},
		StepsToCompensate: []int{},
	}

	var lastExecutingStep int = -1

	for rows.Next() {
		var stepIndex int
		var status string
		var stepData []byte

		if err := rows.Scan(&stepIndex, &status, &stepData); err != nil {
			return nil, err
		}

		switch status {
		case "completed":
			plan.CompletedSteps = append(plan.CompletedSteps, stepIndex)
		case "executing":
			// Was executing when crash happened
			// Conservative: assume it didn't complete, compensate
			lastExecutingStep = stepIndex
		case "failed":
			// Explicitly failed, need compensation
			plan.StepsToCompensate = append(plan.StepsToCompensate, stepIndex)
		}
	}

	// If last step was executing, we don't know if it completed
	// Check with idempotent verification or compensate to be safe
	if lastExecutingStep >= 0 {
		plan.NeedsVerification = true
		plan.VerifyStep = lastExecutingStep
	}

	return plan, nil
}

type RecoveryPlan struct {
	SagaID            string
	CompletedSteps    []int
	StepsToCompensate []int
	NeedsVerification bool
	VerifyStep        int
}
```

**What FAANG expects:** The expected answer names at least two of: transactional outbox, event sourcing, durable execution (Temporal), and checkpointing. Candidates who only say "just use Temporal" are asked to explain how Temporal actually provides the guarantee (event-sourced history, deterministic replay, activity heartbeats). The strongest answers distinguish between orchestrator crash (rebuild state from persisted saga log) and participant crash (idempotent retries plus outbox).

**Follow-ups:**
1. "Your orchestrator writes saga state to Postgres and publishes the command to Kafka. If the Postgres write succeeds and the Kafka publish fails, what happens on restart?" (Expected: transactional outbox, relay publishes from outbox table, never publish outside the state-change transaction.)
2. "How does Temporal guarantee exactly-once activity completion?" (Expected: it does not. It guarantees exactly-once from the workflow's perspective through replay, but the activity itself is at-least-once. Idempotency in the activity is required.)
3. "An orchestrator node runs sagas in memory for performance, checkpointing every N seconds. The node crashes. How much progress can be lost and how do you bound it?" (Expected: up to N seconds of un-checkpointed work. Bound it by checkpointing after every externally visible side effect, not on a timer.)

### Question 4: How does the pivot transaction pattern work?

**Answer:**

```go
// pkg/saga/interview/pivot.go
package interview

/*
PIVOT TRANSACTION PATTERN

A pivot transaction is the "point of no return" in a saga.
Before the pivot: Steps can be compensated (rolled back)
After the pivot: Steps must be retried until success (forward recovery)

Why use pivot transactions?
1. Some operations are not compensatable (e.g., sending email)
2. Some operations are too costly to undo (e.g., physical shipment)
3. Business rules require commitment past a certain point

Example: Order Fulfillment Saga

[Create Order] → [Reserve Inventory] → [Charge Payment] → ‖PIVOT‖ → [Ship Order] → [Send Email]
    ↓                    ↓                    ↓                           ↓              ↓
 Compensate          Compensate          Compensate            Must retry      Best effort
 (cancel)           (release)            (refund)               forever

Design Rules:
1. All steps before pivot must have compensations
2. Pivot transaction MUST eventually succeed (retry forever)
3. Steps after pivot use forward recovery only
4. Choose pivot carefully - it's the business commitment point
*/

import (
	"context"
	"fmt"
	"time"
)

// PivotSaga implements saga with pivot transaction
type PivotSaga struct {
	prePivotSteps  []SagaStep
	pivotStep      SagaStep
	postPivotSteps []SagaStep
	maxPivotRetries int
}

type SagaStep struct {
	Name       string
	Execute    func(ctx context.Context) error
	Compensate func(ctx context.Context) error // nil for post-pivot
}

func (s *PivotSaga) Execute(ctx context.Context) error {
	completedPre := []SagaStep{}

	// Execute pre-pivot steps (compensatable)
	for _, step := range s.prePivotSteps {
		if err := step.Execute(ctx); err != nil {
			// Compensate in reverse order
			s.compensateSteps(ctx, completedPre)
			return fmt.Errorf("pre-pivot step %s failed: %w", step.Name, err)
		}
		completedPre = append(completedPre, step)
	}

	// Execute pivot step (must succeed - retry forever)
	if err := s.executePivot(ctx); err != nil {
		// Pivot failed after max retries - compensate pre-pivot
		s.compensateSteps(ctx, completedPre)
		return fmt.Errorf("pivot transaction failed: %w", err)
	}

	// Execute post-pivot steps (forward recovery only)
	for _, step := range s.postPivotSteps {
		// Retry until success - no compensation available
		if err := s.executeWithRetry(ctx, step); err != nil {
			// Log error but continue - we're past the point of no return
			// Alert operations for manual intervention
			fmt.Printf("WARNING: post-pivot step %s failing: %v\n", step.Name, err)
		}
	}

	return nil
}

func (s *PivotSaga) executePivot(ctx context.Context) error {
	var lastErr error

	for attempt := 1; attempt <= s.maxPivotRetries; attempt++ {
		if err := s.pivotStep.Execute(ctx); err != nil {
			lastErr = err
			// Exponential backoff
			time.Sleep(time.Duration(attempt*attempt) * time.Second)
			continue
		}
		return nil
	}

	return fmt.Errorf("pivot failed after %d attempts: %w", s.maxPivotRetries, lastErr)
}

func (s *PivotSaga) executeWithRetry(ctx context.Context, step SagaStep) error {
	// For post-pivot, retry indefinitely (with backoff)
	attempt := 0
	for {
		attempt++
		if err := step.Execute(ctx); err != nil {
			// Log and continue retrying
			delay := time.Duration(min(attempt*attempt, 300)) * time.Second
			time.Sleep(delay)
			continue
		}
		return nil
	}
}

func (s *PivotSaga) compensateSteps(ctx context.Context, steps []SagaStep) {
	for i := len(steps) - 1; i >= 0; i-- {
		if steps[i].Compensate != nil {
			steps[i].Compensate(ctx)
		}
	}
}

// Example usage for order fulfillment
func NewOrderFulfillmentSaga() *PivotSaga {
	return &PivotSaga{
		prePivotSteps: []SagaStep{
			{
				Name:       "create_order",
				Execute:    createOrder,
				Compensate: cancelOrder,
			},
			{
				Name:       "reserve_inventory",
				Execute:    reserveInventory,
				Compensate: releaseInventory,
			},
			{
				Name:       "authorize_payment",
				Execute:    authorizePayment,
				Compensate: voidAuthorization,
			},
		},
		pivotStep: SagaStep{
			Name:       "capture_payment",
			Execute:    capturePayment,
			Compensate: nil, // Pivot - no compensation
		},
		postPivotSteps: []SagaStep{
			{
				Name:       "create_shipment",
				Execute:    createShipment,
				Compensate: nil, // Forward recovery only
			},
			{
				Name:       "send_confirmation",
				Execute:    sendConfirmation,
				Compensate: nil, // Best effort
			},
		},
		maxPivotRetries: 10,
	}
}

func createOrder(ctx context.Context) error { return nil }
func cancelOrder(ctx context.Context) error { return nil }
func reserveInventory(ctx context.Context) error { return nil }
func releaseInventory(ctx context.Context) error { return nil }
func authorizePayment(ctx context.Context) error { return nil }
func voidAuthorization(ctx context.Context) error { return nil }
func capturePayment(ctx context.Context) error { return nil }
func createShipment(ctx context.Context) error { return nil }
func sendConfirmation(ctx context.Context) error { return nil }
```

**What FAANG expects:** The core insight is that not all steps are compensatable, so the saga has a "point of no return" after which only forward recovery is valid. Strong candidates name concrete pivot examples (authorize-then-capture for payments, decrement-inventory-then-ship for fulfillment) and explain that pivot steps must retry effectively forever against a highly available downstream, because failing past the pivot means manual remediation.

**Follow-ups:**
1. "How do you choose where the pivot lives in an order saga?" (Expected: at the earliest point where a later compensation is externally visible or financially costly, typically payment capture or shipment dispatch.)
2. "Your pivot is 'charge card.' The downstream payment processor is down for an hour. What do you do?" (Expected: keep retrying with backoff, hold the saga in `pivot_pending` state, alert if SLO exceeded, never compensate pre-pivot steps once pivot has started but not completed, because the card might actually have been charged.)
3. "How does Temporal naturally support pivot semantics?" (Expected: activities past the pivot use forward retry policies with unbounded attempts or very long `StartToCloseTimeout`. Pre-pivot activities use bounded retries and rely on the `defer` compensation pattern.)

### Question 5: How would you implement saga observability?

**Answer:**

```go
// pkg/saga/interview/observability.go
package interview

import (
	"context"
	"encoding/json"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

/*
SAGA OBSERVABILITY

Four pillars for saga observability:

1. METRICS
   - Saga success/failure rates
   - Step duration histograms
   - Compensation frequency
   - In-flight saga count
   - Retry counts

2. TRACING
   - End-to-end saga trace
   - Step-level spans
   - Cross-service correlation
   - Compensation tracking

3. LOGGING
   - Structured saga events
   - Step transitions
   - Error details
   - Compensation actions

4. VISUALIZATION
   - Saga state dashboard
   - Real-time saga monitoring
   - Historical analysis
   - Alerting integration
*/

// SagaObserver provides comprehensive saga observability
type SagaObserver struct {
	tracer     trace.Tracer
	metrics    *SagaMetrics
	eventStore EventStore
}

type EventStore interface {
	Store(ctx context.Context, event SagaEvent) error
	GetSagaEvents(ctx context.Context, sagaID string) ([]SagaEvent, error)
}

type SagaMetrics struct {
	totalSagas       *prometheus.CounterVec
	sagaDuration     *prometheus.HistogramVec
	stepDuration     *prometheus.HistogramVec
	compensations    *prometheus.CounterVec
	sagasInProgress  prometheus.Gauge
	retryCount       *prometheus.CounterVec
}

func NewSagaMetrics(reg prometheus.Registerer) *SagaMetrics {
	m := &SagaMetrics{
		totalSagas: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_executions_total",
				Help: "Total number of saga executions",
			},
			[]string{"saga_type", "status"},
		),
		sagaDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "saga_duration_seconds",
				Help:    "Time to complete saga",
				Buckets: []float64{0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300},
			},
			[]string{"saga_type", "status"},
		),
		stepDuration: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "saga_step_duration_seconds",
				Help:    "Time to complete saga step",
				Buckets: []float64{0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10},
			},
			[]string{"saga_type", "step_name", "status"},
		),
		compensations: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_compensations_total",
				Help: "Total number of saga compensations",
			},
			[]string{"saga_type", "step_name"},
		),
		sagasInProgress: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "sagas_in_progress",
				Help: "Number of sagas currently executing",
			},
		),
		retryCount: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "saga_step_retries_total",
				Help: "Total number of step retries",
			},
			[]string{"saga_type", "step_name"},
		),
	}

	reg.MustRegister(
		m.totalSagas,
		m.sagaDuration,
		m.stepDuration,
		m.compensations,
		m.sagasInProgress,
		m.retryCount,
	)

	return m
}

// SagaEvent represents a saga lifecycle event
type SagaEvent struct {
	SagaID     string                 `json:"saga_id"`
	SagaType   string                 `json:"saga_type"`
	EventType  string                 `json:"event_type"`
	StepName   string                 `json:"step_name,omitempty"`
	Status     string                 `json:"status"`
	Timestamp  time.Time              `json:"timestamp"`
	Duration   time.Duration          `json:"duration,omitempty"`
	Error      string                 `json:"error,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
	TraceID    string                 `json:"trace_id"`
	SpanID     string                 `json:"span_id"`
}

// ObservableSaga wraps a saga with observability
type ObservableSaga struct {
	sagaID   string
	sagaType string
	observer *SagaObserver
	span     trace.Span
}

// Start begins saga observation
func (o *SagaObserver) Start(ctx context.Context, sagaType, sagaID string) (*ObservableSaga, context.Context) {
	// Start distributed trace
	ctx, span := o.tracer.Start(ctx, "saga:"+sagaType,
		trace.WithAttributes(
			attribute.String("saga.id", sagaID),
			attribute.String("saga.type", sagaType),
		),
	)

	// Update metrics
	o.metrics.sagasInProgress.Inc()

	// Store event
	o.eventStore.Store(ctx, SagaEvent{
		SagaID:    sagaID,
		SagaType:  sagaType,
		EventType: "saga_started",
		Status:    "running",
		Timestamp: time.Now(),
		TraceID:   span.SpanContext().TraceID().String(),
		SpanID:    span.SpanContext().SpanID().String(),
	})

	return &ObservableSaga{
		sagaID:   sagaID,
		sagaType: sagaType,
		observer: o,
		span:     span,
	}, ctx
}

// StartStep begins step observation
func (s *ObservableSaga) StartStep(ctx context.Context, stepName string) (context.Context, func(error)) {
	startTime := time.Now()

	ctx, span := s.observer.tracer.Start(ctx, "step:"+stepName,
		trace.WithAttributes(
			attribute.String("saga.step", stepName),
		),
	)

	s.observer.eventStore.Store(ctx, SagaEvent{
		SagaID:    s.sagaID,
		SagaType:  s.sagaType,
		EventType: "step_started",
		StepName:  stepName,
		Status:    "executing",
		Timestamp: time.Now(),
	})

	return ctx, func(err error) {
		duration := time.Since(startTime)
		status := "success"

		if err != nil {
			status = "failed"
			span.RecordError(err)
			s.span.SetAttributes(attribute.String("saga.failed_step", stepName))
		}

		span.End()

		s.observer.metrics.stepDuration.WithLabelValues(
			s.sagaType, stepName, status,
		).Observe(duration.Seconds())

		s.observer.eventStore.Store(ctx, SagaEvent{
			SagaID:    s.sagaID,
			SagaType:  s.sagaType,
			EventType: "step_completed",
			StepName:  stepName,
			Status:    status,
			Duration:  duration,
			Timestamp: time.Now(),
			Error:     errorString(err),
		})
	}
}

// RecordCompensation records a compensation execution
func (s *ObservableSaga) RecordCompensation(ctx context.Context, stepName string) {
	s.observer.metrics.compensations.WithLabelValues(s.sagaType, stepName).Inc()

	s.observer.eventStore.Store(ctx, SagaEvent{
		SagaID:    s.sagaID,
		SagaType:  s.sagaType,
		EventType: "compensation_executed",
		StepName:  stepName,
		Timestamp: time.Now(),
	})
}

// RecordRetry records a step retry
func (s *ObservableSaga) RecordRetry(stepName string) {
	s.observer.metrics.retryCount.WithLabelValues(s.sagaType, stepName).Inc()
}

// Complete marks saga as complete
func (s *ObservableSaga) Complete(ctx context.Context, duration time.Duration, err error) {
	status := "success"
	if err != nil {
		status = "failed"
	}

	s.observer.metrics.sagasInProgress.Dec()
	s.observer.metrics.totalSagas.WithLabelValues(s.sagaType, status).Inc()
	s.observer.metrics.sagaDuration.WithLabelValues(s.sagaType, status).Observe(duration.Seconds())

	s.observer.eventStore.Store(ctx, SagaEvent{
		SagaID:    s.sagaID,
		SagaType:  s.sagaType,
		EventType: "saga_completed",
		Status:    status,
		Duration:  duration,
		Timestamp: time.Now(),
		Error:     errorString(err),
	})

	s.span.End()
}

// GetSagaTimeline retrieves complete saga execution timeline
func (o *SagaObserver) GetSagaTimeline(ctx context.Context, sagaID string) ([]SagaEvent, error) {
	return o.eventStore.GetSagaEvents(ctx, sagaID)
}

// GenerateSagaDashboard creates dashboard JSON for Grafana
func GenerateSagaDashboard() string {
	dashboard := map[string]any{
		"title": "Saga Observability",
		"panels": []map[string]any{
			{
				"title": "Saga Success Rate",
				"type":  "gauge",
				"targets": []map[string]any{
					{
						"expr": `sum(rate(saga_executions_total{status="success"}[5m])) / sum(rate(saga_executions_total[5m])) * 100`,
					},
				},
			},
			{
				"title": "Saga Duration (p99)",
				"type":  "timeseries",
				"targets": []map[string]any{
					{
						"expr": `histogram_quantile(0.99, rate(saga_duration_seconds_bucket[5m]))`,
					},
				},
			},
			{
				"title": "Compensations Rate",
				"type":  "timeseries",
				"targets": []map[string]any{
					{
						"expr": `sum(rate(saga_compensations_total[5m])) by (saga_type, step_name)`,
					},
				},
			},
			{
				"title": "Sagas In Progress",
				"type":  "stat",
				"targets": []map[string]any{
					{
						"expr": `sagas_in_progress`,
					},
				},
			},
		},
	}

	b, _ := json.MarshalIndent(dashboard, "", "  ")
	return string(b)
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
```

**What FAANG expects:** Candidates should frame saga observability as more than per-service tracing. The saga is the unit of observation, not the request, so every event, span, and metric must carry the saga id. Strong answers name specific metrics (in-flight count, step duration histograms, compensation rate, stuck-saga alerts by age) and distinguish between operational metrics (for SRE dashboards) and business metrics (revenue at risk from stuck sagas).

**Follow-ups:**
1. "How do you alert on a stuck saga without false positives from legitimately long workflows like subscription renewals that wait 30 days?" (Expected: per-saga-type SLO on convergence time, not a global timeout. Temporal's workflow timeout plus custom metric for `age > sla`.)
2. "What single dashboard would you build first if you only had time for one?" (Expected: in-flight sagas by state and age, with a drill-down into the oldest few. This surfaces compensation failures and stuck sagas immediately.)
3. "Your compensation rate jumps from 0.1 percent to 2 percent overnight. How do you root-cause it?" (Expected: group compensations by failed step, correlate with deploys and downstream-service error rates, inspect a handful of saga histories end-to-end, check whether the spike is in a single saga type or broad.)

### Junior -> FAANG: Interview Mechanics for Saga Questions

Saga questions appear in two interview formats: the system design round ("design an order fulfillment system for 10 million orders per day") and the technical depth round ("explain how you would handle compensation failures in a distributed saga"). The mechanics differ for each.

In the system design round, bring up sagas proactively when the design requires consistency across multiple services. Do not wait to be asked. Say: "since each service has its own database, I need to handle cross-service consistency. I would use the saga pattern with orchestration for this workflow because it has five steps and I want the full state visible in one place." This signals that you know the trade-off space, not just the pattern name.

In the technical depth round, use the "situation, mechanism, failure mode" structure for every answer. For idempotency: "compensations must be idempotent (situation) because network retries and orchestrator restarts cause them to execute more than once (mechanism), and without idempotency a double-executed compensation like a refund charges the customer twice or releases inventory twice, leaving the system in an inconsistent state (failure mode)." This structure demonstrates you understand not just the rule but why the rule exists.

Before any saga interview, practice these three calculations: (1) worst-case saga completion time given step count, maximum retries, and step timeout, (2) worst-case compensation time given the same parameters, (3) convergence SLO given both. Being able to do this calculation on a whiteboard shows operational maturity that distinguishes a strong candidate from one who can only recite pattern definitions.

### Senior @ FAANG: Bar-Raiser Signals in Saga Interview Questions

Bar raisers at FAANG use saga questions to distinguish L5 from L6 candidates. The L5 candidate answers correctly. The L6 candidate answers correctly and then broadens to the organizational and governance implications without being prompted.

For Question 1 (choreography vs. orchestration), the L6 signal is extending the answer to team topology: "choreography couples implicit saga flow to the event schema, which means any team changing their event schema can break sagas they don't own. At scale this requires a schema registry with backwards compatibility enforcement. Orchestration centralizes that coupling in the orchestrator definition, which is a smaller, more controllable surface area but requires the orchestrator team to be involved in every saga change." The bar raiser follow-up to this is "how would you enforce schema compatibility in a choreography-based saga platform," which expects an answer about schema registries, Confluent Schema Registry or Buf Schema Registry, and compatibility modes (forward, backward, full).

For Question 2 (compensation failure), the L6 signal is distinguishing between compensation failure modes by root cause: "transient failure (network timeout) requires retry with jitter, permanent failure (business rule violation, like a refund window expired) requires a human intervention workflow with a structured manual action, and semantic failure (the compensation is technically possible but not meaningful, like canceling a shipped order) requires a different compensation path that issues a return label instead of reverting the shipment." The bar raiser follow-up is "how does your system distinguish between these three failure types at runtime," which expects an answer about structured error types, not string matching on error messages.

For Question 3 (crash recovery), the L6 signal is naming the specific scenario that breaks naive recovery implementations: "if the orchestrator writes saga state to Postgres and publishes the next command to Kafka in two separate operations, and it crashes between the Postgres commit and the Kafka publish, recovery will find the saga in a state that implies the command was sent but the command was not actually sent. If the command is a compensation (release inventory), skipping it leaves inventory permanently reserved. The only correct fix is the transactional outbox: write the command into an outbox table in the same Postgres transaction as the state update, and have a separate relay process publish from the outbox. Now the invariant is always maintained: either both the state change and the outbox row exist, or neither does."

---
