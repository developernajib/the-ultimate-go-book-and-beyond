## Section 1: RTO/RPO Definitions and SLA Design

### 1.1 Core Concepts

**Recovery Time Objective (RTO)** is the maximum tolerable duration of downtime - from incident declaration to full service restoration. It answers: *how long can the business survive without this system?*

**Recovery Point Objective (RPO)** is the maximum tolerable data loss measured in time - the age of the oldest data you can restore to. It answers: *how much data can the business afford to lose?*

These are not technical goals - they are business contracts that drive every architectural decision downstream.

| Tier | Example Service | RTO | RPO | Strategy |
|------|----------------|-----|-----|----------|
| 0 | Payment processing | < 1 min | 0 (zero) | Active-Active, synchronous replication |
| 1 | Order management | < 15 min | < 5 min | Active-Passive, async replication |
| 2 | Reporting | < 4 hours | < 1 hour | Warm standby, hourly snapshots |
| 3 | Batch analytics | < 24 hours | < 24 hours | Cold standby, daily backups |

### 1.2 SLA Contract Model in Go

Encoding SLA contracts as first-class Go types makes the recovery objectives machine-checkable: services can validate at runtime whether a proposed operation would violate the RTO or RPO commitments defined in the contract. The following implementation defines `SLAContract`, `RecoveryTier`, and `ComplianceReport` types, and shows how to instrument an automated failover decision against them.

```go
// file: internal/dr/sla/contract.go
package sla

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ServiceTier classifies DR requirements for a service.
type ServiceTier int

const (
	TierCritical ServiceTier = iota // Tier 0: zero data loss, sub-minute recovery
	TierHigh                        // Tier 1: minutes RPO, 15-min RTO
	TierMedium                      // Tier 2: hourly RPO, 4-hour RTO
	TierLow                         // Tier 3: daily RPO/RTO
)

// SLAContract encodes the recovery contract for a service.
type SLAContract struct {
	ServiceName  string
	ServiceTier  ServiceTier
	RTO          time.Duration // max acceptable downtime
	RPO          time.Duration // max acceptable data loss window
	Availability float64       // e.g. 0.9999 for four nines
	Owner        string
	EscalationFn func(ctx context.Context, violation SLAViolation) error
}

// SLAViolation is raised when a measured recovery exceeds contract limits.
type SLAViolation struct {
	Contract    SLAContract
	ActualRTO   time.Duration
	ActualRPO   time.Duration
	OccurredAt  time.Time
	IncidentID  string
}

func (v SLAViolation) Error() string {
	return fmt.Sprintf(
		"SLA violation for %s: RTO=%s (limit %s), RPO=%s (limit %s)",
		v.Contract.ServiceName,
		v.ActualRTO, v.Contract.RTO,
		v.ActualRPO, v.Contract.RPO,
	)
}

// Validate checks whether measured recovery metrics satisfy the contract.
func (c SLAContract) Validate(ctx context.Context, actualRTO, actualRPO time.Duration, incidentID string) error {
	logger := slog.Default().With(
		"service", c.ServiceName,
		"incident_id", incidentID,
	)

	violation := SLAViolation{
		Contract:   c,
		ActualRTO:  actualRTO,
		ActualRPO:  actualRPO,
		OccurredAt: time.Now().UTC(),
		IncidentID: incidentID,
	}

	rtoBreached := actualRTO > c.RTO
	rpoBreached := actualRPO > c.RPO

	if !rtoBreached && !rpoBreached {
		logger.InfoContext(ctx, "SLA satisfied",
			"actual_rto", actualRTO,
			"actual_rpo", actualRPO,
		)
		return nil
	}

	if rtoBreached {
		logger.ErrorContext(ctx, "RTO breach",
			"limit", c.RTO,
			"actual", actualRTO,
			"overage", actualRTO-c.RTO,
		)
	}
	if rpoBreached {
		logger.ErrorContext(ctx, "RPO breach",
			"limit", c.RPO,
			"actual", actualRPO,
			"overage", actualRPO-c.RPO,
		)
	}

	if c.EscalationFn != nil {
		if err := c.EscalationFn(ctx, violation); err != nil {
			logger.ErrorContext(ctx, "escalation failed", "error", err)
		}
	}

	return violation
}

// SLARegistry holds all service contracts.
type SLARegistry struct {
	contracts map[string]SLAContract
	logger    *slog.Logger
}

func NewSLARegistry(logger *slog.Logger) *SLARegistry {
	return &SLARegistry{
		contracts: make(map[string]SLAContract),
		logger:    logger,
	}
}

func (r *SLARegistry) Register(contract SLAContract) error {
	if contract.ServiceName == "" {
		return errors.New("service name is required")
	}
	if contract.RTO <= 0 || contract.RPO < 0 {
		return fmt.Errorf("invalid RTO/RPO values for %s", contract.ServiceName)
	}
	r.contracts[contract.ServiceName] = contract
	r.logger.Info("SLA contract registered",
		"service", contract.ServiceName,
		"tier", contract.ServiceTier,
		"rto", contract.RTO,
		"rpo", contract.RPO,
	)
	return nil
}

func (r *SLARegistry) Get(serviceName string) (SLAContract, error) {
	c, ok := r.contracts[serviceName]
	if !ok {
		return SLAContract{}, fmt.Errorf("no SLA contract registered for service: %s", serviceName)
	}
	return c, nil
}
```

---

### Junior -> FAANG: Making RTO and RPO Concrete for Interviews

The tier table (Tier 0 through Tier 3) is a calibration tool. Before any system design interview involving reliability, decide which tier your system falls into. Payment processing is Tier 0. A user-facing e-commerce product catalog is likely Tier 2. A batch data pipeline is Tier 3. The tier determines which architectural patterns are justified.

The `SLAContract` type encodes a key insight: recovery objectives are first-class types, not strings in a design doc. When you can pass an `SLAContract` to a function and have that function validate recovery metrics against it programmatically, you have made reliability engineering machine-checkable. This is what FAANG interviews mean when they say "how do you operationalize your SLAs?"

Common interview mistake: saying "our RTO is 15 minutes" without being able to explain how you measure it. RTO is measured from incident declaration (the moment monitoring fires an alert and an engineer acknowledges it) to full service restoration (the moment the service is serving traffic at its normal error rate and latency). If you cannot instrument these two timestamps and compute the difference, your RTO is aspirational, not measured.

### Senior @ FAANG: SLA Contracts as Organizational Infrastructure

**SLA tiers are negotiated, not assumed.** The tier table assigns RTO and RPO values to service categories. But who decides which tier a service belongs to? At FAANG, this is a negotiation between engineering, product, and finance. Payment processing is Tier 0 because the business cost of 1 minute of downtime exceeds the infrastructure cost of synchronous replication. Reporting is Tier 3 because 24 hours of recovery time has minimal business impact. These costs must be quantified: $X per minute of downtime times Y minutes equals the justified infrastructure investment. A principal engineer builds this cost model and presents it to leadership. They do not unilaterally assign tiers.

**SLA violation escalation paths.** The `SLAContract.EscalationFn` field holds a function called when actual RTO or RPO exceeds the contract limits. In production, this function notifies the service owner, SRE lead, and business stakeholder simultaneously. It also creates an incident record in the tracking system and pre-populates the postmortem template. The escalation chain must be defined at contract registration time, not improvised during the incident.

**Cascading SLA contracts across service dependencies.** Service A depends on Service B. Service A has an RTO of 15 minutes. Service B has an RTO of 30 minutes. If Service B fails, Service A cannot recover within its RTO because its dependency takes twice as long to recover. This cascading constraint is invisible if SLA contracts are analyzed in isolation. A principal engineer maps the service dependency graph and verifies that no service's RTO exceeds the minimum of the RTOs of its critical path dependencies. This is SLA topology analysis and it is a staff-level reliability engineering concern.

**Availability percentage is a derived metric, not a primary one.** The `SLAContract.Availability` field stores a float like `0.9999` (four nines). Availability percentage is derived from RTO and the observation window: `(window - downtime) / window`. If your annual RTO budget is 52 minutes (four nines of a year) and you have already spent 45 minutes on one incident, you have 7 minutes left for the remainder of the year. Tracking this budget consumption in real time, not just measuring availability retrospectively, is the operational excellence that distinguishes L6 from L4.

**The `EscalationFn` is a coordination contract between teams.** At platform scale, SLA violations from 50 services all escalate to the same SRE on-call rotation. Without coordination, the on-call receives a flood of simultaneous escalations during a broad incident, making triage impossible. A principal engineer designs the escalation routing to include service criticality, current incident count, and on-call capacity. SLA violations from Tier 0 services interrupt the on-call immediately, while Tier 2 violations queue for the next business hour unless no Tier 0/1 incidents are active.
