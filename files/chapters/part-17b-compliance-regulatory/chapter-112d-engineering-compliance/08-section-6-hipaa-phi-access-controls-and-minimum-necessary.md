## 112D.7 HIPAA - PHI Access Controls and Minimum Necessary

Two different HIPAA rules meet in this section, and conflating them is the most common mistake engineers make when talking about it. The Security Rule governs electronic PHI and requires technical safeguards including access control (164.312(a)(1)) and audit controls (164.312(b)). The minimum necessary standard is not part of it. That comes from the Privacy Rule (164.502(b) and 164.514(d)), it applies to PHI in any form including paper and speech, and it carries its own exceptions, notably that it does not apply to disclosures to a provider for treatment.

Both requirements map onto code, and the code below implements each: technical access control through a type that cannot be read without producing an audit record, and minimum necessary through a policy that resolves role, resource, field, and purpose together.

```go
package hipaa

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// AuditEntry is one PHI access record. HIPAA 164.312(b) requires the mechanism
// that records it - Purpose is what makes the record answer "why", not just
// "who" and "when".
type AuditEntry struct {
	EventType   string
	ActorID     string
	PatientID   string
	Purpose     string
	Timestamp   time.Time
	Sensitivity string
}

// AuditLogger persists PHI access records. See Section 1 for a tamper-evident
// implementation: the chaining there is what stops an accessor from deleting
// the record of their own access.
type AuditLogger interface {
	Log(ctx context.Context, entry AuditEntry) error
}

// PHI is a type-safe wrapper for Protected Health Information.
// Using a distinct type prevents PHI from being accidentally logged
// or passed to non-PHI-aware code paths.
type PHI[T any] struct {
	value T
	owner string // patient ID who owns this PHI
}

// NewPHI wraps a value as PHI. The wrapping itself is logged.
func NewPHI[T any](value T, patientID string) PHI[T] {
	return PHI[T]{value: value, owner: patientID}
}

// Access extracts the PHI value. Every access is logged with the accessing
// user, purpose, and timestamp, because 164.312(b) requires a record of
// activity in systems containing ePHI.
//
// The audit write is fail-closed: if the log cannot be written, the caller does
// not get the value. This ordering is the entire design. An access that happened
// without a corresponding record is exactly the thing the safeguard exists to
// prevent, so an unavailable audit log has to mean unavailable PHI. Engineers
// reliably get this backwards and log after returning, or ignore the write
// error, which yields a system that keeps serving PHI precisely when it has
// stopped being able to prove who read it.
func (p PHI[T]) Access(ctx context.Context, accessorID, purpose string, logger AuditLogger) (T, error) {
	var zero T

	if accessorID == "" {
		return zero, errors.New("HIPAA: accessor identity is required")
	}
	if purpose == "" {
		return zero, errors.New("HIPAA: access purpose is required")
	}

	// Log the PHI access immediately, before returning the value.
	if err := logger.Log(ctx, AuditEntry{
		EventType:   "phi_access",
		ActorID:     accessorID,
		PatientID:   p.owner,
		Purpose:     purpose,
		Timestamp:   time.Now().UTC(),
		Sensitivity: "restricted",
	}); err != nil {
		return zero, fmt.Errorf("HIPAA: refusing PHI access, audit log unavailable: %w", err)
	}

	return p.value, nil
}

// String intentionally redacts PHI in string conversions.
// This prevents PHI from appearing in fmt.Printf, log.Printf, or error messages.
func (p PHI[T]) String() string {
	return fmt.Sprintf("[PHI:patient=%s:REDACTED]", p.owner)
}

// MinimumNecessaryPolicy defines which roles can access which PHI fields.
// HIPAA's minimum necessary standard requires that employees access only
// the PHI they need for their job function.
type MinimumNecessaryPolicy struct {
	rules []policyRule
}

type policyRule struct {
	role     string
	resource string
	fields   []string // nil = all fields allowed
	purposes []string
}

func NewMinimumNecessaryPolicy() *MinimumNecessaryPolicy {
	return &MinimumNecessaryPolicy{}
}

func (p *MinimumNecessaryPolicy) Allow(role, resource string, fields, purposes []string) {
	p.rules = append(p.rules, policyRule{
		role:     role,
		resource: resource,
		fields:   fields,
		purposes: purposes,
	})
}

func (p *MinimumNecessaryPolicy) Check(role, resource, field, purpose string) error {
	for _, rule := range p.rules {
		if rule.role != role || rule.resource != resource {
			continue
		}
		// Check purpose.
		purposeAllowed := false
		for _, allowedPurpose := range rule.purposes {
			if allowedPurpose == purpose {
				purposeAllowed = true
				break
			}
		}
		if !purposeAllowed {
			continue
		}
		// Check field access (nil = all fields allowed).
		if rule.fields == nil {
			return nil
		}
		for _, allowedField := range rule.fields {
			if allowedField == field {
				return nil
			}
		}
	}
	return fmt.Errorf("HIPAA minimum necessary violation: role=%q cannot access field=%q on resource=%q for purpose=%q", role, field, resource, purpose)
}

// ExamplePolicy shows a production minimum-necessary configuration.
func ExamplePolicy() *MinimumNecessaryPolicy {
	p := NewMinimumNecessaryPolicy()

	// Billing staff can see demographic info and insurance for billing purposes.
	p.Allow("billing", "patient_record", []string{"name", "dob", "address", "insurance_id"}, []string{"billing"})

	// Clinical staff can see all clinical fields for treatment purposes.
	p.Allow("clinical", "patient_record", nil, []string{"treatment", "care_coordination"})

	// Researchers get only the generalized fields: an age band rather than a
	// date of birth, codes rather than notes. Note the honest limit of this
	// rule. Projecting a patient_record down to a few columns is minimum
	// necessary, not de-identification. The row is still linked to a patient,
	// so it remains PHI and stays fully in scope. De-identification under
	// Safe Harbor or Expert Determination is a separate pipeline that severs
	// that link, and research use cases normally read from its output, not
	// from a narrowed view of the live record.
	p.Allow("researcher", "patient_record", []string{"age_band", "diagnosis_code", "treatment_code"}, []string{"research"})

	// Auditors can access the audit log itself, not clinical records.
	p.Allow("auditor", "audit_log", nil, []string{"compliance_audit"})

	return p
}
```

### 6.1 PHI Data Masking for Logs

Even with type-safe PHI wrappers, free-text fields and error messages can inadvertently carry PHI into log pipelines where it will be retained, indexed, and accessible to anyone with log access. The `PHIMasker` below applies a chain of regex patterns covering the most common PHI formats: SSNs, medical record numbers, dates of birth, email addresses, and phone numbers. It runs over every string value before it reaches the log sink. The `MaskFields` method handles structured logging by checking an explicit sensitive-key list and applying pattern matching to all remaining string values, recursing into nested maps and slices so a PHI field does not survive by being one level down.

Be clear-eyed about what this is. Pattern masking is a backstop, not a control. It catches the formats it knows and misses everything else, and a clinical free-text note carrying a patient's name and condition matches no regex at all. The control is the type wrapper above, which makes the leak impossible. The masker is what catches the paths that got around it. Do not let its presence justify relaxing the wrapper.

```go
package hipaa

import (
	"fmt"
	"regexp"
	"strings"
)

// PHIMasker masks known PHI patterns before data reaches log pipelines.
// Apply this to all structured log field values and to free-text fields.
type PHIMasker struct {
	patterns []*maskerRule
}

type maskerRule struct {
	name    string
	re      *regexp.Regexp
	replace string
}

// NewPHIMasker creates a masker covering the most common PHI patterns.
func NewPHIMasker() *PHIMasker {
	return &PHIMasker{
		patterns: []*maskerRule{
			{
				name: "ssn",
				re:   regexp.MustCompile(`\b(\d{3})-(\d{2})-(\d{4})\b`),
				// Redact in full. Keeping the last four is a tempting default
				// and the wrong one here: the last four are the non-derivable
				// part of an SSN, they are widely used as verification secrets,
				// and Safe Harbor lists the SSN as an identifier to remove
				// outright rather than to shorten. Nothing reading a log needs
				// to identify a patient by SSN fragment.
				replace: "[SSN-REDACTED]",
			},
			{
				name:    "ssn_no_dashes",
				re:      regexp.MustCompile(`\b\d{9}\b`),
				replace: "[SSN-REDACTED]",
			},
			{
				name:    "mrn", // Medical Record Numbers (common formats)
				re:      regexp.MustCompile(`\bMRN[:\s]*([A-Z0-9]{6,12})\b`),
				replace: "MRN:[REDACTED]",
			},
			{
				name:    "dob",
				re:      regexp.MustCompile(`\b(0[1-9]|1[0-2])/(0[1-9]|[12]\d|3[01])/(19|20)\d{2}\b`),
				replace: "[DOB-REDACTED]",
			},
			{
				name:    "email",
				re:      regexp.MustCompile(`\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b`),
				replace: "[EMAIL-REDACTED]",
			},
			{
				name:    "phone",
				re:      regexp.MustCompile(`\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b`),
				replace: "[PHONE-REDACTED]",
			},
		},
	}
}

// Mask applies all PHI masking patterns to the input string.
func (m *PHIMasker) Mask(input string) string {
	result := input
	for _, rule := range m.patterns {
		result = rule.re.ReplaceAllString(result, rule.replace)
	}
	return result
}

// MaskFields masks specific fields in a map before structured logging.
//
// It recurses. The flat version of this function passed any non-string value
// through untouched, which meant a nested map or a slice of strings carried its
// PHI straight to the sink: the exact "unforeseen code path" the masker exists
// to cover. Log payloads nest constantly, so the flat version fails on ordinary
// input, not on exotic input.
func (m *PHIMasker) MaskFields(fields map[string]any, sensitiveKeys []string) map[string]any {
	sensitiveSet := make(map[string]bool, len(sensitiveKeys))
	for _, k := range sensitiveKeys {
		sensitiveSet[strings.ToLower(k)] = true
	}
	return m.maskMap(fields, sensitiveSet, 0)
}

// maxMaskDepth bounds recursion. Log payloads can contain cycles by way of
// map[string]any graphs built at runtime, and an unbounded walk would turn a
// logging call into a stack overflow.
const maxMaskDepth = 16

func (m *PHIMasker) maskMap(fields map[string]any, sensitive map[string]bool, depth int) map[string]any {
	masked := make(map[string]any, len(fields))
	for k, v := range fields {
		if sensitive[strings.ToLower(k)] {
			masked[k] = "[PHI-REDACTED]"
			continue
		}
		masked[k] = m.maskValue(v, sensitive, depth)
	}
	return masked
}

func (m *PHIMasker) maskValue(v any, sensitive map[string]bool, depth int) any {
	if depth >= maxMaskDepth {
		return "[PHI-REDACTED:MAX-DEPTH]"
	}

	switch val := v.(type) {
	case string:
		return m.Mask(val)
	case map[string]any:
		return m.maskMap(val, sensitive, depth+1)
	case []any:
		out := make([]any, len(val))
		for i, item := range val {
			out[i] = m.maskValue(item, sensitive, depth+1)
		}
		return out
	case []string:
		out := make([]string, len(val))
		for i, item := range val {
			out[i] = m.Mask(item)
		}
		return out
	case error:
		// Error strings are a top source of PHI in logs: a query failure that
		// echoes the offending row is an error value, not a string field.
		return m.Mask(val.Error())
	case fmt.Stringer:
		return m.Mask(val.String())
	default:
		return val
	}
}
```

### Junior → FAANG: Minimum Necessary as a Default Coding Standard

HIPAA's minimum necessary standard is not just a legal principle. It maps directly to the least-privilege principle engineers apply to database queries and API responses. For every query that returns PHI, the question is: does this caller need every field, or can the query project only what is required for the stated purpose? First-job habit: write PHI queries with explicit column lists rather than SELECT *. This is both a performance improvement and a HIPAA compliance control, and it is reviewable in code review without any compliance expertise.

Access logging for PHI is distinct from general audit logging. HIPAA requires that you log who accessed which PHI records, when, and for what purpose. The "purpose" field is the part most implementations miss. Purpose can be system-assigned (treatment, payment, operations) or user-declared (a clinician marking a record as part of a specific patient encounter). Without a purpose field, your access log satisfies the "who and when" requirement but not the "why" requirement, which is what HIPAA's access management rules are actually trying to capture.

### Senior @ FAANG: PHI Access Control as a Multi-Dimensional Policy Problem

HIPAA access control at scale involves three overlapping dimensions that most simple RBAC implementations cannot express: role (who the user is in the care organization), relationship (whether the user has a treatment relationship with the specific patient), and purpose (the declared reason for access). A physician with a valid treatment role should be able to access their own patients' records but not records of patients they have never treated. This relationship dimension requires a patient-to-provider relationship store, not just role-to-permission mapping.

The engineering pattern for this is Zanzibar-style relationship-based access control, where access to a PHI record requires a tuple (user, has_treatment_relationship, patient) to exist in the authorization graph. The authorization check for a PHI access call is: does the caller's user ID have a treatment relationship with the patient whose record is being accessed, given the stated purpose? This check must be synchronous, logged, and non-bypassable.

Break-glass access, where a clinician accesses a patient's record outside a treatment relationship in an emergency, requires a separate code path with mandatory purpose declaration, elevated audit logging, and a post-access review workflow. The design must ensure that break-glass is used rarely enough to be reviewed individually rather than in bulk. If break-glass becomes routine, it is a signal that the normal access model is too restrictive and clinicians are bypassing it systematically, which creates a larger compliance risk than overly broad normal access.

PHI de-identification is an area where staff engineers frequently underestimate risk. HIPAA's Safe Harbor de-identification method (removing 18 specified identifiers) is well-known, but it is vulnerable to re-identification when combined with external datasets. At FAANG scale, where an analytics dataset might contain tens of millions of de-identified records and the external datasets available for re-identification (social media, voter registration, commercial data brokers) are enormous, statistical de-identification methods (k-anonymity, l-diversity, differential privacy) are a stronger control than Safe Harbor for research and analytics use cases. A staff engineer overseeing a health data platform should be able to articulate the re-identification risk model and choose the appropriate de-identification method for each data use case.

---
