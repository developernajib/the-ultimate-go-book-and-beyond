## 11. Rollback Strategies

A rollback strategy is as important as the migration path. The system must be able to revert instantly without data loss. The rollback controller provides two modes of operation: instant rollback, which sets a feature flag to zero percent in a single atomic update, and gradual rollback, which steps the percentage down in configurable increments with a monitoring window between each step. Gradual rollback is preferred when you want to reduce traffic to the new service without a sudden spike of all requests hitting legacy at once. Every rollback event is recorded in an audit log with the trigger reason, the flag that was rolled back, and the before/after percentages, so your team can review what happened during a post-incident review.

```go
// file: internal/rollback/controller.go
package rollback

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/example/gobook/internal/featureflags"
)

// RollbackTrigger defines why a rollback was initiated.
type RollbackTrigger string

const (
	TriggerManual       RollbackTrigger = "manual"
	TriggerErrorRate    RollbackTrigger = "error_rate_threshold"
	TriggerLatency      RollbackTrigger = "latency_threshold"
	TriggerShadowDrift  RollbackTrigger = "shadow_drift_threshold"
)

// RollbackEvent records a rollback occurrence for audit.
type RollbackEvent struct {
	Timestamp time.Time
	Trigger   RollbackTrigger
	FlagName  featureflags.FlagName
	FromPct   float64
	ToPct     float64
	Notes     string
}

// Controller manages automated and manual rollback of migration flags.
type Controller struct {
	flags         *featureflags.Engine
	logger        *slog.Logger
	inProgress    atomic.Bool
	eventLog      []RollbackEvent
	alertFn       func(event RollbackEvent)
}

// NewController creates a rollback controller.
func NewController(flags *featureflags.Engine, logger *slog.Logger, alertFn func(RollbackEvent)) *Controller {
	return &Controller{
		flags:   flags,
		logger:  logger,
		alertFn: alertFn,
	}
}

// RollbackFlag immediately sets a flag to 0% rollout.
func (c *Controller) RollbackFlag(ctx context.Context, name featureflags.FlagName, trigger RollbackTrigger, notes string) error {
	if !c.inProgress.CompareAndSwap(false, true) {
		return fmt.Errorf("rollback already in progress")
	}
	defer c.inProgress.Store(false)

	current := c.getPercentage(name)

	c.flags.UpdateFlag(&featureflags.Flag{
		Name:       name,
		Enabled:    false,
		Strategy:   featureflags.StrategyAllOff,
		Percentage: 0,
	})

	event := RollbackEvent{
		Timestamp: time.Now(),
		Trigger:   trigger,
		FlagName:  name,
		FromPct:   current,
		ToPct:     0,
		Notes:     notes,
	}
	c.eventLog = append(c.eventLog, event)

	c.logger.Error("migration rollback executed",
		"flag", name,
		"trigger", trigger,
		"from_pct", current,
		"to_pct", 0,
		"notes", notes,
	)

	if c.alertFn != nil {
		c.alertFn(event)
	}

	return nil
}

// GradualRollback reduces traffic percentage incrementally with monitoring windows.
func (c *Controller) GradualRollback(
	ctx context.Context,
	name featureflags.FlagName,
	steps []float64,
	windowDuration time.Duration,
	shouldContinue func(ctx context.Context) bool,
) error {
	c.logger.Info("starting gradual rollback",
		"flag", name,
		"steps", steps,
		"window_duration", windowDuration,
	)

	for _, pct := range steps {
		c.flags.UpdateFlag(&featureflags.Flag{
			Name:       name,
			Enabled:    pct > 0,
			Strategy:   featureflags.StrategyPercentage,
			Percentage: pct,
		})

		c.logger.Info("gradual rollback step",
			"flag", name,
			"percentage", pct,
		)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(windowDuration):
		}

		if !shouldContinue(ctx) {
			c.logger.Warn("gradual rollback stopping early based on health check",
				"flag", name,
				"stopped_at_pct", pct,
			)
			return nil
		}
	}

	return nil
}

// GradualRollout advances traffic percentage incrementally - the mirror of GradualRollback.
func (c *Controller) GradualRollout(
	ctx context.Context,
	name featureflags.FlagName,
	steps []float64,
	windowDuration time.Duration,
	shouldContinue func(ctx context.Context) bool,
) error {
	c.logger.Info("starting gradual rollout",
		"flag", name,
		"steps", steps,
		"window_duration", windowDuration,
	)

	for _, pct := range steps {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if !shouldContinue(ctx) {
			c.logger.Warn("rollout paused by health check",
				"flag", name,
				"at_pct", pct,
			)
			return fmt.Errorf("rollout paused at %.1f%% by health check", pct)
		}

		c.flags.UpdateFlag(&featureflags.Flag{
			Name:       name,
			Enabled:    true,
			Strategy:   featureflags.StrategyPercentage,
			Percentage: pct,
		})

		c.logger.Info("rollout step",
			"flag", name,
			"percentage", pct,
		)

		time.Sleep(windowDuration)
	}

	return nil
}

// getPercentage retrieves the current rollout percentage for a flag.
func (c *Controller) getPercentage(name featureflags.FlagName) float64 {
	for _, f := range c.flags.GetAll() {
		if f.Name == name {
			return f.Percentage
		}
	}
	return 0
}

// AuditLog returns all rollback events.
func (c *Controller) AuditLog() []RollbackEvent {
	cp := make([]RollbackEvent, len(c.eventLog))
	copy(cp, c.eventLog)
	return cp
}
```

### Junior → FAANG: Rollback as a First-Class Migration Primitive

Rollback is not an admission of failure. It is the safety mechanism that makes incremental traffic migration safe. Engineers who treat rollback as an edge case rather than a planned operation are not ready for production migrations. The first question any engineer should ask when designing a migration is: if something goes wrong at any point in this process, how do I get back to a safe state in under five minutes?

The three-level rollback hierarchy in this implementation (instant flag flip, gradual decrease, emergency full revert) maps to three categories of production incident. A shadow divergence spike or a latency regression is handled by gradual rollback. A data corruption event or a cascading failure is handled by emergency revert. Understanding which incident type maps to which rollback tier is an entry-level production operations skill.

For Go engineers: the audit log in this implementation (`AuditLog()`) is not optional. Every rollback event must be logged with a timestamp, the initiator (automated system or human), the reason, and the traffic percentages before and after. Without this log, your post-incident review cannot reconstruct what happened and when, which means you cannot learn from the incident or demonstrate to your organization that the migration is under control.

### Senior @ FAANG: Rollback Governance and the Migration Checkpoint Protocol

At senior level, rollback governance is as important as rollback implementation. The governance artifact is the migration checkpoint protocol: a formal definition of what conditions trigger each rollback tier, who has authority to initiate a rollback at each tier, and what the recovery criteria are before re-attempting the forward migration step.

The specific governance decisions that distinguish senior migration design: first, the rollback trigger conditions must be defined before the migration begins, not improvised during an incident. For example: if shadow divergence exceeds 1% for more than 15 minutes, initiate gradual rollback to 10%. If error rate on the new service exceeds legacy error rate by more than 0.5%, initiate emergency revert. These conditions must be documented, reviewed, and encoded as automated alerts or automated rollback triggers.

Second, the authority model for rollback must be explicit. Gradual rollback should be available to any on-call engineer. Emergency revert should require acknowledgment from the migration team lead or the on-call manager, except in defined emergency conditions where the on-call engineer can act unilaterally. Ambiguity in rollback authority is a governance failure that results in delayed responses to incidents.

Third, the re-advancement criteria must be defined alongside the rollback criteria. After a rollback to 10% traffic, what evidence is required before re-attempting 25%? A 48-hour clean window at the current level? A root cause analysis document reviewed by the team? Defining these criteria before the migration prevents the common pattern where a team rolls back safely but then advances too quickly without addressing the root cause, resulting in repeated rollbacks.

The `Controller` in this implementation is the correct abstraction for connecting rollback triggers to automated alerting systems. At senior level, the `ExecuteRollback` method should emit a structured event to your incident management system (PagerDuty, Opsgenie) so that the on-call engineer is notified of any rollback event, including automated ones, within one minute of execution.

---
