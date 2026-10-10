## 105B.9 Reducing Toil

### What Is Toil

The SRE Book defines toil as work that is:

- **Manual**: a human must do it by hand
- **Repetitive**: the same task done again and again
- **Automatable**: a computer could do it
- **Reactive**: triggered by a system event, not a human decision
- **Without lasting value**: does not improve the system

Examples of toil in Go service on-call:
- Restarting a pod when a health check fails (instead of liveness probe)
- Manually rotating a credential that expired (instead of auto-rotation)
- Querying a database to check if a job completed (instead of monitoring metric)
- Clearing a stuck queue by running a script (instead of dead letter queue handling)
- Bumping a configuration value when traffic increases (instead of auto-scaling)

Toil is insidious because it feels productive. You are fixing things. But you are not improving anything. The same task will recur.

### Toil Budget

**Rule: no team should spend more than 50% of engineering time on toil.**

To enforce this, toil must be measured. Track:

```go
// Example: toil tracking in a Go CLI tool for on-call engineers
package toil

import "time"

// ToilEntry represents a single toil event recorded during on-call.
type ToilEntry struct {
	Date        time.Time     `json:"date"`
	Engineer    string        `json:"engineer"`
	Description string        `json:"description"`
	Duration    time.Duration `json:"duration"`
	Service     string        `json:"service"`
	Category    ToilCategory  `json:"category"`
	Ticket      string        `json:"ticket"` // automation ticket filed, if any
}

// ToilCategory classifies toil for pattern analysis.
type ToilCategory string

const (
	ToilRestarts       ToilCategory = "service_restart"
	ToilCredentials    ToilCategory = "credential_rotation"
	ToilQueueClearing  ToilCategory = "queue_clearing"
	ToilCapacity       ToilCategory = "manual_capacity"
	ToilConfigChange   ToilCategory = "manual_config_change"
	ToilDeployment     ToilCategory = "manual_deployment_step"
	ToilInvestigation  ToilCategory = "manual_investigation"
)
```

Track toil entries. Review weekly. Calculate ratio of toil-hours to total engineering hours. If above 50%, stop and automate.

### Automation Strategies

| Toil Pattern | Automation Approach |
|---|---|
| "Restart service when health check fails" | Kubernetes liveness probe |
| "Clear stuck job queue" | Dead letter queue + Lambda/CronJob consumer |
| "Rotate credentials monthly" | Vault dynamic secrets, AWS Secrets Manager rotation |
| "Scale service before big event" | Kubernetes HPA, KEDA scheduled scaling, Karpenter for nodes |
| "Check if batch job completed" | Export job completion as Prometheus metric |
| "Archive logs older than 30 days" | Object storage lifecycle policy |
| "Restart database replica" | RDS auto-recovery, Multi-AZ failover |

### Building Internal Tooling to Reduce Toil

Not all toil can be eliminated outright, but even the remaining manual operations can be made faster, safer, and auditable. The CLI below wraps a rollback, one of the most common manual operations, with confirmation, audit logging, and consistent behavior across the team, turning a risky kubectl incantation into a reviewed tool.

```go
// Example: ops-tool - a CLI for common toil-reducing operations
// This pattern reduces toil by making manual operations scriptable,
// auditable, and consistent across the team.

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/spf13/cobra"
)

// RollbackCmd provides a safe, audited rollback mechanism.
// Instead of raw kubectl commands (error-prone, not audited),
// engineers use this tool which:
// - Confirms the target revision
// - Records the rollback event in the audit log
// - Notifies the incident channel
// - Waits for rollout completion and reports result
var rollbackCmd = &cobra.Command{
	Use:   "rollback [service] [revision]",
	Short: "Safely roll back a service deployment",
	Long: `Rolls back a service to the specified revision (or previous version).
Records the rollback event in the ops audit log and notifies the incident channel.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		service := args[0]
		ctx := context.Background()

		logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
		logger.Info("initiating rollback",
			slog.String("service", service),
			slog.String("operator", os.Getenv("USER")),
			slog.Time("at", time.Now()),
		)

		// Confirm current and target version
		current, err := getCurrentRevision(ctx, service)
		if err != nil {
			return fmt.Errorf("getting current revision: %w", err)
		}

		fmt.Printf("Current revision: %s\n", current)
		fmt.Printf("Rolling back to: previous\n")
		fmt.Printf("Confirm? [y/N]: ")

		var confirm string
		fmt.Scanln(&confirm)
		if confirm != "y" && confirm != "Y" {
			fmt.Println("Rollback canceled.")
			return nil
		}

		if err := executeRollback(ctx, service); err != nil {
			return fmt.Errorf("executing rollback: %w", err)
		}

		// Audit log
		if err := recordAuditEvent(ctx, AuditEvent{
			Action:   "rollback",
			Service:  service,
			Operator: os.Getenv("USER"),
			FromRev:  current,
			At:       time.Now(),
		}); err != nil {
			logger.Warn("failed to record audit event", slog.String("error", err.Error()))
			// Non-fatal: rollback succeeded, audit failure is a separate concern
		}

		fmt.Printf("Rollback of %s complete.\n", service)
		return nil
	},
}

type AuditEvent struct {
	Action   string
	Service  string
	Operator string
	FromRev  string
	At       time.Time
}

func getCurrentRevision(ctx context.Context, service string) (string, error) {
	// kubectl get deployment service -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
	return "v3.1.0", nil // placeholder
}

func executeRollback(ctx context.Context, service string) error {
	// kubectl rollout undo deployment/service
	return nil // placeholder
}

func recordAuditEvent(ctx context.Context, event AuditEvent) error {
	// Write to audit log system (e.g., CloudWatch, Splunk, internal DB)
	return nil // placeholder
}

func main() {
	root := &cobra.Command{Use: "ops"}
	root.AddCommand(rollbackCmd)
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}
```

### Junior → FAANG: Toil Is Technical Debt in Your On-Call Rotation

Toil is any on-call work that is manual, repetitive, and could be automated. The danger is that toil feels productive: you are fixing things, responding to alerts, and keeping the service running. But unlike feature work or reliability improvements, toil does not produce compounding value. You do the same manual steps next week, and the week after.

For a first job, keep a toil log for your first two on-call rotations. Write down every manual action you took: what it was, how long it took, and whether it is something you did before. After two rotations, the log reveals the highest-frequency toil items. File tickets for the top three. Fixing them is a direct on-call health improvement that benefits everyone on the rotation.

### Senior @ FAANG: Toil Budget and the 50% Rule

Google's SRE book establishes a rule: SRE teams should spend no more than 50% of their time on operational work (including toil). If the ratio exceeds 50%, it indicates that either the service needs more reliability investment, or the team is understaffed relative to its operational load. An L6 engineer tracks the toil ratio and uses it as a lever in staffing and investment conversations with leadership.

The toil automation approach in this section uses Go and cobra to build operational tooling. Building operational tools in Go (rather than shell scripts) provides type safety, testability, and portability: the tool can be compiled as a single binary and distributed to all engineers on the rotation without dependency installation. An L6 engineer establishes a standard for operational tooling (language, testing requirements, documentation) and maintains a shared tooling repository that all on-call engineers contribute to and benefit from.

---
