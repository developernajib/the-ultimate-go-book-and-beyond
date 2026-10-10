## 8. Workflow Versioning and Migration

Temporal replays workflow history to reconstruct state after a worker restart. If the deployed workflow code differs from what originally generated the history, replay produces different decisions and Temporal raises a non-determinism error. `workflow.GetVersion` solves this by recording a version marker in the history at each branching point. Existing workflows replay with their original version number and follow the old code path. New workflows get the latest version and follow the new path. Both coexist safely in the same deployed binary.

The example below shows three version boundaries in a single order processing workflow. Version 2 added a validation step and switched to a new processing activity. Version 3 added an enrichment step. Each `GetVersion` call is independent, scoped to a specific change ID. The old code paths remain in the source until all in-flight workflows from that version have completed. The migration workflow at the end demonstrates how to extract state from old workflow executions, transform it, and apply it to new ones when `GetVersion` alone is insufficient.

```go
package versioning

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/workflow"
)

// VersionedActivities contains workflow activities
type VersionedActivities struct{}

// OldProcessingActivity was the original activity
func (a *VersionedActivities) OldProcessingActivity(ctx context.Context, orderID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Old processing", "orderID", orderID)
	return nil
}

// NewProcessingActivity is the updated activity with additional validation
func (a *VersionedActivities) NewProcessingActivity(ctx context.Context, orderID string) error {
	logger := activity.GetLogger(ctx)
	logger.Info("New processing with validation", "orderID", orderID)
	return nil
}

// ValidateOrderActivity was added in v2
func (a *VersionedActivities) ValidateOrderActivity(ctx context.Context, orderID string) (bool, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Validating order", "orderID", orderID)
	return true, nil
}

// EnrichOrderActivity was added in v3
func (a *VersionedActivities) EnrichOrderActivity(ctx context.Context, orderID string) (map[string]string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Enriching order", "orderID", orderID)
	return map[string]string{"source": "enriched"}, nil
}

// SendNotificationActivity notification added in v2
func (a *VersionedActivities) SendNotificationActivity(ctx context.Context, orderID string) error {
	return nil
}

// CompleteOrderActivity completes the order
func (a *VersionedActivities) CompleteOrderActivity(ctx context.Context, orderID string) error {
	return nil
}

const (
	versionAdded   = workflow.DefaultVersion
	versionV2      = 2
	versionV3      = 3
	versionCurrent = versionV3
)

// OrderProcessingWorkflow with comprehensive versioning
// This workflow is safe to deploy while v1 and v2 workflows are still running
func OrderProcessingWorkflow(ctx workflow.Context, orderID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting order processing", "orderID", orderID)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// === VERSION 1 → 2 BOUNDARY ===
	// Added: order validation step before processing
	// GetVersion returns DefaultVersion for existing workflows,
	// versionV2 for newly created ones
	v := workflow.GetVersion(ctx, "order-validation-added", versionAdded, versionV3)

	if v >= versionV2 {
		logger.Info("Running v2+ validation step")
		var valid bool
		if err := workflow.ExecuteActivity(ctx,
			(*VersionedActivities)(nil).ValidateOrderActivity,
			orderID).Get(ctx, &valid); err != nil {
			return fmt.Errorf("validation failed: %w", err)
		}

		if !valid {
			return fmt.Errorf("order %s failed validation", orderID)
		}
	}

	// === CORE PROCESSING (exists in all versions) ===
	// Version 2+ uses new processing activity
	processingVersion := workflow.GetVersion(ctx,
		"new-processing-activity", versionAdded, versionV3)

	if processingVersion >= versionV2 {
		if err := workflow.ExecuteActivity(ctx,
			(*VersionedActivities)(nil).NewProcessingActivity,
			orderID).Get(ctx, nil); err != nil {
			return err
		}
	} else {
		// v1 code path - still used by in-flight v1 workflows
		if err := workflow.ExecuteActivity(ctx,
			(*VersionedActivities)(nil).OldProcessingActivity,
			orderID).Get(ctx, nil); err != nil {
			return err
		}
	}

	// === VERSION 2 → 3 BOUNDARY ===
	// Added: order enrichment step
	enrichVersion := workflow.GetVersion(ctx,
		"order-enrichment-added", versionAdded, versionV3)

	if enrichVersion >= versionV3 {
		logger.Info("Running v3+ enrichment step")
		var enrichData map[string]string
		if err := workflow.ExecuteActivity(ctx,
			(*VersionedActivities)(nil).EnrichOrderActivity,
			orderID).Get(ctx, &enrichData); err != nil {
			logger.Warn("Enrichment failed (non-fatal)", "error", err)
		}
	}

	// === NOTIFICATION (added in v2) ===
	notifVersion := workflow.GetVersion(ctx,
		"notification-added", versionAdded, versionV3)

	if notifVersion >= versionV2 {
		workflow.ExecuteActivity(ctx,
			(*VersionedActivities)(nil).SendNotificationActivity, orderID).Get(ctx, nil)
	}

	// Complete order (always present)
	return workflow.ExecuteActivity(ctx,
		(*VersionedActivities)(nil).CompleteOrderActivity, orderID).Get(ctx, nil)
}

// MigrationWorkflow handles migrating workflow state when needed
func MigrationWorkflow(ctx workflow.Context, oldWorkflowID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Running migration workflow", "oldWorkflowID", oldWorkflowID)

	actOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, actOptions)

	// Step 1: Extract state from old workflow
	var state map[string]any
	if err := workflow.ExecuteActivity(ctx,
		ExtractWorkflowStateActivity, oldWorkflowID).Get(ctx, &state); err != nil {
		return fmt.Errorf("state extraction failed: %w", err)
	}

	// Step 2: Transform state to new format
	var newState map[string]any
	if err := workflow.ExecuteActivity(ctx,
		TransformStateActivity, state).Get(ctx, &newState); err != nil {
		return fmt.Errorf("state transformation failed: %w", err)
	}

	// Step 3: Apply migrated state
	return workflow.ExecuteActivity(ctx,
		ApplyMigratedStateActivity, oldWorkflowID, newState).Get(ctx, nil)
}

func ExtractWorkflowStateActivity(ctx context.Context, workflowID string) (map[string]any, error) {
	return map[string]any{"extracted": true}, nil
}

func TransformStateActivity(ctx context.Context, state map[string]any) (map[string]any, error) {
	state["migrated"] = true
	return state, nil
}

func ApplyMigratedStateActivity(ctx context.Context, workflowID string, state map[string]any) error {
	return nil
}
```

### Junior → FAANG: Understanding Why Versioning Is Hard

Workflow versioning is the area where most junior engineers hit their first production incident. The error message "nondeterminism" is alarming, the cause is non-obvious, and the remediation requires rollback or manual intervention. Understanding the mechanics prevents the incident.

**Replay is the root cause.** Temporal replays workflow history to reconstruct state after a worker restart. If the code has changed since the original execution, replay may take a different code path than the original, producing decisions that contradict the recorded history. When Temporal detects this, it raises a nondeterminism error and the workflow is stuck.

**`workflow.GetVersion` records a marker in the history.** The first time a `GetVersion` call executes for a given change ID, it writes a version marker to the history and returns `maxSupported`. On replay, it reads that marker and returns the recorded version. The running workflow code sees the recorded version and takes the original code path, even though `maxSupported` has since increased. This is the mechanism that allows old and new code to coexist.

**The change ID is the key, not the version number.** Each `GetVersion` call has a unique change ID string (e.g., `"order-validation-added"`). The version number within a change ID is independent of other change IDs. You can have `order-validation-added` at version 2 and `new-processing-activity` at version 3, and they do not interfere. Use descriptive, unique change IDs rather than generic ones like `"change-1"`.

**Do not remove old code paths prematurely.** The `OldProcessingActivity` code path must remain until every in-flight workflow started before the version 2 deployment has completed. Removing it while v1 workflows are still running produces a nondeterminism error. Operationally, this means monitoring how many workflow executions are still at version 1 before deleting the old path.

**Test versioning explicitly.** Write a test that replays a v1 workflow history against the v2/v3 code and verifies no nondeterminism error occurs. The `testsuite` package does not replay actual history, so this test requires either a Temporal test environment or a carefully constructed history fixture. It is worth the effort: it catches versioning bugs before deployment.

### Senior @ FAANG: Worker Versioning, Gate Lifecycle Management, and Deployment Protocols

Versioning at the fleet level requires thinking beyond individual `GetVersion` gates. Staff engineers design the deployment protocol, manage gate lifecycle, and evaluate when `workflow.GetVersion` is insufficient and Worker Build IDs are the correct tool.

**Worker Build IDs: the server-side alternative to `GetVersion` gates.** Worker Versioning (available in Temporal server 1.21+) allows you to assign a Build ID to each worker deployment and mark Build IDs as compatible with previous ones. The server routes existing workflow executions to workers with a compatible Build ID, and new executions to the latest Build ID. This eliminates code-level version gates for minor changes and allows major breaking changes to be isolated to specific Build IDs. The trade-off is operational complexity: Build ID sets must be managed alongside deployments, and incompatible changes require explicit promotion of a new Build ID set.

**Gate lifecycle management as a release process requirement.** Each `GetVersion` gate accumulates in the codebase. A codebase with 50 version gates is difficult to reason about and costly to replay. The gate lifecycle policy specifies: gates are deleted after all in-flight executions at the gated version have completed, verified by a Temporal API query for running executions with version markers below the gate. This query is a mandatory step in the release checklist before a gate deletion PR is merged.

**Deployment protocol for behavioral changes.** The correct protocol for a behavioral change to a production workflow:

1. Add `GetVersion` gate to the new code path, with the gate ID and max version incremented.
2. Run the versioning test suite, including replay of representative in-flight histories.
3. Deploy to staging, run smoke tests against existing execution histories.
4. Canary deploy to 5% of the production worker fleet.
5. Monitor nondeterminism error rate and workflow completion rate for 30 minutes.
6. Full fleet deployment on no regression.

Skipping the canary step is the root cause of the most severe workflow incidents, where a versioning mistake freezes thousands of executions simultaneously.

**The `MigrationWorkflow` use case: when `GetVersion` is insufficient.** `GetVersion` handles code changes within the same workflow type. If the change requires migrating to a completely new workflow type (new input schema, fundamentally different execution model), `GetVersion` cannot help. The migration workflow extracts state from the old execution, terminates or allows the old execution to complete, and starts a new execution of the new workflow type with the migrated state. This pattern requires careful coordination: the old workflow must be at a quiescent state (at a clean checkpoint, not mid-saga) before migration. Forced migration at an arbitrary mid-execution point is almost always wrong.

**Versioning as a platform maturity signal.** Organizations at workflow platform maturity level 1 have no versioning discipline: engineers deploy behavioral changes without `GetVersion` gates and discover the problem via nondeterminism incidents. At level 3, every behavioral change has a gate, gates are tested before deployment, and the gate deletion policy is enforced in the PR review checklist. At level 5, Worker Build IDs manage versioning at the deployment layer for minor changes, `GetVersion` gates are reserved for major structural changes, and the version gate inventory is continuously pruned. Publishing the maturity criteria and the current level of each team is a staff engineer's recurring contribution to the workflow platform.

**Bar-raiser signal: the candidate distinguishes between types of changes that require gates.** Not every code change requires a `GetVersion` gate. Adding a log line does not. Changing an activity's return value type does (because deserialization changes). Adding a new activity in a previously unreachable code branch may not (if the branch condition ensures it was never executed). The bar-raiser tests whether the candidate can reason from first principles about determinism, not just pattern-match on "any change = gate." A correct answer includes: "I would add a gate if the change affects which activities are scheduled, the order they are scheduled in, which timers are created, or what values are returned to the workflow."

---
