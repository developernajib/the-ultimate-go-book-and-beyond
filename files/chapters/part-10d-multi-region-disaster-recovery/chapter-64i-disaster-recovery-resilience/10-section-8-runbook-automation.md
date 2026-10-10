## Section 8: Runbook Automation

Runbooks are the operational playbooks that define how to respond to incidents. In traditional operations, a runbook is a document. In modern resilience engineering, a runbook is an executable program with a decision tree, safe automated steps, and human escalation points.

```go
// file: internal/runbook/engine.go
package runbook

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// StepStatus describes the outcome of a runbook step.
type StepStatus string

const (
	StepPending   StepStatus = "pending"
	StepRunning   StepStatus = "running"
	StepSucceeded StepStatus = "succeeded"
	StepFailed    StepStatus = "failed"
	StepSkipped   StepStatus = "skipped"
	StepEscalated StepStatus = "escalated" // requires human
)

// StepResult captures execution outcome.
type StepResult struct {
	StepName   string
	Status     StepStatus
	StartedAt  time.Time
	EndedAt    time.Time
	Output     map[string]any
	Error      error
}

// Step is a single runbook action.
type Step interface {
	Name() string
	Description() string
	// Execute performs the step. Returns output data and optionally requires escalation.
	Execute(ctx context.Context, state *RunState) (output map[string]any, escalate bool, err error)
	// Rollback undoes the step if execution fails downstream.
	Rollback(ctx context.Context, state *RunState) error
}

// RunState carries shared context and outputs across steps.
type RunState struct {
	IncidentID string
	Severity   int
	Outputs    map[string]map[string]any // stepName -> output
	Metadata   map[string]any
}

// Runbook is an ordered sequence of steps.
type Runbook struct {
	Name        string
	Description string
	Version     string
	Steps       []Step
}

// ExecutionRecord is the complete log of a runbook run.
type ExecutionRecord struct {
	RunbookName string
	IncidentID  string
	StartedAt   time.Time
	EndedAt     time.Time
	Succeeded   bool
	StepResults []StepResult
}

// Executor runs runbooks with rollback support.
type Executor struct {
	logger *slog.Logger
}

func NewExecutor(logger *slog.Logger) *Executor {
	return &Executor{logger: logger.With("component", "runbook_executor")}
}

// Execute runs the runbook. On failure, rolls back completed steps in reverse order.
func (e *Executor) Execute(ctx context.Context, rb Runbook, state *RunState) (*ExecutionRecord, error) {
	if state.Outputs == nil {
		state.Outputs = make(map[string]map[string]any)
	}

	record := &ExecutionRecord{
		RunbookName: rb.Name,
		IncidentID:  state.IncidentID,
		StartedAt:   time.Now().UTC(),
	}

	e.logger.InfoContext(ctx, "runbook execution started",
		"runbook", rb.Name,
		"version", rb.Version,
		"incident_id", state.IncidentID,
		"steps", len(rb.Steps),
	)

	var completedSteps []Step

	for _, step := range rb.Steps {
		select {
		case <-ctx.Done():
			record.EndedAt = time.Now().UTC()
			return record, ctx.Err()
		default:
		}

		result := StepResult{
			StepName:  step.Name(),
			Status:    StepRunning,
			StartedAt: time.Now().UTC(),
		}

		e.logger.InfoContext(ctx, "executing runbook step",
			"step", step.Name(),
			"description", step.Description(),
		)

		output, escalate, err := step.Execute(ctx, state)
		result.EndedAt = time.Now().UTC()
		result.Output = output

		if output != nil {
			state.Outputs[step.Name()] = output
		}

		if escalate {
			result.Status = StepEscalated
			record.StepResults = append(record.StepResults, result)
			e.logger.WarnContext(ctx, "runbook step requires human escalation",
				"step", step.Name(),
				"incident_id", state.IncidentID,
			)
			record.EndedAt = time.Now().UTC()
			return record, fmt.Errorf("step %s requires human escalation", step.Name())
		}

		if err != nil {
			result.Status = StepFailed
			result.Error = err
			record.StepResults = append(record.StepResults, result)

			e.logger.ErrorContext(ctx, "runbook step failed; initiating rollback",
				"step", step.Name(),
				"error", err,
				"completed_steps", len(completedSteps),
			)

			// Rollback completed steps in reverse order.
			rollbackErrs := e.rollback(ctx, completedSteps, state)
			if len(rollbackErrs) > 0 {
				e.logger.ErrorContext(ctx, "rollback errors",
					"errors", rollbackErrs,
				)
			}

			record.EndedAt = time.Now().UTC()
			record.Succeeded = false
			return record, fmt.Errorf("runbook %s failed at step %s: %w", rb.Name, step.Name(), err)
		}

		result.Status = StepSucceeded
		record.StepResults = append(record.StepResults, result)
		completedSteps = append(completedSteps, step)

		e.logger.InfoContext(ctx, "runbook step succeeded",
			"step", step.Name(),
			"duration", result.EndedAt.Sub(result.StartedAt),
		)
	}

	record.EndedAt = time.Now().UTC()
	record.Succeeded = true

	e.logger.InfoContext(ctx, "runbook execution completed",
		"runbook", rb.Name,
		"duration", record.EndedAt.Sub(record.StartedAt),
		"steps_executed", len(completedSteps),
	)

	return record, nil
}

func (e *Executor) rollback(ctx context.Context, steps []Step, state *RunState) []error {
	var errs []error
	for i := len(steps) - 1; i >= 0; i-- {
		step := steps[i]
		e.logger.InfoContext(ctx, "rolling back step", "step", step.Name())
		if err := step.Rollback(ctx, state); err != nil {
			errs = append(errs, fmt.Errorf("rollback %s: %w", step.Name(), err))
		}
	}
	return errs
}

// --- Concrete Runbook Steps ---

// HealthCheckStep verifies that a target service is healthy.
type HealthCheckStep struct {
	name       string
	checkFn    func(ctx context.Context) (bool, error)
	escalateIf bool // if true and check fails, escalate rather than error
}

func NewHealthCheckStep(name string, checkFn func(ctx context.Context) (bool, error), escalateOnFailure bool) *HealthCheckStep {
	return &HealthCheckStep{name: name, checkFn: checkFn, escalateIf: escalateOnFailure}
}

func (s *HealthCheckStep) Name() string        { return s.name }
func (s *HealthCheckStep) Description() string { return "Verify service health before proceeding" }

func (s *HealthCheckStep) Execute(ctx context.Context, state *RunState) (map[string]any, bool, error) {
	healthy, err := s.checkFn(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("health check %s: %w", s.name, err)
	}
	if !healthy {
		if s.escalateIf {
			return map[string]any{"healthy": false}, true, nil
		}
		return map[string]any{"healthy": false}, false, errors.New("health check failed")
	}
	return map[string]any{"healthy": true}, false, nil
}

func (s *HealthCheckStep) Rollback(ctx context.Context, state *RunState) error { return nil }

// TrafficShiftStep adjusts traffic weights between regions.
type TrafficShiftStep struct {
	name      string
	shiftFn   func(ctx context.Context, weights map[string]int) error
	revertFn  func(ctx context.Context) error
	weights   map[string]int
}

func (s *TrafficShiftStep) Name() string        { return s.name }
func (s *TrafficShiftStep) Description() string { return "Shift traffic weights between regions" }

func (s *TrafficShiftStep) Execute(ctx context.Context, state *RunState) (map[string]any, bool, error) {
	if err := s.shiftFn(ctx, s.weights); err != nil {
		return nil, false, fmt.Errorf("traffic shift: %w", err)
	}
	return map[string]any{"weights_applied": s.weights}, false, nil
}

func (s *TrafficShiftStep) Rollback(ctx context.Context, state *RunState) error {
	return s.revertFn(ctx)
}
```

---

### Junior -> FAANG: The Value of Executable Runbooks

A traditional runbook is a document that tells an engineer what to do during an incident. An executable runbook is a program that does it, records everything it does, and asks for human approval at steps where automated action would be too risky. The difference in outcome is significant: a document runbook takes 15 minutes and has human error risk, an executable runbook takes 30 seconds and has no human error in the automated steps.

For interview framing: when asked "how do you reduce MTTR?", one answer is executable runbooks. Explain the pattern: encode the decision tree as code, automate the safe steps (log collection, metric queries, safe diagnostic commands), require human approval for destructive steps (database failover, service restart), and record every action with a timestamp and actor. This audit trail is the foundation of the postmortem.

First-job habit: the next time you execute a runbook manually during an incident, note every step you take. After the incident, consider which of those steps could have been automated. Submit a PR that adds automation for at least one step. Over time, you reduce the manual work for the next incident.

### Senior @ FAANG: Runbook Automation as a Platform Discipline

**The decision tree is a policy, the code is its implementation.** The decision tree structure in the runbook defines which conditions trigger which actions and which actions require human approval. This tree encodes organizational policy: "we are willing to automatically scale up the database, but we require human approval before promoting a read replica to primary." That policy must be reviewed and approved by leadership (engineering director, SRE lead), not unilaterally decided by the engineer implementing the runbook. The code is the policy's implementation. The ADR is its documentation.

**Runbook versioning and rollback.** Runbooks change as the system evolves. A runbook that was correct for service version 2.3 may be incorrect for version 2.4 (if a new database cluster was added, for example). Runbooks must be versioned alongside the service and their version recorded in the audit log of each execution. If a runbook is found to be incorrect after an incident, you need to know which version was running to understand its behavior. Runbook versioning is not optional at production scale.

**Audit log completeness and immutability.** The `Step.Execute` method should emit an audit log entry before and after each step: before to record the intent, after to record the outcome. If the process crashes mid-step, the before entry with no corresponding after entry signals an incomplete step. The audit log must be written to an append-only store (S3 with object lock, a PostgreSQL table with no-delete policy) so that it cannot be modified after the fact, even by engineers with database access. This immutability is essential for postmortem integrity.

**Human approval integration with on-call tooling.** The human approval gate in a runbook is only useful if the on-call engineer receives the approval request quickly, understands the context, and has the tools to approve or reject with confidence. This requires integration with the on-call notification system (PagerDuty, Opsgenie), a direct link to the current system state (Grafana dashboard, alert history), and a one-click approval interface that records the approver's identity. Approval requests that arrive as vague Slack messages with no context are ignored or delayed, defeating the purpose.

**Runbook coverage as a maturity metric.** The fraction of your service's on-call alerts that have associated executable runbook steps is a DR maturity metric. At L6, you track this metric quarterly and require that all new alerts have at least a diagnostic step automated (log collection, metric snapshot) even if the remediation step is manual. The goal is to progressively automate more remediation steps over time, reducing on-call burden and MTTR simultaneously. A team with 80% runbook coverage (80% of alert types have at least partial automation) is operating at high reliability maturity.

