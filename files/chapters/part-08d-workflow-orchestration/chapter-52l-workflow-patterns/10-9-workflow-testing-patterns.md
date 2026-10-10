## 9. Workflow Testing Patterns

Temporal's `testsuite` package provides a `TestWorkflowEnvironment` that executes workflows in-memory without a running Temporal server. Activities are mocked using testify's mock framework, and time is simulated so that a workflow with 48-hour timers completes in milliseconds. Signals are injected via `RegisterDelayedCallback`, which schedules signal delivery at a specific simulated time offset.

The test suite below covers the major patterns from this chapter. The saga test verifies that payment failure triggers compensations in reverse order. The state machine test sends a sequence of signals and asserts the final state and transition history. The approval test uses time simulation to trigger the 48-hour escalation path. The versioning test confirms that the latest code path executes all v3 activities. Each test follows the arrange-act-assert pattern: mock the activities, execute the workflow, then assert on the result and any expected side effects.

```go
package testing

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"
)

// WorkflowTestSuite provides reusable test infrastructure
type WorkflowTestSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
	env *testsuite.TestWorkflowEnvironment
}

func (s *WorkflowTestSuite) SetupTest() {
	s.env = s.NewTestWorkflowEnvironment()
}

func (s *WorkflowTestSuite) TearDownTest() {
	s.env.AssertExpectations(s.T())
}

// TestTravelBookingHappyPath tests successful booking
func (s *WorkflowTestSuite) TestTravelBookingHappyPath() {
	// Arrange: mock all activities with success responses
	s.env.OnActivity((*TravelActivities)(nil).BookFlight, mock.Anything, mock.Anything).
		Return("FLIGHT-123", nil)
	s.env.OnActivity((*TravelActivities)(nil).BookHotel, mock.Anything, mock.Anything).
		Return("HOTEL-456", nil)
	s.env.OnActivity((*TravelActivities)(nil).BookCar, mock.Anything, mock.Anything).
		Return("CAR-789", nil)
	s.env.OnActivity((*TravelActivities)(nil).ChargePayment,
		mock.Anything, mock.Anything, mock.Anything).
		Return("PAY-001", nil)
	s.env.OnActivity((*TravelActivities)(nil).SendConfirmation, mock.Anything, mock.Anything).
		Return(nil)

	// Act
	req := BookingRequest{
		UserID:      "user-001",
		FlightID:    "FL-NYC-LAX",
		HotelID:     "HT-LAX-001",
		CarID:       "CAR-LAX-001",
		TotalAmountCents: 150000,
	}
	s.env.ExecuteWorkflow(TravelBookingSagaWorkflow, req)

	// Assert
	s.True(s.env.IsWorkflowCompleted())
	s.NoError(s.env.GetWorkflowError())

	var result BookingResult
	s.NoError(s.env.GetWorkflowResult(&result))
	s.Equal("CONFIRMED", result.Status)
	s.Equal("FLIGHT-123", result.FlightBooking)
	s.Equal("HOTEL-456", result.HotelBooking)
	s.Equal("CAR-789", result.CarBooking)
	s.Equal("PAY-001", result.PaymentID)
}

// TestTravelBookingPaymentFailureCompensation tests compensation on payment failure
func (s *WorkflowTestSuite) TestTravelBookingPaymentFailureCompensation() {
	// Arrange: flight and hotel succeed, payment fails
	s.env.OnActivity((*TravelActivities)(nil).BookFlight, mock.Anything, mock.Anything).
		Return("FLIGHT-123", nil)
	s.env.OnActivity((*TravelActivities)(nil).BookHotel, mock.Anything, mock.Anything).
		Return("HOTEL-456", nil)
	s.env.OnActivity((*TravelActivities)(nil).BookCar, mock.Anything, mock.Anything).
		Return("CAR-789", nil)
	s.env.OnActivity((*TravelActivities)(nil).ChargePayment,
		mock.Anything, mock.Anything, mock.Anything).
		Return("", errors.New("payment declined"))

	// Expect compensations to be called
	s.env.OnActivity((*TravelActivities)(nil).CancelCar, mock.Anything, "CAR-789").
		Return(nil).Once()
	s.env.OnActivity((*TravelActivities)(nil).CancelHotel, mock.Anything, "HOTEL-456").
		Return(nil).Once()
	s.env.OnActivity((*TravelActivities)(nil).CancelFlight, mock.Anything, "FLIGHT-123").
		Return(nil).Once()

	req := BookingRequest{
		UserID:      "user-001",
		FlightID:    "FL-NYC-LAX",
		HotelID:     "HT-LAX-001",
		TotalAmountCents: 150000,
	}
	s.env.ExecuteWorkflow(TravelBookingSagaWorkflow, req)

	// Assert: workflow failed with payment error
	s.True(s.env.IsWorkflowCompleted())
	err := s.env.GetWorkflowError()
	s.Error(err)
	s.Contains(err.Error(), "PaymentFailed")
}

// TestStateMachineWorkflow tests state transitions
func (s *WorkflowTestSuite) TestStateMachineWorkflow() {
	// Register signal sending
	s.env.RegisterDelayedCallback(func() {
		s.env.SignalWorkflow("state-transition", StateTransitionSignal{
			Event:   EventApprove,
			ActorID: "manager-001",
		})
	}, 100*time.Millisecond)

	s.env.RegisterDelayedCallback(func() {
		s.env.SignalWorkflow("state-transition", StateTransitionSignal{
			Event:   EventShip,
			ActorID: "fulfillment-001",
			Data:    map[string]string{"trackingCode": "TRACK-XYZ"},
		})
	}, 200*time.Millisecond)

	s.env.RegisterDelayedCallback(func() {
		s.env.SignalWorkflow("state-transition", StateTransitionSignal{
			Event:   EventDeliver,
			ActorID: "delivery-001",
		})
	}, 300*time.Millisecond)

	// Mock all activities
	s.env.OnActivity(mock.Anything, mock.Anything).Return(nil).Maybe()

	s.env.ExecuteWorkflow(OrderStateMachineWorkflow, "order-001")

	s.True(s.env.IsWorkflowCompleted())
	s.NoError(s.env.GetWorkflowError())

	var finalState OrderWorkflowState
	s.NoError(s.env.GetWorkflowResult(&finalState))
	s.Equal(StateDelivered, finalState.CurrentState)
	s.Equal("TRACK-XYZ", finalState.TrackingCode)
}

// TestApprovalWorkflowWithTimeout tests auto-escalation on timeout
func (s *WorkflowTestSuite) TestApprovalWorkflowWithTimeout() {
	s.env.OnActivity((*ApprovalActivities)(nil).NotifyApprover,
		mock.Anything, mock.Anything, mock.Anything).
		Return(nil)
	s.env.OnActivity((*ApprovalActivities)(nil).EscalateApproval,
		mock.Anything, mock.Anything).
		Return("senior-approver-001", nil)
	s.env.OnActivity((*ApprovalActivities)(nil).RecordDecision,
		mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	// Skip ahead in time to trigger escalation
	s.env.SetTestTimeout(5 * time.Second)

	// Send approval after escalation timer fires
	s.env.RegisterDelayedCallback(func() {
		s.env.SignalWorkflow("approval-decision", ApprovalDecision{
			Approved:   true,
			ApproverID: "senior-approver-001",
			Comment:    "Approved after escalation",
		})
	}, 50*time.Hour) // After the 48h escalation timeout

	req := ApprovalRequest{
		RequestID:   "req-001",
		RequestType: "expense",
		AmountCents: 5000000, // $50,000.00 - goes to director
		RequestedBy: "employee-001",
	}

	s.env.ExecuteWorkflow(ExpenseApprovalWorkflow, req)
}

// TestWorkflowVersioning tests that versioned workflows work correctly
func (s *WorkflowTestSuite) TestWorkflowVersioning() {
	s.env.OnActivity((*VersionedActivities)(nil).ValidateOrderActivity,
		mock.Anything, "order-001").
		Return(true, nil)
	s.env.OnActivity((*VersionedActivities)(nil).NewProcessingActivity,
		mock.Anything, "order-001").
		Return(nil)
	s.env.OnActivity((*VersionedActivities)(nil).EnrichOrderActivity,
		mock.Anything, "order-001").
		Return(map[string]string{"source": "enriched"}, nil)
	s.env.OnActivity((*VersionedActivities)(nil).SendNotificationActivity,
		mock.Anything, "order-001").
		Return(nil)
	s.env.OnActivity((*VersionedActivities)(nil).CompleteOrderActivity,
		mock.Anything, "order-001").
		Return(nil)

	s.env.ExecuteWorkflow(OrderProcessingWorkflow, "order-001")

	s.True(s.env.IsWorkflowCompleted())
	s.NoError(s.env.GetWorkflowError())
}

// TestFanOutFanIn tests parallel activity execution
func (s *WorkflowTestSuite) TestFanOutFanIn() {
	items := []string{"a", "b", "c", "d", "e"}

	for _, item := range items {
		capturedItem := item
		s.env.OnActivity(ProcessItemActivity, mock.Anything, capturedItem).
			Return(fmt.Sprintf("processed:%s", capturedItem), nil)
	}

	s.env.ExecuteWorkflow(DynamicFanOutWorkflow, items)

	s.True(s.env.IsWorkflowCompleted())
	s.NoError(s.env.GetWorkflowError())

	var results []string
	s.NoError(s.env.GetWorkflowResult(&results))
	s.Len(results, len(items))
}

// TestActivityRetryBehavior tests that activities retry correctly
func (s *WorkflowTestSuite) TestActivityRetryBehavior() {
	callCount := 0
	s.env.OnActivity((*TravelActivities)(nil).BookFlight,
		mock.Anything, mock.Anything).
		Return(func(ctx any, req BookingRequest) (string, error) {
			callCount++
			if callCount < 3 {
				return "", errors.New("transient error")
			}
			return "FLIGHT-123", nil
		})

	// Other activities succeed
	s.env.OnActivity(mock.Anything, mock.Anything).Return(nil).Maybe()

	req := BookingRequest{
		UserID:   "user-001",
		FlightID: "FL-001",
	}
	s.env.ExecuteWorkflow(TravelBookingSagaWorkflow, req)

	// Should have retried 3 times before succeeding
	s.Equal(3, callCount)
}

func TestWorkflowPatterns(t *testing.T) {
	suite.Run(t, new(WorkflowTestSuite))
}

// Placeholder types for testing
type TravelActivities struct{}
func (a *TravelActivities) BookFlight(ctx any, req BookingRequest) (string, error) { return "", nil }
func (a *TravelActivities) BookHotel(ctx any, req BookingRequest) (string, error) { return "", nil }
func (a *TravelActivities) BookCar(ctx any, req BookingRequest) (string, error) { return "", nil }
func (a *TravelActivities) ChargePayment(ctx any, amountCents int64, userID string) (string, error) { return "", nil }
func (a *TravelActivities) SendConfirmation(ctx any, result BookingResult) error { return nil }
func (a *TravelActivities) CancelFlight(ctx any, bookingID string) error { return nil }
func (a *TravelActivities) CancelHotel(ctx any, bookingID string) error { return nil }
func (a *TravelActivities) CancelCar(ctx any, bookingID string) error { return nil }

type ApprovalActivities struct{}
func (a *ApprovalActivities) NotifyApprover(ctx any, req ApprovalRequest, approverID string) error { return nil }
func (a *ApprovalActivities) EscalateApproval(ctx any, req ApprovalRequest) (string, error) { return "", nil }
func (a *ApprovalActivities) RecordDecision(ctx any, req ApprovalRequest, decision ApprovalDecision) error { return nil }

type VersionedActivities struct{}
func (a *VersionedActivities) ValidateOrderActivity(ctx any, orderID string) (bool, error) { return true, nil }
func (a *VersionedActivities) NewProcessingActivity(ctx any, orderID string) error { return nil }
func (a *VersionedActivities) EnrichOrderActivity(ctx any, orderID string) (map[string]string, error) { return nil, nil }
func (a *VersionedActivities) SendNotificationActivity(ctx any, orderID string) error { return nil }
func (a *VersionedActivities) CompleteOrderActivity(ctx any, orderID string) error { return nil }
```

### Junior → FAANG: Building a Testing Habit for Workflow Code

Workflow testing with `TestWorkflowEnvironment` is non-negotiable in production. The test environment runs workflows in memory with mocked activities and simulated time, making tests fast and deterministic. The testing patterns in this section should become reflexive habits before you ship your first workflow.

**Always write the failure test first.** The happy path test confirms that the workflow works. The failure test confirms that the workflow handles failure correctly. For sagas, the compensation test is more important than the happy-path test, because the compensation logic is what prevents data inconsistency in production. If you write only the happy-path test and ship, you will discover the compensation bugs under real production failure conditions.

**`RegisterDelayedCallback` is how you test time-dependent behavior.** Workflows with 48-hour timers, 7-day delays, or 30-second heartbeat intervals cannot be tested by actually waiting. `RegisterDelayedCallback` schedules a function to run at a specific simulated time offset, allowing the test to inject signals, check state, or trigger escalation paths without waiting real time. The test suite's clock advances automatically as the workflow progresses.

**Mock specificity matters.** `s.env.OnActivity(mock.Anything, mock.Anything)` mocks any activity with any argument. This is a catch-all that hides activity-specific bugs. Use specific activity function references and specific argument matchers where possible. For the compensation test, use `mock.Anything, "FLIGHT-123"` to verify that the compensation is called with the correct booking ID captured from the forward step.

**Assert on compensation call count, not just completion.** `Return(nil).Once()` asserts that the mock is called exactly once. Without `.Once()`, a compensation that fires twice (a double-compensation bug) passes the test. Use `.Once()` for compensations and for any activity that must not be idempotent in terms of business effect.

**The test suite teardown calls `AssertExpectations`.** `s.env.AssertExpectations(s.T())` in `TearDownTest` verifies that every mock that was set up with a call count expectation was actually called that many times. This catches the case where an activity was expected to be called but was never invoked, which would silently pass without this assertion.

### Senior @ FAANG: Test Coverage Policy, Integration Testing, and Workflow Regression Testing

At staff level, workflow testing policy goes beyond individual test cases. The questions are: what coverage is required, how do you test at the integration level, and how do you prevent versioning regressions from reaching production.

**Coverage policy for workflow tests.** Unit tests with `TestWorkflowEnvironment` cover the workflow logic. But they mock activities, so they do not test the interaction between the workflow and the actual external systems. Integration tests, which run against a real Temporal cluster with real (or test-double) external services, provide the second layer. The coverage policy at FAANG typically specifies: all workflow code paths covered by unit tests (using `TestWorkflowEnvironment`), critical happy paths and failure paths covered by integration tests against a staging cluster, and load tests for workflows with fan-out to validate cluster behavior under realistic concurrency.

**Workflow history replay as a regression test.** The most valuable regression test for versioning is replaying captured production histories against new code. The test captures a workflow history (from a completed or in-flight production execution), serializes it, and then runs the new code against it in the test environment, asserting that no nondeterminism error occurs. This test catches the versioning regressions that code review cannot catch, because the history reflects real execution patterns, not just the patterns a reviewer imagines. Maintaining a library of representative captured histories is a platform testing investment that pays off significantly.

**Property-based testing for saga compensation.** The saga compensation test in this chapter tests one specific failure scenario: payment fails after flight and hotel succeed. A more thorough approach uses property-based testing to enumerate all possible failure points (which step fails, which compensations fail during rollback) and assert invariants across all scenarios. The invariants are: compensation is called for every step that succeeded, compensations are called in reverse order, compensation failure does not prevent other compensations from running. Libraries like `gopter` or `rapid` can generate these failure scenarios.

**Testing the event router.** The event router is typically tested separately from the workflow. Unit tests for the router verify that each event type maps to the correct workflow start or signal, that duplicate events produce idempotent behavior, and that `SignalWorkflow` errors for non-existent workflows are handled correctly. These tests use a fake Temporal client (implementing the `client.Client` interface) rather than the `TestWorkflowEnvironment`. Separating router tests from workflow tests keeps each test focused on its component's behavior.

**Versioning regression test protocol.** The versioning regression test is a required step in the deployment checklist:

1. Capture representative workflow histories from staging (covering each version gate's code path).
2. Run each history against the new code using the Temporal replay tool or a custom test harness.
3. Assert zero nondeterminism errors.
4. Only proceed to canary deployment if all replay tests pass.

This protocol prevents the most costly class of workflow incidents (large-scale nondeterminism freezes) with a deterministic, automated check. Establishing this protocol is a staff engineer's leverage point: it scales the organization's deployment confidence without requiring each team to independently discover the hard lesson.

---
