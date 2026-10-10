## 90J.6 AWS S3: The Typo That Broke the Internet (2017)

### The Incident

On February 28, 2017, an Amazon engineer was performing routine maintenance on the S3 storage system in the
US-EAST-1 region. The engineer needed to take a small number of servers offline to address a billing system
issue. When entering the command, the engineer mistyped the number of servers to remove, accidentally specifying
a much larger set of servers than intended. The command removed a critical mass of S3 subsystem servers,
triggering a cascading failure that took down most of the internet's infrastructure for approximately four hours.

### The Timeline

**February 28, 2017: 9:37 AM PT**

An authorized S3 team member ran a command to remove a small number of servers for the S3 billing process.
The command was entered incorrectly, removing a significantly larger set of servers than intended. The
removed servers included those supporting the S3 index subsystem (which manages the metadata for all S3
objects) and the S3 placement subsystem (which manages allocation of new storage).

**9:37 AM - 9:54 AM: The Cascade**

With the index and placement subsystems down, S3 could not process any requests - no reads, no writes, no
listings. Because S3 is a foundational service that thousands of other AWS services and millions of applications
depend on, the failure cascaded rapidly:

- **AWS services affected**: EC2 (new instance launches), EBS (new volume creation), Lambda, SQS, SNS, SES,
  CloudWatch, and dozens of others
- **Major websites down**: Slack, Trello, Quora, Business Insider, Giphy, and thousands of others
- **IoT devices offline**: Smart home devices, connected thermostats, and IoT platforms that stored state in S3
- **AWS Dashboard itself**: The AWS Service Health Dashboard could not update because it stored its status
  page assets in S3

The irony of the AWS status page being hosted on the service it was supposed to report on became an enduring
lesson in infrastructure design.

**9:54 AM - 1:54 PM: Recovery**

The recovery took approximately four hours because the S3 index and placement subsystems had to be fully
restarted - a process that had not been performed since S3's initial launch. The sheer scale of the S3
metadata (trillions of objects) meant the index subsystem took hours to rebuild.

### Financial Impact

The estimated financial impact of the outage was $150 million across affected businesses, with some estimates
going significantly higher. S&P 500 companies alone reported millions in lost revenue.

### Root Cause Analysis

1. **No blast radius limiting**: A single command could affect an unlimited number of servers
2. **No confirmation for destructive operations**: The command was executed immediately
3. **No rate limiting on server removal**: All targeted servers were removed simultaneously
4. **Circular dependency**: The status page depended on the service it reported on
5. **Cold start path untested**: The full restart procedure had never been tested at S3's current scale

### Go Code: Blast Radius Limiting System

The S3 outage demonstrates the need for blast radius limiting in infrastructure automation - ensuring that no
single command, no matter how wrong, can take down an entire system:

```go
package blastradius

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Blast radius limiter for infrastructure operations
// -----------------------------------------------------------------------

// InfraOperation represents a destructive infrastructure operation
// that must be constrained to limit its blast radius.
type InfraOperation struct {
	ID          string
	Type        string // "remove_servers", "deploy", "config_change"
	Description string
	Targets     []string
	Operator    string
	Timestamp   time.Time
}

// BlastRadiusPolicy defines the safety constraints for infrastructure
// operations.
type BlastRadiusPolicy struct {
	// MaxTargetsPerOperation limits how many targets a single operation
	// can affect. For server removal, this prevents a typo from taking
	// down an entire fleet.
	MaxTargetsPerOperation int

	// MaxPercentOfFleet limits operations to a percentage of the total
	// fleet size. Even if someone tries to remove 100 servers and the
	// absolute limit allows it, the percentage limit may not.
	MaxPercentOfFleet float64

	// RequireApprovalAbove requires human approval for operations
	// affecting more than this many targets.
	RequireApprovalAbove int

	// MinHealthyAfterOperation ensures the system maintains minimum
	// healthy capacity after the operation completes.
	MinHealthyPercent float64

	// CooldownBetweenOps prevents rapid-fire destructive operations.
	CooldownBetweenOps time.Duration

	// RollbackTimeout is how long to wait for health checks before
	// automatically rolling back.
	RollbackTimeout time.Duration
}

// OperationResult captures the outcome of an infrastructure operation.
type OperationResult struct {
	Approved      bool
	Executed      bool
	TargetsAffected int
	RejectionReason string
	ApprovalID    string
	StartTime     time.Time
	EndTime       time.Time
	RolledBack    bool
}

// FleetStatus provides the current state of the infrastructure fleet.
type FleetStatus struct {
	TotalServers   int
	HealthyServers int
	Region         string
	Service        string
}

// HealthChecker checks the health of the system after an operation.
type HealthChecker interface {
	GetFleetStatus(ctx context.Context, service string) (*FleetStatus, error)
	CheckServiceHealth(ctx context.Context, service string) (bool, error)
}

// ApprovalService handles human approval for large operations.
type ApprovalService interface {
	RequestApproval(ctx context.Context, op InfraOperation, reason string) (string, error)
	WaitForApproval(ctx context.Context, approvalID string, timeout time.Duration) (bool, error)
}

// Limiter enforces blast radius policies on infrastructure operations.
type Limiter struct {
	policy       BlastRadiusPolicy
	health       HealthChecker
	approvals    ApprovalService
	mu           sync.Mutex
	lastOpTime   time.Time
	recentOps    []InfraOperation
}

// NewLimiter creates a new blast radius limiter.
func NewLimiter(
	policy BlastRadiusPolicy,
	health HealthChecker,
	approvals ApprovalService,
) *Limiter {
	return &Limiter{
		policy:    policy,
		health:    health,
		approvals: approvals,
	}
}

// Evaluate checks whether an operation is safe to execute and either
// approves, requires human approval, or rejects it.
func (l *Limiter) Evaluate(
	ctx context.Context,
	op InfraOperation,
) (*OperationResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	result := &OperationResult{StartTime: time.Now()}

	// Check cooldown.
	if !l.lastOpTime.IsZero() {
		elapsed := time.Since(l.lastOpTime)
		if elapsed < l.policy.CooldownBetweenOps {
			result.RejectionReason = fmt.Sprintf(
				"cooldown period: %v remaining (last op: %v ago)",
				l.policy.CooldownBetweenOps-elapsed, elapsed)
			return result, nil
		}
	}

	// Check absolute target limit.
	targetCount := len(op.Targets)
	if targetCount > l.policy.MaxTargetsPerOperation {
		result.RejectionReason = fmt.Sprintf(
			"operation targets %d servers, max allowed is %d",
			targetCount, l.policy.MaxTargetsPerOperation)
		return result, nil
	}

	// Check fleet percentage limit.
	status, err := l.health.GetFleetStatus(ctx, op.Type)
	if err != nil {
		return nil, fmt.Errorf("getting fleet status: %w", err)
	}

	percentage := float64(targetCount) / float64(status.TotalServers) * 100
	if percentage > l.policy.MaxPercentOfFleet {
		result.RejectionReason = fmt.Sprintf(
			"operation affects %.1f%% of fleet, max allowed is %.1f%%",
			percentage, l.policy.MaxPercentOfFleet)
		return result, nil
	}

	// Check minimum healthy capacity after operation.
	remainingHealthy := status.HealthyServers - targetCount
	remainingPercent := float64(remainingHealthy) / float64(status.TotalServers) * 100
	if remainingPercent < l.policy.MinHealthyPercent {
		result.RejectionReason = fmt.Sprintf(
			"operation would leave %.1f%% healthy capacity, minimum is %.1f%%",
			remainingPercent, l.policy.MinHealthyPercent)
		return result, nil
	}

	// Check if human approval is required.
	if targetCount > l.policy.RequireApprovalAbove {
		fmt.Printf("[BLAST RADIUS] Operation affects %d targets - requesting approval\n",
			targetCount)

		approvalID, err := l.approvals.RequestApproval(ctx, op,
			fmt.Sprintf("Operation affects %d targets (%.1f%% of fleet)",
				targetCount, percentage))
		if err != nil {
			return nil, fmt.Errorf("requesting approval: %w", err)
		}

		approved, err := l.approvals.WaitForApproval(ctx, approvalID, 5*time.Minute)
		if err != nil {
			return nil, fmt.Errorf("waiting for approval: %w", err)
		}
		if !approved {
			result.RejectionReason = "human approval denied"
			result.ApprovalID = approvalID
			return result, nil
		}
		result.ApprovalID = approvalID
	}

	result.Approved = true
	result.TargetsAffected = targetCount
	l.lastOpTime = time.Now()
	l.recentOps = append(l.recentOps, op)

	return result, nil
}

// ExecuteWithRollback executes an approved operation with health
// monitoring and automatic rollback.
func (l *Limiter) ExecuteWithRollback(
	ctx context.Context,
	op InfraOperation,
	execute func(ctx context.Context, targets []string) error,
	rollback func(ctx context.Context, targets []string) error,
) (*OperationResult, error) {
	// First, evaluate the operation.
	result, err := l.Evaluate(ctx, op)
	if err != nil {
		return nil, err
	}
	if !result.Approved {
		return result, nil
	}

	// Execute in batches to limit blast radius further.
	batchSize := int(math.Max(1, float64(len(op.Targets))/10.0))
	var executedTargets []string

	for i := 0; i < len(op.Targets); i += batchSize {
		end := i + batchSize
		if end > len(op.Targets) {
			end = len(op.Targets)
		}
		batch := op.Targets[i:end]

		fmt.Printf("[BLAST RADIUS] Executing batch %d-%d of %d targets\n",
			i+1, end, len(op.Targets))

		if err := execute(ctx, batch); err != nil {
			fmt.Printf("[BLAST RADIUS] Batch failed: %v - initiating rollback\n", err)
			if rollbackErr := rollback(ctx, executedTargets); rollbackErr != nil {
				return nil, fmt.Errorf("rollback failed after execution error: %w (original: %v)",
					rollbackErr, err)
			}
			result.RolledBack = true
			result.EndTime = time.Now()
			return result, fmt.Errorf("operation failed at batch %d: %w", (i/batchSize)+1, err)
		}

		executedTargets = append(executedTargets, batch...)

		// Health check after each batch.
		healthy, err := l.health.CheckServiceHealth(ctx, op.Type)
		if err != nil || !healthy {
			fmt.Printf("[BLAST RADIUS] Health check failed after batch - rolling back\n")
			if rollbackErr := rollback(ctx, executedTargets); rollbackErr != nil {
				return nil, fmt.Errorf("rollback failed: %w", rollbackErr)
			}
			result.RolledBack = true
			result.EndTime = time.Now()
			return result, fmt.Errorf("service unhealthy after batch %d", (i/batchSize)+1)
		}

		fmt.Printf("[BLAST RADIUS] Batch %d-%d complete, health check passed\n",
			i+1, end)
	}

	result.Executed = true
	result.EndTime = time.Now()
	return result, nil
}
```

### Engineering Lessons

1. **No single command should be able to take down a system** - blast radius limiting is not optional.
2. **Require confirmation for destructive operations proportional to their impact**.
3. **Execute destructive changes in batches with health checks between batches**.
4. **Never host your status page on the system it monitors** - use an independent provider.
5. **Test your cold start procedures regularly** - the path you have never exercised is the path that fails.
6. **Rate limit server removal** - even authorized operations should be throttled.

---

### Junior → FAANG: Blast Radius Limiting and Independent Status Pages as Interview Patterns

AWS S3 is the interview answer to "how do you design infrastructure automation that is safe?" A command that was supposed to remove a small number of servers removed a large fraction of the S3 subsystem because the input parameter was larger than intended. Blast radius limiting means that no single command can remove more than a bounded percentage of a subsystem's capacity in one operation, regardless of what the operator passes as a parameter. The limit is enforced by the tool, not by the operator's judgment. A second interview point is independent status pages: AWS's own status page was hosted on S3 and went down with the rest of S3. Your monitoring and status page must be hosted on infrastructure that is independent from the infrastructure it monitors. For FAANG interviews, the S3 incident demonstrates that automation safety is not a testing problem, it is a constraint problem: the tool should make unsafe operations structurally impossible, not just documented as inadvisable.

### Senior @ FAANG: Infrastructure Automation Safety as a Platform Engineering Investment

At L6, the S3 incident is a platform engineering governance failure. The internal tool that caused the outage should have had rate limits enforced at the platform level, not documented in a runbook. The staff engineer's contribution is designing the automation safety framework that makes all infrastructure tooling safe by default. This requires three layers. First, every infrastructure operation that modifies capacity (adding or removing compute, storage, or networking resources) must go through a change execution framework that enforces blast radius limits, health checks between batches, and automatic rollback on anomaly detection. The framework is a platform library, not individual tool logic, so every tool gets the same safety guarantees without each team reimplementing them. Second, all automation must be executed in dry-run mode first, with the dry-run output requiring human confirmation before the real operation proceeds. The confirmation must be specific: not "yes, proceed" but "I confirm that removing 3 of 11 indexing servers (27%) is within the 20% blast radius limit for this subsystem." Third, for tools that operate on production capacity, the permission model must separate the ability to run a dry-run (available to all engineers) from the ability to execute the real operation (available only to engineers who have completed a runbook verification for that specific tool). At the organizational level, track blast radius limit violations (operations that exceeded the limit and required override approval) as a metric reported in your infrastructure risk review. A team that regularly overrides blast radius limits is a team that is building technical debt in their safety culture.

---
