## 112D.8 Data Residency and Cross-Border Transfer Controls

GDPR Chapter V (Articles 44-50) restricts transferring personal data outside the EEA: transfers need an adequacy decision (Article 45), appropriate safeguards such as Standard Contractual Clauses (Article 46), or a narrow derogation (Article 49). For Go services, this means routing, storage, and processing decisions must be data-residency-aware.

One distinction to hold onto before reading the code, because the section models both and they are not the same thing. GDPR restricts cross-border *transfer*, and it does not mandate residency: EU personal data may lawfully sit in a third country given a valid transfer mechanism. Residency, meaning a hard requirement that bytes never leave a geography, generally comes from somewhere else, such as a public sector procurement rule, a national sectoral law, or a contract your sales team signed. Engineers routinely attribute residency requirements to GDPR that GDPR never imposed, then over-build. Know which of the two any given constraint actually is, because they have different escape hatches.

```go
package residency

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Region represents a geographic data residency zone.
type Region string

const (
	RegionEU   Region = "eu-west-1" // Ireland, inside the EEA
	RegionUS   Region = "us-east-1" // United States, a third country for Chapter V purposes
	RegionAPAC Region = "ap-east-1" // Hong Kong, obligations vary by country
)

// A note on what region does not decide. GDPR follows the data subject, not the
// server: under Article 3(2) it reaches a US-hosted service that offers goods or
// services to people in the EU or monitors their behavior. Running in
// RegionUS does not put you outside GDPR, it makes writes there a Chapter V
// transfer needing a mechanism. Region determines which transfer rules apply,
// never whether the regulation applies.

// DataResidencyPolicy enforces where personal data may be stored and processed.
type DataResidencyPolicy struct {
	rules map[DataCategory][]Region
}

type DataCategory string

const (
	CategoryPersonal   DataCategory = "personal"   // GDPR personal data
	CategoryPHI        DataCategory = "phi"        // HIPAA PHI
	CategoryFinancial  DataCategory = "financial"  // PCI/financial data
	CategoryAnonymized DataCategory = "anonymized" // No residency restrictions
)

// NewDefaultPolicy creates a policy that confines EU personal data to EU regions.
//
// Read every line here as an organizational decision, not as a legal citation.
// Two of these constraints are frequently misattributed to the regulation that
// names the data, and neither regulation says what engineers assume:
//
//   - HIPAA imposes no data residency requirement whatsoever. PHI may lawfully
//     be processed outside the United States. Keeping it onshore is a common and
//     defensible risk decision, driven by the difficulty of enforcing a Business
//     Associate Agreement against a foreign subcontractor and by customer
//     contracts, but the constraint comes from your organization, not the rule.
//   - PCI DSS likewise imposes no geographic restriction on cardholder data. It
//     cares how the data is protected, not which country it sits in.
//
// Only CategoryPersonal traces to a statute, and even there the honest framing
// is narrower than "EU data stays in EU": GDPR permits the transfer with a valid
// Article 45 or 46 mechanism. Pinning to RegionEU is the simplifying choice of
// avoiding Chapter V rather than a rule requiring it.
//
// Encode the reason, not just the rule. A policy whose rationale is lost gets
// cargo-culted into the next system and defended as law.
func NewDefaultPolicy() *DataResidencyPolicy {
	return &DataResidencyPolicy{
		rules: map[DataCategory][]Region{
			CategoryPersonal:   {RegionEU},                       // Org choice: avoid Chapter V entirely
			CategoryPHI:        {RegionUS},                       // Org choice: BAA enforceability, not HIPAA text
			CategoryFinancial:  {RegionEU, RegionUS},             // Org choice: where the acquirers are
			CategoryAnonymized: {RegionEU, RegionUS, RegionAPAC}, // Out of scope once truly anonymized
		},
	}
}

// CheckWrite validates that writing data of a given category to a region is allowed.
func (p *DataResidencyPolicy) CheckWrite(ctx context.Context, category DataCategory, targetRegion Region) error {
	allowed, ok := p.rules[category]
	if !ok {
		return fmt.Errorf("data residency: unknown category %q", category)
	}

	if slices.Contains(allowed, targetRegion) {
		return nil
	}

	return fmt.Errorf("data residency violation: category %q cannot be written to region %q (allowed: %v)", category, targetRegion, allowed)
}

// ResidencyAwareStorage wraps a storage backend with residency enforcement.
type ResidencyAwareStorage struct {
	backends map[Region]StorageBackend
	policy   *DataResidencyPolicy
	current  Region
}

type StorageBackend interface {
	Write(ctx context.Context, key string, value []byte) error
	Read(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
}

func NewResidencyAwareStorage(backends map[Region]StorageBackend, policy *DataResidencyPolicy, currentRegion Region) *ResidencyAwareStorage {
	return &ResidencyAwareStorage{
		backends: backends,
		policy:   policy,
		current:  currentRegion,
	}
}

// Write checks residency policy before delegating to the region's backend.
func (s *ResidencyAwareStorage) Write(ctx context.Context, key string, value []byte, category DataCategory) error {
	if err := s.policy.CheckWrite(ctx, category, s.current); err != nil {
		return err
	}

	backend, ok := s.backends[s.current]
	if !ok {
		return fmt.Errorf("no storage backend for region %q", s.current)
	}

	return backend.Write(ctx, key, value)
}

// SCCTransferRecord records a Standard Contractual Clause transfer for GDPR Article 46.
// Required documentation when transferring EU personal data to non-EEA countries.
type SCCTransferRecord struct {
	DataExporterID    string // EEA entity exporting the data
	DataImporterID    string // Non-EEA entity importing the data
	DataCategories    []DataCategory
	TransferMechanism string // "SCC", "BCR", "Adequacy Decision"
	SourceRegion      Region
	DestinationRegion Region
	LegalBasis        string // Article 46(2)(c) SCCs, etc.
	CreatedAt         time.Time
	ReviewedAt        time.Time
	ExpiresAt         time.Time

	// TIAComplete records whether a transfer impact assessment has been done.
	// Since Schrems II, SCCs alone are not sufficient: the exporter must assess
	// whether the destination country's law undermines them and add
	// supplementary measures where it does. An SCC record with no assessment
	// behind it documents a transfer, it does not justify one.
	TIAComplete bool
}

// ValidateSCCTransfer ensures the SCC record is valid, unexpired, and actually
// covers this transfer.
//
// Every parameter is checked. The original signature took destRegion and never
// looked at it, which meant a valid SCC covering an EU-to-US flow would wave
// through an EU-to-APAC transfer it says nothing about. An authorization check
// with an ignored argument is worse than no check: it reads as enforcement in
// review and passes everything at runtime.
func ValidateSCCTransfer(record *SCCTransferRecord, srcCategory DataCategory, destRegion Region) error {
	if record == nil {
		return errors.New("GDPR Art.46: no SCC record for cross-border transfer")
	}
	if record.DestinationRegion != destRegion {
		return fmt.Errorf("GDPR Art.46: SCC record covers destination %q, not %q",
			record.DestinationRegion, destRegion)
	}
	if time.Now().UTC().After(record.ExpiresAt) {
		return fmt.Errorf("GDPR Art.46: SCC record expired at %v", record.ExpiresAt)
	}
	if !record.TIAComplete {
		return errors.New("GDPR Art.46: transfer impact assessment not complete")
	}
	for _, cat := range record.DataCategories {
		if cat == srcCategory {
			return nil
		}
	}
	return fmt.Errorf("GDPR Art.46: SCC record does not cover data category %q", srcCategory)
}
```

### Junior → FAANG: Data Residency Is an Infrastructure Constraint, Not a Feature Flag

Data residency requirements mean that specific data must be stored and processed within a defined geographic boundary. The most common first-job mistake is treating residency as a configuration option that can be bolted on later. If your database, cache, search index, and async job queue all replicate globally by default, adding residency after the fact requires re-architecting each of them. The right time to handle residency is at the data model design stage, before any data is written to production.

First-job habit: for any new data type, ask "does any residency or sovereignty requirement apply to this data, and where does it come from?" The second half of that question matters as much as the first. If the answer is yes, that constraint and its source must appear in the architecture design document before the service is built. Standard Contractual Clauses (SCCs) are a legal mechanism for cross-border transfers under GDPR, but they do not make the transfer automatic. Your service must have a documented record of which transfer mechanism applies to each cross-border data flow.

Worth knowing that this ground moves. The adequacy status of a given destination is a political decision that gets made, challenged, and remade: EU-US transfers have run through Safe Harbor, then Privacy Shield, both struck down by the Court of Justice, and now the EU-US Data Privacy Framework adopted in 2023 and facing challenges of its own. Design so the mechanism is a data field you can change, not a constant compiled into a routing decision. Teams that hardcoded "US is adequate" have had to re-architect twice already.

### Senior @ FAANG: Residency Architecture as a Multi-Tenant Control Plane

At FAANG scale, data residency becomes a multi-tenant platform problem. Different customers have different residency requirements: a European customer may require EU-only storage, an Australian government customer may require in-country storage, and a US customer may have no geographic restriction but ITAR controls on certain data categories. The platform must enforce these constraints dynamically, per tenant, without service teams needing to understand each customer's regulatory profile.

The architecture for this is a residency control plane: a service that maps tenant identifiers to a residency policy, and a set of platform primitives that enforce the policy at the infrastructure layer. Database writes include a tenant-aware shard key that routes to the correct regional cluster. Message queues have regional topic partitions with cross-region replication disabled for restricted tenants. CDN configuration enforces origin-shield restrictions per tenant. Each of these mechanisms is driven by the same policy record from the control plane, so a change to a customer's residency policy propagates consistently across all platform components.

The harder problem is egress control. Data can enter a region without a transfer record, but leaving a region constitutes a cross-border transfer that may require a legal basis. A well-designed platform instruments all data egress points: API responses, data exports, analytics queries that cross regional boundaries, and support tooling access from staff in different regions. Each egress event is evaluated against the originating tenant's transfer policy before the data leaves. This requires that transfer policy evaluation is fast enough to be in the hot path of API calls, which typically means a local policy cache with a short TTL rather than a remote call per request.

ADR consideration: decide whether residency is enforced at the application layer (each service enforces its own residency rules), the data layer (the database cluster enforces residency through access controls), or the network layer (regional peering rules prevent data from leaving the correct boundary). Application-layer enforcement is flexible but relies on developers to implement it correctly in every service. Network-layer enforcement is robust but cannot distinguish data categories within a single connection. The right answer for a platform that must satisfy multiple regulatory regimes simultaneously is defense-in-depth: network-layer controls as a backstop, data-layer controls as the primary boundary, and application-layer classification metadata to distinguish restricted from unrestricted data within a single service.

---
