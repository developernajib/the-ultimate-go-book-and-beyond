## 112D.6 Compliance Evidence Collection

A SOC 2 Type II report requires continuous proof that controls operated correctly across an observation window, commonly three to twelve months. That evidence can only be produced if collection is automated from day one, not assembled manually before each audit. The `EvidenceCollector` below models each compliance control as a `Control` struct with an associated collector function, enabling new controls to be registered without modifying the collection loop. Each collector returns structured `Evidence` with a pass/fail status and arbitrary key-value details so that auditors receive machine-readable artifacts, not screenshots. The `ComplianceReport.SaveToFile` method persists evidence as a JSON document with `0600` permissions, preventing other OS users from reading sensitive audit state while producing an artifact that can be uploaded to a GRC platform.

```go
package compliance

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"
)

// StateProbe reads live system state. Every collector below derives its status
// from this rather than asserting one, which is the whole point: a collector
// that returns a constant is not evidence, it is a claim with extra steps.
type StateProbe interface {
	// AccessPolicy reports the currently enforced authentication settings.
	AccessPolicy(ctx context.Context) (AccessPolicyState, error)
	// AuditLogConfig reports the audit pipeline's live configuration.
	AuditLogConfig(ctx context.Context) (AuditLogState, error)
	// DataInventory reports the processing-activity registry's state.
	DataInventory(ctx context.Context) (InventoryState, error)
}

type AccessPolicyState struct {
	MFARequired       bool
	PasswordMinLength int
	SessionTimeout    time.Duration
	UsersWithoutMFA   []string
}

type AuditLogState struct {
	Enabled       bool
	RetentionDays int
	TamperEvident bool
	Centralized   bool
	LastWriteAt   time.Time
}

type InventoryState struct {
	AssetCount       int
	UnclassifiedList []string
	LastReviewedAt   time.Time
}

// EvidenceCollector gathers compliance evidence for auditors
type EvidenceCollector struct {
	logger   *slog.Logger
	probe    StateProbe
	controls []Control
}

// Control represents a compliance control
type Control struct {
	ID          string
	Framework   string // "SOC2", "GDPR", "PCI", "HIPAA"
	Category    string
	Description string
	Collector   func(ctx context.Context) (*Evidence, error)
}

type Evidence struct {
	ControlID   string
	CollectedAt time.Time
	Status      string // "passing", "failing", "not_applicable"
	Details     map[string]any
	Evidence    []EvidenceItem
}

type EvidenceItem struct {
	Type        string
	Description string
	Value       any
	Timestamp   time.Time
}

func NewEvidenceCollector(probe StateProbe) *EvidenceCollector {
	ec := &EvidenceCollector{logger: slog.Default(), probe: probe}
	ec.registerDefaultControls()
	return ec
}

func (ec *EvidenceCollector) registerDefaultControls() {
	ec.controls = []Control{
		{
			ID:          "SOC2-CC6.1",
			Framework:   "SOC2",
			Category:    "Logical and Physical Access Controls",
			Description: "Logical access security measures are implemented",
			Collector:   ec.collectAccessControlEvidence,
		},
		{
			ID:          "SOC2-CC7.2",
			Framework:   "SOC2",
			Category:    "System Operations",
			Description: "Security events are monitored and analyzed",
			Collector:   ec.collectAuditLogEvidence,
		},
		{
			ID:          "GDPR-Art30",
			Framework:   "GDPR",
			Category:    "Data Processing Records",
			Description: "Records of processing activities maintained",
			Collector:   ec.collectDataInventoryEvidence,
		},
	}
}

func (ec *EvidenceCollector) collectAccessControlEvidence(ctx context.Context) (*Evidence, error) {
	now := time.Now().UTC()
	state, err := ec.probe.AccessPolicy(ctx)
	if err != nil {
		return nil, fmt.Errorf("probe access policy: %w", err)
	}

	// The status is computed from what the system actually reports. Note that
	// MFA being "required" by policy is not the control: the control is that no
	// user is exempt from it, which is why UsersWithoutMFA decides the outcome.
	// Policy asserts intent, the exception list is what an auditor tests.
	status := "passing"
	if !state.MFARequired || len(state.UsersWithoutMFA) > 0 ||
		state.PasswordMinLength < 12 || state.SessionTimeout > 30*time.Minute {
		status = "failing"
	}

	return &Evidence{
		ControlID:   "SOC2-CC6.1",
		CollectedAt: now,
		Status:      status,
		Details: map[string]any{
			"mfa_required":        state.MFARequired,
			"password_min_length": state.PasswordMinLength,
			"session_timeout_min": int(state.SessionTimeout.Minutes()),
			"users_without_mfa":   len(state.UsersWithoutMFA),
		},
		Evidence: []EvidenceItem{
			{
				Type:        "configuration",
				Description: "MFA enforcement policy",
				Value:       state.MFARequired,
				Timestamp:   now,
			},
			{
				Type:        "exception_list",
				Description: "Users exempt from MFA enforcement",
				Value:       state.UsersWithoutMFA,
				Timestamp:   now,
			},
		},
	}, nil
}

func (ec *EvidenceCollector) collectAuditLogEvidence(ctx context.Context) (*Evidence, error) {
	now := time.Now().UTC()
	state, err := ec.probe.AuditLogConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("probe audit log config: %w", err)
	}

	// A configured-but-silent audit log is the failure mode this catches. If
	// nothing has been written for 24 hours, the pipeline is broken and the
	// config flags saying "enabled" are describing a system that stopped
	// producing the evidence they promise.
	stale := now.Sub(state.LastWriteAt) > 24*time.Hour

	status := "passing"
	if !state.Enabled || !state.TamperEvident || !state.Centralized ||
		state.RetentionDays < 365 || stale {
		status = "failing"
	}

	return &Evidence{
		ControlID:   "SOC2-CC7.2",
		CollectedAt: now,
		Status:      status,
		Details: map[string]any{
			"audit_log_enabled":   state.Enabled,
			"retention_days":      state.RetentionDays,
			"tamper_evident":      state.TamperEvident,
			"centralized_logging": state.Centralized,
			"last_write_at":       state.LastWriteAt.Format(time.RFC3339),
			"stale":               stale,
		},
	}, nil
}

func (ec *EvidenceCollector) collectDataInventoryEvidence(ctx context.Context) (*Evidence, error) {
	now := time.Now().UTC()
	state, err := ec.probe.DataInventory(ctx)
	if err != nil {
		return nil, fmt.Errorf("probe data inventory: %w", err)
	}

	// Article 30 wants records of processing activities that are current. An
	// inventory with unclassified assets is by definition incomplete, and one
	// nobody has reviewed in a year is a document, not a record.
	status := "passing"
	if state.AssetCount == 0 || len(state.UnclassifiedList) > 0 ||
		now.Sub(state.LastReviewedAt) > 365*24*time.Hour {
		status = "failing"
	}

	return &Evidence{
		ControlID:   "GDPR-Art30",
		CollectedAt: now,
		Status:      status,
		Details: map[string]any{
			"asset_count":        state.AssetCount,
			"unclassified_count": len(state.UnclassifiedList),
			"last_reviewed":      state.LastReviewedAt.Format("2006-01-02"),
		},
	}, nil
}

// CollectAll runs all compliance controls and generates a report
func (ec *EvidenceCollector) CollectAll(ctx context.Context) *ComplianceReport {
	report := &ComplianceReport{
		GeneratedAt: time.Now().UTC(),
	}

	for _, control := range ec.controls {
		evidence, err := control.Collector(ctx)
		if err != nil {
			ec.logger.Error("collect evidence", "control", control.ID, "error", err)
			// A collector that errored proves nothing. It is recorded as "error"
			// and never as "passing": an unreachable probe is an unknown, and
			// unknowns do not get the benefit of the doubt in an audit.
			evidence = &Evidence{
				ControlID:   control.ID,
				CollectedAt: time.Now().UTC(),
				Status:      "error",
				Details:     map[string]any{"error": err.Error()},
			}
		}
		report.Evidences = append(report.Evidences, *evidence)
	}

	// Calculate overall status. Controls marked not_applicable are excluded from
	// the denominator rather than counted as failures: scoping a control out is
	// a legitimate answer, and folding it into the pass rate would make an
	// accurate report look like a failing one.
	passing, applicable := 0, 0
	for _, e := range report.Evidences {
		if e.Status == "not_applicable" {
			continue
		}
		applicable++
		if e.Status == "passing" {
			passing++
		}
	}

	switch {
	case applicable == 0:
		// No applicable controls means no assurance, not perfect assurance.
		// float64(0)/float64(0) is NaN, which would serialize as invalid JSON
		// and take the report's consumer down with it.
		report.PassRate = 0
		report.OverallStatus = "no_controls"
	default:
		report.PassRate = float64(passing) / float64(applicable) * 100
		report.OverallStatus = "passing"
		if passing < applicable {
			report.OverallStatus = "failing"
		}
	}

	return report
}

type ComplianceReport struct {
	GeneratedAt   time.Time
	OverallStatus string
	PassRate      float64
	Evidences     []Evidence
}

func (r *ComplianceReport) SaveToFile(path string) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func (r *ComplianceReport) Print() {
	fmt.Printf("Compliance Report: %s\n", r.GeneratedAt.Format(time.RFC3339))
	fmt.Printf("Overall: %s (%.0f%% passing)\n\n", r.OverallStatus, r.PassRate)
	for _, e := range r.Evidences {
		status, ok := map[string]string{
			"passing":        "✓",
			"failing":        "✗",
			"error":          "!",
			"not_applicable": "-",
		}[e.Status]
		if !ok {
			status = "?"
		}
		fmt.Printf("  [%s] %s: %s\n", status, e.ControlID, e.Status)
	}
}
```

### Junior → FAANG: Evidence Is Not Something You Gather at Audit Time

The most common first-job mistake in a company under SOC 2 or PCI DSS is treating evidence collection as a once-a-year activity. Auditors request evidence for the entire audit period, typically 12 months. If your team scrambles to collect it in the two weeks before fieldwork begins, the gaps become obvious and expensive to remediate. First-job habit: for every control your service owns, know what the evidence looks like and confirm it is being produced continuously. If a control requires quarterly access reviews, set a calendar reminder three days before each quarter end rather than relying on the compliance team to chase you.

Interview framing: distinguish between control evidence (proof that a control exists, such as a policy document or configuration screenshot) and operating effectiveness evidence (proof that the control worked throughout the period, such as a log showing it was applied to every access). Auditors care primarily about operating effectiveness. Code that produces structured, queryable operating evidence is more valuable to compliance programs than a polished policy document.

### Senior @ FAANG: Continuous Control Monitoring as an Engineering Product

At staff level, evidence collection becomes a product problem. The question is not "can we produce evidence for this audit?" but "does our platform produce evidence continuously, automatically, and in a format auditors can verify without engineering involvement?"

Continuous control monitoring (CCM) treats each compliance control as a policy assertion that can be evaluated programmatically. For access controls, the assertion might be "no IAM role grants both write and delete on the audit log bucket." For encryption, it might be "all EBS volumes in the production account have encryption enabled." These assertions run on a schedule, and their pass/fail results are themselves stored as tamper-evident evidence records.

The infrastructure for this has three layers. The first layer is a control catalog: a machine-readable registry of all controls, their criteria, their evidence requirements, and their owners. The second layer is an evidence collector: a set of scheduled jobs that evaluate each control assertion against live infrastructure state using cloud provider APIs, database queries, and log analytics. The third layer is an evidence store: an immutable, auditor-accessible repository where each evidence record includes the control ID, the evaluation timestamp, the input data, the assertion result, and the identity of the system that produced it.

The bar-raiser signal for this topic is understanding the difference between evidence collected by the engineering team and evidence accepted by a third-party auditor. Not all programmatic evidence is auditor-acceptable without an opinion letter or a SOC 2 Type II report from the tool vendor. A staff engineer should know which evidence sources in their platform are auditor-accepted and which require a bridge document.

---
