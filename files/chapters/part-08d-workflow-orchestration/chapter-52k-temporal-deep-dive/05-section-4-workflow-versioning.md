## Section 4: Workflow Versioning

### 4.1 Safe Workflow Code Updates

Deploying new workflow code without versioning causes non-determinism errors when existing workflow histories are replayed against the new code path. `workflow.GetVersion` solves this by creating branch points in the event history. Existing workflows replay through their recorded code path while new executions take the updated path.

```go
package versioning

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// OrderWorkflowV2 shows how to safely evolve a workflow definition.
// Temporal replays history, so old executions still use old code paths.
// GetVersion allows branching between old and new code.
func OrderWorkflowV2(ctx workflow.Context, input OrderInput) (*OrderResult, error) {
	const (
		// Version 1: basic flow
		// Version 2: added inventory check before reservation
		// Version 3: added loyalty points step
		DefaultVersion = workflow.DefaultVersion
		AddedInventoryCheck = 1
		AddedLoyaltyPoints  = 2
	)

	v := workflow.GetVersion(ctx, "order-process", DefaultVersion, AddedLoyaltyPoints)

	actOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, actOpts)

	// Version 2+: check inventory before reserving
	if v >= AddedInventoryCheck {
		var available bool
		if err := workflow.ExecuteActivity(ctx, "CheckInventory", input.Items).Get(ctx, &available); err != nil {
			return nil, err
		}
		if !available {
			return &OrderResult{Status: "out_of_stock"}, nil
		}
	}

	// Original reservation flow
	if err := workflow.ExecuteActivity(ctx, "ReserveInventory", input.OrderID, input.Items).Get(ctx, nil); err != nil {
		return nil, err
	}

	var chargeID string
	if err := workflow.ExecuteActivity(ctx, "ChargeCustomer",
		input.CustomerID, input.OrderID, input.TotalAmountCents).Get(ctx, &chargeID); err != nil {
		workflow.ExecuteActivity(ctx, "ReleaseInventory", input.OrderID).Get(ctx, nil)
		return nil, err
	}

	// Version 3+: award loyalty points
	if v >= AddedLoyaltyPoints {
		workflow.ExecuteActivity(ctx, "AwardLoyaltyPoints",
			input.CustomerID, input.TotalAmountCents).Get(ctx, nil)
	}

	return &OrderResult{
		OrderID:  input.OrderID,
		Status:   "completed",
		ChargeID: chargeID,
	}, nil
}
```

The `GetVersion` call takes a unique change ID string, a minimum supported version, and the maximum (current) version. On first execution, Temporal records the version in the event history and returns `maxSupported`. On replay of an existing execution, it returns the version that was recorded at that history point.

Three rules for safe versioning:

1. **Never remove a `GetVersion` call** while workflows started with an older version are still running. Removing it changes the replay path and causes non-determinism errors.
2. **Use unique change IDs** for each logical change. Two unrelated changes in the same workflow need separate `GetVersion` calls with different IDs.
3. **Clean up old version gates** only after all executions started before the change have completed. At that point, you can remove the version check and keep only the new code path.

### Junior -> FAANG: Why Versioning Catches You Off Guard

Most developers first discover workflow versioning the hard way: they push a code change that adds or removes an activity call, existing in-flight workflows immediately start panicking with nondeterminism errors, and the team has to roll back at 2am. Understanding `workflow.GetVersion` before that happens is the prerequisite gap this section addresses.

The mental model: workflow history is a tape recording of decisions. When a worker replays a workflow, it plays back the tape and checks that each decision matches what the code would produce today. If the code has changed in a way that would produce a different decision at any point, the tape and the code disagree. That disagreement is the nondeterminism error.

`GetVersion` inserts a versioned branch point into the tape. Old workflows have a specific version recorded at that branch point. New executions record a higher version. On replay, the SDK returns the version from the tape, so old workflows take the old branch and new workflows take the new branch. The tape and the code always agree.

Worked example for the interview: you want to add an inventory check before reservation. Without `GetVersion`, you insert the `CheckInventory` call and deploy. Every in-flight workflow replays through the new code, reaches the `CheckInventory` call, finds no corresponding event in history (because that call did not exist when the workflow started), and panics. With `GetVersion`, the new call only executes for workflows where `v >= AddedInventoryCheck`. Old workflows skip it entirely.

First-job habit: make `GetVersion` the first thing you add when a code review touches a workflow function. Get into the habit of treating every workflow code change as a potential replay issue.

### Senior @ FAANG: Version Gate Lifecycle, Worker Versioning, and Governance at Scale

**The three-phase lifecycle of a version gate.** Phase 1: add the gate with `minSupported = workflow.DefaultVersion` and execute the new code for `v >= newVersion`. Deploy. Phase 2: wait until all executions started before the deploy complete. Use visibility queries (`WorkflowType = "X" AND StartTime < deployTime`) to confirm zero remaining old executions. Phase 3: remove the gate entirely, keeping only the new code path, and update `minSupported` to the new version to reject any attempt to replay a pre-gate history. Skipping phase 3 accumulates dead gate code indefinitely, making workflows harder to read and reason about.

**Worker Versioning (Build IDs) as the operational alternative.** `workflow.GetVersion` is a code-level solution. Worker Versioning (introduced in Temporal Server 1.21, generally available in 1.24) is a deployment-level solution. You assign a Build ID to each worker deployment and mark that Build ID as compatible with or incompatible with previous IDs. Temporal routes existing executions to workers that are compatible with the Build ID that started them. Incompatible Build IDs receive only new executions. This allows code changes that would be breaking under `GetVersion` to be deployed safely by marking the Build ID as incompatible. The old worker fleet drains existing executions while the new fleet handles new ones. Worker Versioning is the right choice when the volume of version gates in the codebase has become a maintenance burden, or when a code change is so extensive that `GetVersion` gates would be needed at dozens of points.

**Governance: the "drain check" as a CI gate.** Teams that run high-throughput workflows (millions of executions per month) cannot rely on manual confirmation that old executions have drained before removing a gate. Automate it: a script queries Temporal visibility for executions started before the deployment timestamp that are still running. The gate removal PR is blocked by CI until that count reaches zero. This turns drain confirmation from a manual operational step into an automated safety check.

**The minSupported parameter as a forward-compatibility signal.** Setting `minSupported` to the highest deployed version when removing a gate prevents a rollback from replaying a pre-gate history against post-gate code. If a rollback is deployed that removes the gate but does not update `minSupported`, a very old workflow execution that somehow survived would replay successfully against the wrong code path. In practice this is rare, but the defensive habit of setting `minSupported` to the current version when cleaning up a gate costs nothing and prevents a subtle class of correctness bug.

**History replay testing as a required CI step.** The `worker.WorkflowReplayer` in the Temporal Go SDK can load a saved history JSON file and replay it against the current workflow code. Golden history files (one per major workflow version) committed to the repository and replayed in CI catch accidental breaking changes. Every workflow with production SLA should have at least one golden history file checked in. When a nondeterminism error occurs in production, generating the history file for the failing execution and adding it to the golden set ensures the bug cannot regress silently.

---
