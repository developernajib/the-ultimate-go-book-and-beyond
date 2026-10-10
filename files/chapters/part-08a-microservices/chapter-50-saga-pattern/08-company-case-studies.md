## 50.6 Company Case Studies

### Netflix: Saga Orchestration at Scale

Netflix processes millions of content-related transactions daily, from user signup flows to content licensing, and built Conductor (open-sourced in 2016 and documented in Netflix TechBlog's architectural overview of microservice orchestration) to run exactly these orchestration-based sagas across its microservices platform.

```go
// pkg/saga/netflix/conductor_saga.go
package netflix

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

/*
Netflix Conductor Saga Pattern:
- Custom workflow orchestration engine (open-sourced as Conductor)
- DSL-based workflow definitions for sagas
- Built-in compensation handling
- Visual workflow monitoring

Key Features:
1. JSON DSL for saga definition
2. Automatic retries with exponential backoff
3. Dead letter queue for failed compensations
4. Real-time execution visualization
*/

// ConductorClient interfaces with Netflix Conductor
type ConductorClient struct {
	baseURL    string
	httpClient *http.Client
	logger     *slog.Logger
}

// SagaWorkflow represents a Netflix Conductor workflow
type SagaWorkflow struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Version     int             `json:"version"`
	Tasks       []WorkflowTask  `json:"tasks"`
	FailureFlow []WorkflowTask  `json:"failureWorkflow,omitempty"`
}

// WorkflowTask represents a task in the workflow
type WorkflowTask struct {
	Name              string                 `json:"name"`
	TaskReferenceName string                 `json:"taskReferenceName"`
	Type              string                 `json:"type"`
	InputParameters   map[string]any `json:"inputParameters"`
	RetryCount        int                    `json:"retryCount"`
	RetryLogic        string                 `json:"retryLogic"`
	RetryDelaySeconds int                    `json:"retryDelaySeconds"`
}

// NewConductorClient creates a Conductor client
func NewConductorClient(baseURL string) *ConductorClient {
	return &ConductorClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		logger: slog.Default(),
	}
}

// DefineSubscriptionSaga creates the subscription saga workflow
func (c *ConductorClient) DefineSubscriptionSaga() *SagaWorkflow {
	return &SagaWorkflow{
		Name:        "subscription_saga",
		Description: "Netflix subscription signup saga with compensation",
		Version:     1,
		Tasks: []WorkflowTask{
			{
				Name:              "create_user_profile",
				TaskReferenceName: "createProfile",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"email":    "${workflow.input.email}",
					"planType": "${workflow.input.planType}",
				},
				RetryCount:        3,
				RetryLogic:        "EXPONENTIAL_BACKOFF",
				RetryDelaySeconds: 5,
			},
			{
				Name:              "setup_billing",
				TaskReferenceName: "setupBilling",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId":        "${createProfile.output.userId}",
					"paymentMethod": "${workflow.input.paymentMethod}",
					"amount":        "${workflow.input.planAmount}",
				},
				RetryCount:        3,
				RetryLogic:        "EXPONENTIAL_BACKOFF",
				RetryDelaySeconds: 10,
			},
			{
				Name:              "provision_streaming_access",
				TaskReferenceName: "provisionAccess",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId":     "${createProfile.output.userId}",
					"planType":   "${workflow.input.planType}",
					"maxDevices": "${workflow.input.maxDevices}",
				},
				RetryCount:        5,
				RetryLogic:        "FIXED",
				RetryDelaySeconds: 3,
			},
			{
				Name:              "send_welcome_email",
				TaskReferenceName: "welcomeEmail",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId": "${createProfile.output.userId}",
					"email":  "${workflow.input.email}",
				},
				RetryCount:        2,
				RetryLogic:        "FIXED",
				RetryDelaySeconds: 60,
			},
		},
		FailureFlow: []WorkflowTask{
			{
				Name:              "revoke_streaming_access",
				TaskReferenceName: "revokeAccess",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId": "${createProfile.output.userId}",
				},
			},
			{
				Name:              "cancel_billing",
				TaskReferenceName: "cancelBilling",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId":    "${createProfile.output.userId}",
					"billingId": "${setupBilling.output.billingId}",
				},
			},
			{
				Name:              "delete_user_profile",
				TaskReferenceName: "deleteProfile",
				Type:              "SIMPLE",
				InputParameters: map[string]any{
					"userId": "${createProfile.output.userId}",
				},
			},
		},
	}
}

// SagaExecutionState tracks saga state for monitoring
type SagaExecutionState struct {
	WorkflowID     string                 `json:"workflowId"`
	Status         string                 `json:"status"`
	StartTime      time.Time              `json:"startTime"`
	EndTime        *time.Time             `json:"endTime,omitempty"`
	CurrentTask    string                 `json:"currentTask"`
	CompletedTasks []string               `json:"completedTasks"`
	FailedTask     string                 `json:"failedTask,omitempty"`
	Output         map[string]any `json:"output,omitempty"`
	Error          string                 `json:"error,omitempty"`
}

// StartSaga initiates a saga workflow
func (c *ConductorClient) StartSaga(ctx context.Context, workflowName string, input map[string]any) (string, error) {
	// Netflix uses correlation IDs for distributed tracing
	correlationID := input["correlationId"].(string)

	c.logger.Info("starting saga",
		"workflow", workflowName,
		"correlationId", correlationID,
	)

	// In production, this would call Conductor API
	// POST /api/workflow/{workflowName}
	return fmt.Sprintf("saga_%s_%d", workflowName, time.Now().UnixNano()), nil
}

// GetSagaState retrieves current saga execution state
func (c *ConductorClient) GetSagaState(ctx context.Context, workflowID string) (*SagaExecutionState, error) {
	// GET /api/workflow/{workflowId}
	return &SagaExecutionState{
		WorkflowID: workflowID,
		Status:     "RUNNING",
	}, nil
}
```

### Uber: Domain-Oriented Saga with Cadence

Uber developed Cadence (precursor to Temporal, documented in Uber Engineering's publications on workflow orchestration and Domain-Oriented Microservice Architecture) for saga orchestration across their ride-booking, payment, and dispatch services. Their approach emphasizes domain boundaries and fault tolerance.

```go
// pkg/saga/uber/cadence_saga.go
package uber

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

/*
Uber Cadence Saga Patterns:
- Domain-oriented microservice architecture (DOMA)
- Each domain has its own saga orchestrator
- Cross-domain sagas use eventual consistency
- Heavy use of workflow versioning for safe updates

Key Patterns:
1. Activity heartbeating for long-running operations
2. Saga versioning for backward compatibility
3. Domain-specific compensation strategies
4. Visibility APIs for debugging
*/

// RideBookingSaga orchestrates the complete ride booking flow
type RideBookingSaga struct {
	logger      *slog.Logger
	rideService RideService
	paymentSvc  PaymentService
	dispatchSvc DispatchService
	notifySvc   NotificationService
}

// RideService handles ride creation and management
type RideService interface {
	CreateRide(ctx context.Context, req CreateRideRequest) (*Ride, error)
	CancelRide(ctx context.Context, rideID string, reason string) error
	UpdateRideStatus(ctx context.Context, rideID string, status string) error
}

// PaymentService handles payment authorization and capture
type PaymentService interface {
	AuthorizePayment(ctx context.Context, req PaymentRequest) (*PaymentAuth, error)
	CapturePayment(ctx context.Context, authID string, amountCents int64) error
	VoidAuthorization(ctx context.Context, authID string) error
	RefundPayment(ctx context.Context, paymentID string, amountCents int64) error
}

// DispatchService handles driver dispatch
type DispatchService interface {
	FindDriver(ctx context.Context, req DispatchRequest) (*Driver, error)
	AssignDriver(ctx context.Context, rideID, driverID string) error
	ReleaseDriver(ctx context.Context, driverID string) error
}

// NotificationService handles user notifications
type NotificationService interface {
	SendRideConfirmation(ctx context.Context, userID, rideID string) error
	SendRideCancellation(ctx context.Context, userID, rideID, reason string) error
	SendDriverAssigned(ctx context.Context, userID, driverID string) error
}

// CreateRideRequest contains ride creation details
type CreateRideRequest struct {
	UserID      string
	Pickup      Location
	Dropoff     Location
	RideType    string
	PaymentID   string
	EstimatedFareCents int64
}

// Location represents a geographic location
type Location struct {
	Lat     float64
	Lng     float64
	Address string
}

// Ride represents a ride booking
type Ride struct {
	ID            string
	UserID        string
	DriverID      string
	Status        string
	Pickup        Location
	Dropoff       Location
	EstimatedFareCents int64
	ActualFareCents    int64
}

// PaymentRequest contains payment details
type PaymentRequest struct {
	UserID    string
	PaymentID string
	AmountCents int64
	RideID    string
}

// PaymentAuth represents payment authorization
type PaymentAuth struct {
	AuthID    string
	AmountCents int64
	ExpiresAt time.Time
}

// DispatchRequest contains dispatch requirements
type DispatchRequest struct {
	RideID   string
	Pickup   Location
	RideType string
}

// Driver represents a driver
type Driver struct {
	ID       string
	Name     string
	Location Location
	ETA      time.Duration
}

// SagaState tracks the ride booking saga state
type SagaState struct {
	RideID      string
	PaymentAuth *PaymentAuth
	Driver      *Driver
	StepsCompleted []string
}

// ExecuteRideBookingSaga runs the complete ride booking saga
func (s *RideBookingSaga) ExecuteRideBookingSaga(ctx context.Context, req CreateRideRequest) (*Ride, error) {
	state := &SagaState{}
	var err error

	// Step 1: Create ride record
	ride, err := s.createRideStep(ctx, req, state)
	if err != nil {
		return nil, fmt.Errorf("create ride failed: %w", err)
	}
	state.RideID = ride.ID
	state.StepsCompleted = append(state.StepsCompleted, "create_ride")

	// Step 2: Authorize payment (holds funds)
	state.PaymentAuth, err = s.authorizePaymentStep(ctx, req, ride.ID, state)
	if err != nil {
		s.compensate(ctx, state)
		return nil, fmt.Errorf("payment authorization failed: %w", err)
	}
	state.StepsCompleted = append(state.StepsCompleted, "authorize_payment")

	// Step 3: Find and assign driver (pivot transaction)
	state.Driver, err = s.findAndAssignDriverStep(ctx, ride, state)
	if err != nil {
		s.compensate(ctx, state)
		return nil, fmt.Errorf("driver assignment failed: %w", err)
	}
	state.StepsCompleted = append(state.StepsCompleted, "assign_driver")

	// Step 4: Send confirmation (non-compensatable)
	if err := s.sendConfirmationStep(ctx, req.UserID, ride.ID, state.Driver); err != nil {
		// Log but don't fail saga - notification is best-effort
		s.logger.Warn("notification failed", "error", err)
	}

	s.logger.Info("ride booking saga completed successfully",
		"rideId", ride.ID,
		"driverId", state.Driver.ID,
	)

	return ride, nil
}

func (s *RideBookingSaga) createRideStep(ctx context.Context, req CreateRideRequest, state *SagaState) (*Ride, error) {
	return s.rideService.CreateRide(ctx, req)
}

func (s *RideBookingSaga) authorizePaymentStep(ctx context.Context, req CreateRideRequest, rideID string, state *SagaState) (*PaymentAuth, error) {
	return s.paymentSvc.AuthorizePayment(ctx, PaymentRequest{
		UserID:    req.UserID,
		PaymentID: req.PaymentID,
		// Authorize a 20% buffer for tip/surge, in integer math
		AmountCents: req.EstimatedFareCents * 120 / 100,
		RideID:    rideID,
	})
}

func (s *RideBookingSaga) findAndAssignDriverStep(ctx context.Context, ride *Ride, state *SagaState) (*Driver, error) {
	// Find available driver
	driver, err := s.dispatchSvc.FindDriver(ctx, DispatchRequest{
		RideID:   ride.ID,
		Pickup:   ride.Pickup,
		RideType: "standard",
	})
	if err != nil {
		return nil, err
	}

	// Assign driver to ride
	if err := s.dispatchSvc.AssignDriver(ctx, ride.ID, driver.ID); err != nil {
		return nil, err
	}

	return driver, nil
}

func (s *RideBookingSaga) sendConfirmationStep(ctx context.Context, userID, rideID string, driver *Driver) error {
	if err := s.notifySvc.SendRideConfirmation(ctx, userID, rideID); err != nil {
		return err
	}
	return s.notifySvc.SendDriverAssigned(ctx, userID, driver.ID)
}

// compensate executes compensation in reverse order
func (s *RideBookingSaga) compensate(ctx context.Context, state *SagaState) {
	s.logger.Info("executing saga compensation", "completedSteps", state.StepsCompleted)

	// Compensate in reverse order
	for i := len(state.StepsCompleted) - 1; i >= 0; i-- {
		step := state.StepsCompleted[i]

		switch step {
		case "assign_driver":
			if state.Driver != nil {
				if err := s.dispatchSvc.ReleaseDriver(ctx, state.Driver.ID); err != nil {
					s.logger.Error("compensation failed: release driver", "error", err)
				}
			}

		case "authorize_payment":
			if state.PaymentAuth != nil {
				if err := s.paymentSvc.VoidAuthorization(ctx, state.PaymentAuth.AuthID); err != nil {
					s.logger.Error("compensation failed: void payment", "error", err)
				}
			}

		case "create_ride":
			if state.RideID != "" {
				if err := s.rideService.CancelRide(ctx, state.RideID, "saga_compensation"); err != nil {
					s.logger.Error("compensation failed: cancel ride", "error", err)
				}
			}
		}
	}
}
```

### Amazon: Saga Pattern with Step Functions

Amazon uses AWS Step Functions for saga orchestration across their e-commerce platform (detailed in AWS Architecture Center's patterns on orchestrating sagas and serverless workflows), with sophisticated compensation handling and dead letter queues.

```go
// pkg/saga/amazon/stepfunctions_saga.go
package amazon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

/*
Amazon Step Functions Saga Pattern:
- State machine-based saga definition
- Built-in error handling and retries
- Parallel execution of independent steps
- Compensation via Catch and ResultPath

Key Features:
1. Express workflows for high-volume, short-duration sagas
2. Standard workflows for long-running sagas
3. Built-in integration with SNS/SQS for async compensation
4. X-Ray integration for distributed tracing
*/

// StateMachine represents a Step Functions state machine
type StateMachine struct {
	Comment string                 `json:"Comment"`
	StartAt string                 `json:"StartAt"`
	States  map[string]State       `json:"States"`
}

// State represents a state in the state machine
type State struct {
	Type       string                 `json:"Type"`
	Resource   string                 `json:"Resource,omitempty"`
	Parameters map[string]any `json:"Parameters,omitempty"`
	Next       string                 `json:"Next,omitempty"`
	End        bool                   `json:"End,omitempty"`
	Catch      []CatchConfig          `json:"Catch,omitempty"`
	Retry      []RetryConfig          `json:"Retry,omitempty"`
	ResultPath string                 `json:"ResultPath,omitempty"`
	Branches   []Branch               `json:"Branches,omitempty"`
}

// CatchConfig defines error handling for compensation
type CatchConfig struct {
	ErrorEquals []string `json:"ErrorEquals"`
	Next        string   `json:"Next"`
	ResultPath  string   `json:"ResultPath,omitempty"`
}

// RetryConfig defines retry behavior
type RetryConfig struct {
	ErrorEquals     []string `json:"ErrorEquals"`
	IntervalSeconds int      `json:"IntervalSeconds"`
	MaxAttempts     int      `json:"MaxAttempts"`
	BackoffRate     float64  `json:"BackoffRate"`
}

// Branch represents a parallel execution branch
type Branch struct {
	StartAt string           `json:"StartAt"`
	States  map[string]State `json:"States"`
}

// OrderFulfillmentSagaBuilder builds the order fulfillment saga
type OrderFulfillmentSagaBuilder struct {
	logger *slog.Logger
}

// BuildOrderSaga creates the complete order fulfillment state machine
func (b *OrderFulfillmentSagaBuilder) BuildOrderSaga() *StateMachine {
	return &StateMachine{
		Comment: "Amazon Order Fulfillment Saga with Compensation",
		StartAt: "ValidateOrder",
		States: map[string]State{
			"ValidateOrder": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:ValidateOrder",
				Next:     "ParallelProcessing",
				Retry: []RetryConfig{
					{
						ErrorEquals:     []string{"ValidationError"},
						IntervalSeconds: 1,
						MaxAttempts:     3,
						BackoffRate:     2.0,
					},
				},
				Catch: []CatchConfig{
					{
						ErrorEquals: []string{"States.ALL"},
						Next:        "OrderValidationFailed",
						ResultPath:  "$.error",
					},
				},
			},

			// Parallel execution of independent steps
			"ParallelProcessing": {
				Type: "Parallel",
				Branches: []Branch{
					{
						StartAt: "ReserveInventory",
						States: map[string]State{
							"ReserveInventory": {
								Type:     "Task",
								Resource: "arn:aws:lambda:us-east-1:123456789:function:ReserveInventory",
								End:      true,
								Retry: []RetryConfig{
									{
										ErrorEquals:     []string{"InventoryError"},
										IntervalSeconds: 2,
										MaxAttempts:     5,
										BackoffRate:     1.5,
									},
								},
							},
						},
					},
					{
						StartAt: "AuthorizePayment",
						States: map[string]State{
							"AuthorizePayment": {
								Type:     "Task",
								Resource: "arn:aws:lambda:us-east-1:123456789:function:AuthorizePayment",
								End:      true,
								Retry: []RetryConfig{
									{
										ErrorEquals:     []string{"PaymentRetryable"},
										IntervalSeconds: 5,
										MaxAttempts:     3,
										BackoffRate:     2.0,
									},
								},
							},
						},
					},
				},
				Next: "CreateShipment",
				Catch: []CatchConfig{
					{
						ErrorEquals: []string{"States.ALL"},
						Next:        "CompensateParallel",
						ResultPath:  "$.parallelError",
					},
				},
			},

			"CreateShipment": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:CreateShipment",
				Next:     "CapturePayment",
				Catch: []CatchConfig{
					{
						ErrorEquals: []string{"States.ALL"},
						Next:        "CompensateShipment",
						ResultPath:  "$.shipmentError",
					},
				},
			},

			"CapturePayment": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:CapturePayment",
				Next:     "SendConfirmation",
				Catch: []CatchConfig{
					{
						ErrorEquals: []string{"States.ALL"},
						Next:        "CompensatePaymentCapture",
						ResultPath:  "$.captureError",
					},
				},
			},

			"SendConfirmation": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:SendConfirmation",
				Next:     "OrderComplete",
				// Notification failure doesn't trigger compensation
				Catch: []CatchConfig{
					{
						ErrorEquals: []string{"States.ALL"},
						Next:        "OrderComplete", // Continue despite notification failure
						ResultPath:  "$.notificationError",
					},
				},
			},

			"OrderComplete": {
				Type: "Succeed",
			},

			// Compensation states
			"OrderValidationFailed": {
				Type: "Fail",
			},

			"CompensateParallel": {
				Type: "Parallel",
				Branches: []Branch{
					{
						StartAt: "ReleaseInventory",
						States: map[string]State{
							"ReleaseInventory": {
								Type:     "Task",
								Resource: "arn:aws:lambda:us-east-1:123456789:function:ReleaseInventory",
								End:      true,
							},
						},
					},
					{
						StartAt: "VoidPaymentAuth",
						States: map[string]State{
							"VoidPaymentAuth": {
								Type:     "Task",
								Resource: "arn:aws:lambda:us-east-1:123456789:function:VoidPayment",
								End:      true,
							},
						},
					},
				},
				Next: "CancelOrder",
			},

			"CompensateShipment": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:CancelShipment",
				Next:     "CompensateParallel",
			},

			"CompensatePaymentCapture": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:RefundPayment",
				Next:     "CompensateShipment",
			},

			"CancelOrder": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:CancelOrder",
				Next:     "SendCancellationNotification",
			},

			"SendCancellationNotification": {
				Type:     "Task",
				Resource: "arn:aws:lambda:us-east-1:123456789:function:SendCancellation",
				Next:     "SagaFailed",
			},

			"SagaFailed": {
				Type: "Fail",
			},
		},
	}
}

// SagaExecutor executes sagas via Step Functions
type SagaExecutor struct {
	stateMachineARN string
	logger          *slog.Logger
}

// SagaExecution represents a saga execution
type SagaExecution struct {
	ExecutionARN string
	OrderID      string
	Status       string
	StartTime    time.Time
	EndTime      *time.Time
	Input        map[string]any
	Output       map[string]any
}

// StartSaga initiates an order fulfillment saga
func (e *SagaExecutor) StartSaga(ctx context.Context, order *Order) (*SagaExecution, error) {
	input, err := json.Marshal(order)
	if err != nil {
		return nil, fmt.Errorf("marshal order: %w", err)
	}

	executionARN := fmt.Sprintf(
		"arn:aws:states:us-east-1:123456789:execution:OrderSaga:%s",
		order.ID,
	)

	e.logger.Info("starting order saga",
		"orderId", order.ID,
		"executionArn", executionARN,
	)

	return &SagaExecution{
		ExecutionARN: executionARN,
		OrderID:      order.ID,
		Status:       "RUNNING",
		StartTime:    time.Now(),
		Input:        map[string]any{"order": string(input)},
	}, nil
}

// Order represents an order
type Order struct {
	ID         string
	CustomerID string
	Items      []OrderItem
	TotalAmountCents int64
	PaymentID   string
	ShippingAddress Address
}

// OrderItem represents an item in an order
type OrderItem struct {
	ProductID string
	Quantity  int
	PriceCents int64
}

// Address represents a shipping address
type Address struct {
	Street  string
	City    string
	State   string
	ZipCode string
	Country string
}
```

### Junior -> FAANG: What to Take from Case Studies Into Your Interviews

Case studies like these exist in interview preparation for one reason: interviewers ask "have you seen how large companies handle X" and expect you to name concrete approaches, not generic platitudes. The three case studies above give you specific talking points for three different saga implementation strategies.

Netflix Conductor gives you a concrete example of a declarative, DSL-based saga where the workflow definition is JSON rather than Go code. The key talking point is that a JSON DSL allows non-engineers (product managers, support engineers) to understand and sometimes modify workflow definitions without a code deployment. The trade-off is that complex conditional logic is awkward to express in a declarative DSL and often requires custom task types that push complexity back into code.

Uber's Cadence (the predecessor to Temporal) gives you a concrete example of domain-oriented saga architecture, where each domain (rides, payments, dispatch) owns its own orchestrator rather than sharing a single platform orchestrator. The key talking point is domain isolation: the ride-booking saga does not need to know the internal step sequence of the payment domain's saga, only the external interface (authorize, capture, void). Cross-domain compensation uses events rather than direct orchestrator calls. This reduces coupling at the cost of more complex compensation choreography across domain boundaries.

Amazon's Step Functions give you a concrete example of a managed, vendor-provided saga engine with built-in parallelism (the `Parallel` state type in the diagram above). The key talking point is that Step Functions allow independent saga steps to execute concurrently within the state machine, which reduces total saga latency when steps have no dependency on each other (for example, inventory reservation and payment authorization can run in parallel before shipment creation). The trade-off is that parallel compensation requires careful design to avoid races between concurrent compensation actions.

### Senior @ FAANG: Organizational Lessons from These Case Studies

The most important signal in these case studies is not the technical implementation. It is the organizational context that explains why each company made the choice it did.

**Netflix chose a declarative DSL because of team topology.** Netflix's microservices architecture distributes ownership across hundreds of small teams. A JSON DSL for workflow definitions allows teams to understand each other's workflows without reading Go code. It also enables a central workflow platform team to provide a single Conductor deployment that any team can use without understanding Go SDK internals. The cost is reduced expressiveness: complex retry logic, conditional branching, and dynamic step generation require custom task implementations that reintroduce code complexity. This trade-off is correct for Netflix's team topology. It would be wrong for a small company with three backend engineers who all read each other's code daily.

**Uber chose domain-oriented orchestrators because of Conway's Law.** Uber's DOMA (Domain-Oriented Microservice Architecture) structures teams around domains. Each domain team owns its orchestrator because the orchestrator's step sequence reflects domain business logic that only that team understands deeply. The alternative, a single company-wide orchestrator, would create a bottleneck team that all other teams depend on for workflow changes and becomes a political coordination problem at scale. Staff engineers at FAANG must think in Conway's Law terms: the architecture you choose must be maintainable by the team topology you have, not an idealized team topology.

**Amazon Step Functions reflects a build-versus-buy decision at the infrastructure layer.** AWS Step Functions is a managed service that eliminates the operational burden of running a distributed workflow engine. For Amazon's internal teams building on AWS infrastructure, the vendor lock-in cost is zero (they are the vendor). For an external company, Step Functions creates dependency on AWS regional availability, AWS pricing changes, and AWS feature roadmap. The governance question for a staff engineer evaluating Step Functions is not "does it have the features we need today" but "what is our migration path if AWS changes pricing significantly or if we need a feature that Step Functions does not support."

**What all three share.** Every case study above implicitly addresses the same three requirements: durable execution (sagas survive process crashes), idempotent steps (retries do not produce inconsistent state), and compensation (partial failures leave the system in a known state). The implementations differ in every other dimension. When evaluating saga infrastructure for your own organization, start from these three non-negotiable requirements and evaluate candidates on how well they satisfy them, rather than on feature count or popularity.

---
