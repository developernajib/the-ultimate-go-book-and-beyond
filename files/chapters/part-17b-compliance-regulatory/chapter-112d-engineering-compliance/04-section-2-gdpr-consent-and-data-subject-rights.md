## 112D.3 GDPR - Consent and Data Subject Rights

GDPR requires that every data processing activity rests on a lawful basis, and for consent-based processing that basis must be recorded with proof of when, from which IP, and under which version of the privacy policy it was obtained. The code below implements the three most operationally demanding GDPR rights: the right to withdraw consent (Article 7), the right to erasure (Article 17), and the right to data portability (Article 20). The `ErasureService` delegates deletions to a slice of `DataEraser` implementations, following the Open-Closed Principle so that new data stores can be added without modifying the erasure pipeline itself. The `Pseudonymizer` demonstrates how to replace real identifiers with keyed-hash pseudonyms for analytics workloads that must be decoupled from PII but still need deterministic grouping.

```go
package gdpr

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ConsentRecord records a user's consent choices
type ConsentRecord struct {
	UserID      string
	Purpose     string // "marketing", "analytics", "essential"
	Granted     bool
	GrantedAt   time.Time
	IP          string
	Version     string // Privacy policy version
	WithdrawnAt *time.Time
}

// ConsentManager manages GDPR consent lifecycle
type ConsentManager struct {
	db *sql.DB
}

func NewConsentManager(db *sql.DB) *ConsentManager {
	return &ConsentManager{db: db}
}

// Grant records user consent.
//
// The table is append-only. An upsert keyed on (user_id, purpose) would be the
// obvious implementation and it is the wrong one: Article 7(1) requires the
// controller to be able to demonstrate that the subject consented, and
// overwriting the row destroys the evidence of every prior grant, including the
// policy version it was given under. Each decision is a new row. Current state
// is derived, not stored.
func (cm *ConsentManager) Grant(ctx context.Context, record ConsentRecord) error {
	record.GrantedAt = time.Now().UTC()
	_, err := cm.db.ExecContext(ctx, `
		INSERT INTO consent_records (user_id, purpose, granted, granted_at, ip, policy_version)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, record.UserID, record.Purpose, record.Granted, record.GrantedAt, record.IP, record.Version)
	if err != nil {
		return fmt.Errorf("record consent grant: %w", err)
	}
	return nil
}

// Withdraw revokes consent for a specific purpose. Article 7(3) requires that
// withdrawal be as easy as granting, and that it not affect the lawfulness of
// processing already carried out, which is another reason the history stays.
func (cm *ConsentManager) Withdraw(ctx context.Context, userID, purpose, ip string) error {
	now := time.Now().UTC()
	_, err := cm.db.ExecContext(ctx, `
		INSERT INTO consent_records (user_id, purpose, granted, granted_at, ip, withdrawn_at)
		VALUES ($1, $2, false, $3, $4, $3)
	`, userID, purpose, now, ip)
	if err != nil {
		return fmt.Errorf("record consent withdrawal: %w", err)
	}
	return nil
}

// HasConsent checks if a user has active consent for a purpose by reading the
// most recent decision. It fails closed: any error returns false, because
// treating an unreadable consent store as consent is exactly the failure mode
// that turns an outage into an unlawful-processing finding.
func (cm *ConsentManager) HasConsent(ctx context.Context, userID, purpose string) (bool, error) {
	var granted bool
	var withdrawnAt *time.Time
	err := cm.db.QueryRowContext(ctx, `
		SELECT granted, withdrawn_at FROM consent_records
		WHERE user_id = $1 AND purpose = $2
		ORDER BY granted_at DESC, id DESC
		LIMIT 1
	`, userID, purpose).Scan(&granted, &withdrawnAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil // no record is not consent
	}
	if err != nil {
		return false, fmt.Errorf("read consent: %w", err)
	}
	return granted && withdrawnAt == nil, nil
}

// ─── Right to Erasure (GDPR Article 17) ───

// ErasureRequest represents a right-to-erasure request
type ErasureRequest struct {
	UserID      string
	RequestedAt time.Time
	Reason      string
	CompletedAt *time.Time
}

// ErasureService handles data deletion requests
type ErasureService struct {
	db      *sql.DB
	erasers []DataEraser
}

// DataEraser handles deletion of a specific data category
type DataEraser interface {
	EraseUserData(ctx context.Context, userID string) (int, error)
	Name() string
}

func NewErasureService(db *sql.DB, erasers ...DataEraser) *ErasureService {
	return &ErasureService{db: db, erasers: erasers}
}

// ProcessErasureRequest executes a right-to-erasure request
func (es *ErasureService) ProcessErasureRequest(ctx context.Context, req ErasureRequest) (*ErasureReport, error) {
	report := &ErasureReport{
		UserID:      req.UserID,
		RequestedAt: req.RequestedAt,
		StartedAt:   time.Now().UTC(),
	}

	// Every eraser runs even if an earlier one fails. Erasure is not
	// transactional across stores, so stopping at the first error leaves the
	// subject's data in the stores we never reached, with nothing recording
	// that we skipped them.
	for _, eraser := range es.erasers {
		count, err := eraser.EraseUserData(ctx, req.UserID)
		result := ErasureResult{
			DataCategory:  eraser.Name(),
			RecordsErased: count,
		}
		if err != nil {
			result.Error = err.Error()
			report.HasErrors = true
		}
		report.Results = append(report.Results, result)
	}

	// CompletedAt is only set on full success. A partial erasure that stamps a
	// completion time is worse than no stamp at all: it tells the next auditor
	// the request was fulfilled when data is still sitting in a store that
	// errored out.
	finishedAt := time.Now().UTC()
	if !report.HasErrors {
		report.CompletedAt = &finishedAt
	}

	// Record the erasure attempt, successful or not.
	if _, err := es.db.ExecContext(ctx, `
		INSERT INTO erasure_requests (user_id, requested_at, completed_at, report)
		VALUES ($1, $2, $3, $4)
	`, req.UserID, req.RequestedAt, report.CompletedAt, toJSON(report)); err != nil {
		return report, fmt.Errorf("record erasure request: %w", err)
	}

	if report.HasErrors {
		return report, fmt.Errorf("erasure incomplete for user %s: %d of %d categories failed",
			req.UserID, countErrors(report.Results), len(report.Results))
	}

	return report, nil
}

func countErrors(results []ErasureResult) int {
	n := 0
	for _, r := range results {
		if r.Error != "" {
			n++
		}
	}
	return n
}

type ErasureReport struct {
	UserID      string
	RequestedAt time.Time
	StartedAt   time.Time
	CompletedAt *time.Time
	Results     []ErasureResult
	HasErrors   bool
}

type ErasureResult struct {
	DataCategory  string
	RecordsErased int
	Error         string
}

// ─── Data Portability (GDPR Article 20) ───

// DataExporter generates user data exports
type DataExporter struct {
	db *sql.DB
}

type UserDataExport struct {
	ExportedAt time.Time        `json:"exported_at"`
	UserID     string           `json:"user_id"`
	Profile    map[string]any   `json:"profile"`
	Orders     []map[string]any `json:"orders"`
	Consents   []ConsentRecord  `json:"consents"`
}

// Export builds an Article 20 portability export. Article 20 requires a
// structured, commonly used, machine-readable format, which JSON satisfies.
//
// Note what this does not do: it never swallows a read error. An export that
// silently omits a category the subject actually has data in is an incomplete
// response to a statutory request, and it is indistinguishable from a correct
// export of an empty category unless the error is surfaced.
func (de *DataExporter) Export(ctx context.Context, userID string) (*UserDataExport, error) {
	export := &UserDataExport{
		ExportedAt: time.Now().UTC(),
		UserID:     userID,
	}

	// Collect profile data
	profile := make(map[string]any)
	var id, email, name string
	var createdAt time.Time
	err := de.db.QueryRowContext(ctx,
		"SELECT id, email, name, created_at FROM users WHERE id = $1", userID).
		Scan(&id, &email, &name, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("no such user: %s", userID)
	}
	if err != nil {
		return nil, fmt.Errorf("export profile: %w", err)
	}
	profile["id"] = id
	profile["email"] = email
	profile["name"] = name
	profile["created_at"] = createdAt
	export.Profile = profile

	// Collect consent history. The full history is exported, not just the
	// current state: it is the subject's own data and they are entitled to it.
	consents, err := de.exportConsents(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("export consents: %w", err)
	}
	export.Consents = consents

	// Orders and every other category follow the same shape: one collector per
	// store, each returning an error the caller must not discard. In a real
	// deployment these are registered the way ErasureService registers its
	// DataEraser implementations, so adding a store cannot silently skip the
	// export path.
	orders, err := de.exportOrders(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("export orders: %w", err)
	}
	export.Orders = orders

	return export, nil
}

func (de *DataExporter) exportConsents(ctx context.Context, userID string) ([]ConsentRecord, error) {
	rows, err := de.db.QueryContext(ctx, `
		SELECT user_id, purpose, granted, granted_at, ip, policy_version, withdrawn_at
		FROM consent_records WHERE user_id = $1 ORDER BY granted_at
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ConsentRecord
	for rows.Next() {
		var c ConsentRecord
		if err := rows.Scan(&c.UserID, &c.Purpose, &c.Granted,
			&c.GrantedAt, &c.IP, &c.Version, &c.WithdrawnAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (de *DataExporter) exportOrders(ctx context.Context, userID string) ([]map[string]any, error) {
	rows, err := de.db.QueryContext(ctx, `
		SELECT id, total_cents, currency, placed_at
		FROM orders WHERE user_id = $1 ORDER BY placed_at
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []map[string]any
	for rows.Next() {
		var id, currency string
		var totalCents int64
		var placedAt time.Time
		if err := rows.Scan(&id, &totalCents, &currency, &placedAt); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id":          id,
			"total_cents": totalCents,
			"currency":    currency,
			"placed_at":   placedAt,
		})
	}
	return out, rows.Err()
}

// ─── Pseudonymization for Analytics ───

// Pseudonymizer replaces PII with pseudonyms for analytics.
//
// This is a keyed hash, not encryption, and that is deliberate on two counts.
//
// First, determinism. Analytics needs the same subject to map to the same
// pseudonym across events, otherwise you cannot count users, only rows. AES-GCM
// cannot do this: it requires a fresh nonce per encryption, and reusing a nonce
// under one key is catastrophic for GCM. A randomly-nonced ciphertext is a
// different string every call, which silently destroys every cohort it touches.
//
// Second, one-wayness. Nothing here needs to recover the real ID from the
// pseudonym, and an HMAC cannot. That is a feature: it removes the ciphertext
// as an attack path entirely.
//
// Destroying the key is what makes this cryptographic erasure. Note the limit:
// the input space of user IDs is often small and guessable, so anyone holding
// both the key and a candidate ID list can confirm a match by recomputing.
// Under GDPR this is pseudonymized data (Article 4(5)), still personal data,
// still in scope. It is not anonymization.
type Pseudonymizer struct {
	key []byte // HMAC key, destroyed to render pseudonyms unlinkable
}

func NewPseudonymizer(key []byte) (*Pseudonymizer, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes, got %d", len(key))
	}
	return &Pseudonymizer{key: key}, nil
}

// Pseudonymize replaces a real ID with a deterministic pseudonym. The domain
// separator keeps pseudonyms for different entity types from colliding when the
// same key is used for both.
func (p *Pseudonymizer) Pseudonymize(domain, realID string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte(domain))
	mac.Write([]byte{0}) // unambiguous boundary, so ("ab","c") != ("a","bc")
	mac.Write([]byte(realID))
	return hex.EncodeToString(mac.Sum(nil))
}

func toJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}
```

### Junior → FAANG: Treating GDPR Rights as API Contracts

The three rights in this section (withdrawal, erasure, portability) are not edge cases. A user can exercise any of them at any time, and the GDPR clock starts the moment the request arrives, not when your team gets around to it. The deadline does not live in the articles that grant the rights. It is Article 12(3), which applies to all of them: respond without undue delay and in any event within one month of receipt, extendable by two further months where the request is complex, provided you tell the subject about the extension within that first month. Engineer to the one month and treat the extension as an escape hatch you have to justify, not as budget. First-job habit: treat each right as a first-class API with an SLA backed by an internal tracking ticket. If your service stores user data, you need a documented answer to "what does erasure mean for this data type" before you go to production, not after your first real request.

Interview framing: when asked about GDPR, show that you understand the difference between deletion and pseudonymization. Deleted data satisfies erasure for records you own. Pseudonymized data satisfies analytics requirements where you cannot delete without destroying cohort integrity. The key is that pseudonymization must be done with a key that can be destroyed, so that destroying it makes re-identification infeasible even though the pseudonyms remain. This is called cryptographic erasure. Know the caveat too, because interviewers probe it: pseudonymized data is still personal data under Article 4(5) and remains in scope for the regulation. Only genuine anonymization leaves scope, and that bar is much higher than running your IDs through a hash.

### Senior @ FAANG: Operationalizing Data Subject Rights at Platform Scale

At a platform with tens of millions of users, data subject rights create two distinct engineering problems. The first is data discovery: before you can erase or export a user's data, you need a complete, accurate map of every system that holds data associated with that user. At most large companies this map does not exist, or it exists in a wiki page that is perpetually out of date. The staff-level solution is a data catalog with ownership metadata and a propagation protocol: when a new service registers a schema that includes a user identifier field, it must also register a handler for each supported right. The platform then orchestrates rights-fulfillment workflows by calling each handler, collecting results, and tracking completion.

The second problem is consistency across distributed systems. An erasure request issued at time T must remove data from the primary database, the analytics warehouse, the search index, the CDN cache, and every backup taken after T. Backups are the hardest part. Most teams restore backups monthly at most, which means an erasure-then-restore scenario could reintroduce PII. The engineering control is a suppression list: after erasure, the user's identifier is added to a durable suppression list. Any data pipeline that reads from backups must check the suppression list and filter matching records before writing to any downstream system.

ADR for staff engineers: decide whether rights fulfillment is synchronous (API returns 200 when all erasures are complete) or asynchronous (API returns 202 with a tracking ID, fulfillment happens via a workflow). Synchronous fulfillment is simpler to reason about but couples your API latency to your slowest data store. Asynchronous fulfillment scales better but requires a durable workflow engine (Temporal, Step Functions, or a custom saga) that can retry failed handlers without double-erasing completed ones. For any system handling more than a few thousand rights requests per month, asynchronous is the right default.

Consent versioning is a separate concern that junior engineers frequently underestimate. When the privacy policy changes, you need to know which users consented under which version, and you need to re-obtain consent for purposes that were not covered by the earlier version. This requires versioning the consent schema and storing the effective-from date alongside the user's consent record, not just a boolean flag.

---
