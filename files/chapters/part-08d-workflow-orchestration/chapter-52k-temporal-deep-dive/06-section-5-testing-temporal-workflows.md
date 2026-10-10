## Section 5: Testing Temporal Workflows

### 5.1 Test Environment

Temporal's Go SDK provides a `testsuite` package that runs workflows and activities synchronously in a test harness without a running Temporal server. The test environment simulates time, signals, and activity execution deterministically. The following tests cover four critical scenarios: happy path completion, compensation on payment failure, signal-driven cancellation, and activity retry behavior.

```go
package orderworkflow_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// TestOrderWorkflow_HappyPath tests the full order workflow.
func TestOrderWorkflow_HappyPath(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	// Register workflow and activities
	env.RegisterWorkflow(OrderWorkflow)

	// Mock activities - return predefined results
	env.OnActivity("ReserveInventory", mock.Anything, "order-123", mock.Anything).
		Return(nil)

	env.OnActivity("ChargeCustomer", mock.Anything, "customer-456", "order-123", int64(9999)).
		Return("ch_test_abc", nil)

	env.OnActivity("CreateShipment", mock.Anything, "order-123", mock.Anything).
		Return("ship_xyz", nil)

	env.OnActivity("SendOrderConfirmation", mock.Anything,
		"customer-456", "order-123", "ch_test_abc").
		Return(nil)

	input := OrderInput{
		OrderID:          "order-123",
		CustomerID:       "customer-456",
		Items:            []Item{{SKU: "WIDGET", Qty: 2, PriceCents: 4999}},
		TotalAmountCents: 9999,
	}

	env.ExecuteWorkflow(OrderWorkflow, input)

	var result OrderResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}

	if result.Status != "completed" {
		t.Errorf("want status=completed, got %s", result.Status)
	}
	if result.ChargeID != "ch_test_abc" {
		t.Errorf("want charge_id=ch_test_abc, got %s", result.ChargeID)
	}
	if result.ShipmentID != "ship_xyz" {
		t.Errorf("want shipment_id=ship_xyz, got %s", result.ShipmentID)
	}
}

// TestOrderWorkflow_PaymentFails tests compensation on payment failure.
func TestOrderWorkflow_PaymentFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterWorkflow(OrderWorkflow)

	env.OnActivity("ReserveInventory", mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.OnActivity("ChargeCustomer", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return("", fmt.Errorf("card declined"))

	// Expect compensation: release inventory should be called
	releaseCalled := false
	env.OnActivity("ReleaseInventory", mock.Anything, "order-123").
		Return(nil).Run(func(args mock.Arguments) {
		releaseCalled = true
	})

	input := OrderInput{OrderID: "order-123", CustomerID: "cust-1", TotalAmountCents: 5000}
	env.ExecuteWorkflow(OrderWorkflow, input)

	var result OrderResult
	env.GetWorkflowResult(&result)

	if result.Status != "failed" {
		t.Errorf("want status=failed, got %s", result.Status)
	}
	if !releaseCalled {
		t.Error("expected ReleaseInventory compensation to be called")
	}
}

// TestLongRunningWorkflow_CancelSignal tests signal handling.
func TestLongRunningWorkflow_CancelSignal(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterWorkflow(LongRunningOrderWorkflow)

	// Send cancel signal after workflow starts
	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow(CancelOrderSignal, "customer requested cancellation")
	}, 100*time.Millisecond)

	input := OrderInput{OrderID: "order-789", CustomerID: "cust-2"}
	env.ExecuteWorkflow(LongRunningOrderWorkflow, input)

	var result OrderResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}

	if result.Status != "canceled" {
		t.Errorf("want status=canceled, got %s", result.Status)
	}
}

// TestOrderWorkflow_ActivityRetries tests retry behavior.
func TestOrderWorkflow_ActivityRetries(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterWorkflow(OrderWorkflow)

	callCount := 0
	env.OnActivity("ReserveInventory", mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Run(func(args mock.Arguments) {
		callCount++
		if callCount < 3 {
			panic(temporal.NewApplicationError("transient error", "TransientError", nil))
		}
	})

	env.OnActivity("ChargeCustomer", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return("ch_abc", nil)
	env.OnActivity("CreateShipment", mock.Anything, mock.Anything, mock.Anything).
		Return("ship_1", nil)
	env.OnActivity("SendOrderConfirmation", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	input := OrderInput{OrderID: "order-retry", CustomerID: "cust-3", TotalAmountCents: 2500}
	env.ExecuteWorkflow(OrderWorkflow, input)

	var result OrderResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}

	if result.Status != "completed" {
		t.Errorf("want completed after retries, got %s", result.Status)
	}
	if callCount != 3 {
		t.Errorf("want 3 activity calls (2 failures + 1 success), got %d", callCount)
	}
}
```

### Junior -> FAANG: Testing Without a Running Server

The biggest testing mistake beginners make with Temporal is writing integration tests that require a live cluster. That adds minutes to CI, requires network access, and makes tests non-deterministic due to timing. The `testsuite` package eliminates all of that. Every test in this section runs in milliseconds without any external dependencies.

The four test scenarios above cover the minimum required test matrix for any workflow: happy path, compensation on failure, signal handling, and retry behavior. Before your FAANG interview, be able to explain what each test asserts and why it matters. Interviewers often ask "how would you test this?" for a distributed workflow, expecting you to reach for `testsuite` rather than "spin up a Docker cluster."

Worked example to understand `RegisterDelayedCallback`: the signal test sends the cancel signal after 100ms of simulated time. Without `RegisterDelayedCallback`, there is no way to inject a signal mid-execution in the test environment. The callback fires at the specified simulated time and sends the signal. The test environment advances simulated time automatically as the workflow blocks on timers and channels.

First-job habit: write the test file before writing the workflow code. The test forces you to define the activity interface (what activities the workflow calls and with what inputs) before implementation. This also means that when you mock activities in tests, you are verifying that the workflow calls the correct activities with the correct arguments, not just that it returns the right result.

### Senior @ FAANG: Test Architecture, Golden Replay Testing, and Coverage Gaps

**Structuring the test suite for scale.** As workflow complexity grows, the test file grows with it. Organize tests by scenario, not by code path. A scenario test covers one business case end-to-end (happy path, payment-decline path, cancellation path). Each scenario test is independent and sets up its own `WorkflowTestSuite` and environment. Shared activity mocks belong in a test helper that each scenario configures by overriding specific behaviors.

**Golden history replay tests as the second test layer.** Unit tests with mocked activities verify workflow logic but do not verify that the workflow code is backward-compatible with real historical executions. Golden replay tests load a saved history file from Temporal and replay it against the current code using `worker.WorkflowReplayer`. This catches two categories of bugs that mocked activity tests cannot: nondeterminism errors introduced by code changes, and payload deserialization errors introduced by changes to activity input or output struct fields. Maintain one golden history file per production workflow version. Run replay tests in CI on every pull request.

**Coverage gaps that testsuite cannot address.** The testsuite environment does not test worker-to-server communication, namespace-level configuration, search attribute registration, or the actual retry behavior implemented by the Temporal server (it simulates retries by calling the activity mock again, not by going through the server's retry scheduling). Gap-fill these with a dedicated integration test environment (a shared development Temporal cluster or Temporal Cloud dev namespace) that runs once per day or before releases, not on every commit.

**Testing signal and Update handler ordering.** The `RegisterDelayedCallback` API fires callbacks in the order they are registered, at the specified simulated time. For tests that send multiple signals to verify ordering behavior (e.g., update-items signal followed immediately by cancel signal), control the delivery order by registering callbacks with increasing times and verifying that the final state reflects the correct processing order. If two signals arrive at the same simulated time, the test environment processes them in registration order. Document this assumption explicitly in the test comment.

**Benchmark tests for workflow task throughput.** High-throughput workflows (thousands of concurrent executions) should have benchmark tests that measure workflow task latency under simulated load. Run the test suite with `go test -bench=. -benchtime=10s` after significant changes to the workflow logic. A workflow task that takes 50ms instead of 5ms to execute will saturate a worker at 20 concurrent tasks instead of 200. Catching this in the benchmark layer is cheaper than debugging saturation in production.

**Mutation testing for critical workflows.** For workflows with financial or compliance implications, mutation testing (using a tool like `go-mutesting`) verifies that the test suite catches logic errors. A mutant that removes the `RefundCustomer` compensation call should be caught by the `TestOrderWorkflow_PaymentFails` test. If the test suite does not catch that mutation, the compensation coverage is insufficient. Mutation testing on the compensation paths of production workflows is a bar-raiser quality signal that few teams apply but all should.

---
