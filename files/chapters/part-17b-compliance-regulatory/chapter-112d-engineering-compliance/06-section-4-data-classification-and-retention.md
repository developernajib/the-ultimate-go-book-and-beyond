## 112D.5 Data Classification and Retention

Uncontrolled data accumulation creates compounding compliance risk: every record retained beyond its legal necessity is a record that must be disclosed in a DSAR, protected from breach, and defended in a regulatory audit. The code below defines a classification taxonomy with per-class retention policies: confidential and restricted data is hard-deleted once its period expires, while internal data is anonymized in place so the row keeps its analytical value after the identifying fields are gone. Read the periods in the code as illustrative defaults rather than as numbers to copy. A single retention figure per class is a teaching simplification, and the comments there explain where it breaks down, because real periods come from the purpose the data serves and the strictest regulation that reaches it. The `RetentionEnforcer` iterates policies programmatically so that adding a new classification or adjusting a period requires only a map entry change, not a logic change. The `DataInventory` registry is the load-bearing piece, because you cannot enforce retention on data you do not know exists.

```go
package classification

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// DataClassification levels
type DataClassification string

const (
	ClassificationPublic       DataClassification = "public"
	ClassificationInternal     DataClassification = "internal"
	ClassificationConfidential DataClassification = "confidential"
	ClassificationRestricted   DataClassification = "restricted" // PCI, PHI, PII
)

// RetentionPolicy defines how long data should be kept.
//
// Note what is not here: a LegalHold field. Legal hold is a property of a
// record, not of a classification. Nobody ever places a hold on "all
// confidential data", they place it on the records relevant to a specific
// matter. Modeling it on the policy would mean the only way to preserve one
// customer's records for litigation is to suspend deletion for every record
// sharing its class, which trades a compliance failure for a bigger one.
// The hold lives on the row and the enforcer honors it there.
type RetentionPolicy struct {
	Classification DataClassification
	RetentionDays  int
	DeleteAfter    bool // If false: anonymize after retention period
}

// DefaultPolicies are illustrative starting points, not legal guidance, and a
// single number per class is a simplification that does not survive contact
// with a real regulator. Retention is driven by purpose and jurisdiction, and
// one class can span several: "restricted" here covers PHI, whose documentation
// requirements run to six years, alongside PAN, which should not outlive the
// authorization that needed it. In production, the period is a property of the
// data asset, resolved from the strictest rule that applies to its purpose.
// Classification sets the ceiling on handling, not the retention clock.
var DefaultPolicies = map[DataClassification]RetentionPolicy{
	ClassificationPublic:       {Classification: ClassificationPublic, RetentionDays: 365, DeleteAfter: true},
	ClassificationInternal:     {Classification: ClassificationInternal, RetentionDays: 730, DeleteAfter: false},
	ClassificationConfidential: {Classification: ClassificationConfidential, RetentionDays: 2555, DeleteAfter: true}, // ~7 years
	ClassificationRestricted:   {Classification: ClassificationRestricted, RetentionDays: 2555, DeleteAfter: true},   // ~7 years, see note above
}

// DataInventory tracks data assets for compliance
type DataInventory struct {
	db *sql.DB
}

type DataAsset struct {
	ID             string
	Name           string
	Classification DataClassification
	Owner          string
	Location       string // "postgresql://...", "s3://...", "kafka://..."
	PIIFields      []string
	RetentionDays  int
	LastAudited    time.Time
}

func (di *DataInventory) Register(ctx context.Context, asset DataAsset) error {
	piiFields, err := toJSON(asset.PIIFields)
	if err != nil {
		return fmt.Errorf("encode pii fields: %w", err)
	}

	_, err = di.db.ExecContext(ctx, `
		INSERT INTO data_inventory
			(id, name, classification, owner, location, pii_fields, retention_days)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (id) DO UPDATE
		SET classification = $3, owner = $4, location = $5, pii_fields = $6, retention_days = $7
	`, asset.ID, asset.Name, asset.Classification, asset.Owner, asset.Location,
		piiFields, asset.RetentionDays)
	return err
}

// RetentionEnforcer applies retention policies
type RetentionEnforcer struct {
	db       *sql.DB
	policies map[DataClassification]RetentionPolicy
}

func NewRetentionEnforcer(db *sql.DB) *RetentionEnforcer {
	return &RetentionEnforcer{db: db, policies: DefaultPolicies}
}

// Enforce applies every policy and reports what happened.
//
// Two things to notice. Every statement excludes rows under legal hold, so a
// retention job can never destroy evidence someone is actively litigating over.
// And every error is collected rather than dropped: the original of this code
// wrote `if err == nil { count it }`, which meant a failing DELETE produced a
// report full of zeros and a nil error. That job would page nobody while data
// aged past its retention period indefinitely, and you would find out at audit.
func (re *RetentionEnforcer) Enforce(ctx context.Context) (*RetentionReport, error) {
	report := &RetentionReport{RunAt: time.Now().UTC()}

	for classification, policy := range re.policies {
		cutoff := time.Now().UTC().AddDate(0, 0, -policy.RetentionDays)

		if policy.DeleteAfter {
			result, err := re.db.ExecContext(ctx, `
				DELETE FROM user_data
				WHERE classification = $1 AND created_at < $2
				  AND legal_hold_until IS NULL
			`, classification, cutoff)
			if err != nil {
				report.Errors = append(report.Errors,
					fmt.Sprintf("delete %s: %v", classification, err))
				continue
			}
			deleted, err := result.RowsAffected()
			if err != nil {
				report.Errors = append(report.Errors,
					fmt.Sprintf("rows affected %s: %v", classification, err))
				continue
			}
			report.Deleted += int(deleted)
		} else {
			// Anonymize: strip the identifying fields, keep the row for analytics
			result, err := re.db.ExecContext(ctx, `
				UPDATE user_data
				SET email = 'anonymized@deleted.invalid',
				    name = 'Anonymized User',
				    phone = NULL,
				    anonymized = true
				WHERE classification = $1 AND created_at < $2 AND NOT anonymized
				  AND legal_hold_until IS NULL
			`, classification, cutoff)
			if err != nil {
				report.Errors = append(report.Errors,
					fmt.Sprintf("anonymize %s: %v", classification, err))
				continue
			}
			anonymized, err := result.RowsAffected()
			if err != nil {
				report.Errors = append(report.Errors,
					fmt.Sprintf("rows affected %s: %v", classification, err))
				continue
			}
			report.Anonymized += int(anonymized)
		}
	}

	if len(report.Errors) > 0 {
		return report, fmt.Errorf("retention run incomplete: %d of %d policies failed",
			len(report.Errors), len(re.policies))
	}
	return report, nil
}

type RetentionReport struct {
	RunAt      time.Time
	Deleted    int
	Anonymized int
	Errors     []string
}

func toJSON(v any) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
```

### Junior → FAANG: Building the Classification Habit Early

Data classification feels bureaucratic until you deal with a data breach where nobody could answer "which systems hold sensitive data?" in under an hour. First-job habit: classify every data field at schema definition time. Most mature companies use four levels: public, internal, confidential, and restricted. Restricted means credentials, payment data, PHI, and PII with regulatory protection. When you add a column to a table or a field to a protobuf, decide its class before the PR merges.

The practical consequence of classification is retention. Every class has a maximum retention period defined by the most restrictive regulation that applies. Get the HIPAA version right, because almost everyone states it wrong: the six-year rule at 164.316(b)(2)(i) covers the documentation HIPAA itself requires, meaning policies, procedures, and records of required actions, kept six years from creation or from the date it was last in effect. It is not a retention period for medical records. HIPAA sets no retention period for medical records at all. That comes from state law and varies by state. Under PCI DSS, PAN may be retained only as long as there is a documented business need, and sensitive authentication data such as the CVV may not be retained after authorization at all. Under GDPR, personal data must not be kept longer than the stated purpose requires, which means the purpose has to be stated before the period can be defended. If you do not know the retention period for a data field, that is a prerequisite question to answer before the schema is approved.

### Senior @ FAANG: Data Classification as a Pipeline Control Plane

At platform scale, classification cannot be a policy document. It must be a machine-readable tag that drives automated enforcement downstream. The architecture is: classification metadata lives in a central schema registry alongside the field definition. Every data pipeline, stream processor, and warehouse loader reads classification tags from the registry and applies corresponding controls automatically: field-level encryption for restricted data, row-level access control for confidential data, retention TTL enforcement via table lifecycle policies.

The hard problem is data lineage under transformation. A restricted field extracted from a database table, joined with another table, aggregated, and written to an analytics dataset produces a derived field whose classification may differ from any of its inputs. The union-of-strictest-inputs rule is the safe default: the output classification is the highest classification of any contributing input. Implementing this automatically requires a lineage-aware classification propagation system, which is a non-trivial piece of infrastructure but is the only way to prevent classification drift in a large data mesh.

Retention enforcement at scale has two failure modes. The first is deleting data too early, which destroys audit evidence needed for active investigations. The second is retaining data too long, which is a GDPR and HIPAA violation. The mitigation is a legal hold capability: a flag that prevents automated retention deletion for records under active legal review, with an expiry date set by the legal team rather than the engineering team. A staff engineer designing a data platform should treat legal hold as a first-class requirement, not an afterthought.

Classification maturity model for ADR purposes: Level 1 is a policy document with manual tagging. Level 2 is tagging enforced at schema-review time via a PR checklist. Level 3 is a schema registry where classification is a required field and PRs without it fail CI. Level 4 is automated propagation through pipelines with retention policy enforcement. Level 5 adds real-time classification drift detection, where a scanner alerts when data written to a table does not match the registered classification for that schema.

---
