## 112D.2 Audit Logging (SOC 2 CC7.2)

SOC 2 CC7.2 concerns monitoring system components for anomalies that indicate malicious acts, and that monitoring is only as trustworthy as the record it reads from. Audit logs that can be deleted or silently modified are worthless as compliance evidence. The implementation below builds a tamper-evident audit trail by chaining each entry's HMAC over the previous entry's hash, forming a cryptographic linked list where any deletion or modification breaks the chain. The `AuditMiddleware` HTTP wrapper ensures every request is logged without requiring callers to instrument their handlers manually, satisfying the "all-or-nothing" requirement that no event goes unrecorded.

```go
package auditlog

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// AuditEvent represents an immutable audit log entry
type AuditEvent struct {
	ID           string          `json:"id"`
	Timestamp    time.Time       `json:"timestamp"`
	ActorID      string          `json:"actor_id"`      // Who
	ActorType    string          `json:"actor_type"`    // "user", "service", "system"
	Action       string          `json:"action"`        // What (READ, WRITE, DELETE, LOGIN, EXPORT)
	ResourceType string          `json:"resource_type"` // Orders, Users, Payments
	ResourceID   string          `json:"resource_id"`
	IPAddress    string          `json:"ip_address"`
	UserAgent    string          `json:"user_agent"`
	Success      bool            `json:"success"`
	Metadata     json.RawMessage `json:"metadata,omitempty"`
	PreviousID   string          `json:"previous_id,omitempty"` // For chaining
	Hash         string          `json:"hash"`                  // Tamper detection
}

// AuditLogger writes tamper-evident audit logs.
// The chain head is mutable shared state, so every write is serialized:
// two concurrent handlers reading the same prevHash would fork the chain
// and make VerifyIntegrity fail on a log that was never tampered with.
type AuditLogger struct {
	db         *sql.DB
	signingKey []byte

	mu       sync.Mutex
	prevHash string
}

func NewAuditLogger(db *sql.DB, signingKey []byte) *AuditLogger {
	return &AuditLogger{db: db, signingKey: signingKey}
}

// Resume loads the chain head from storage. Call it on startup, otherwise
// the first event after a restart links to an empty previous hash and
// verification reports a break where none exists.
func (al *AuditLogger) Resume(ctx context.Context) error {
	var hash string
	err := al.db.QueryRowContext(ctx, `
		SELECT hash FROM audit_logs ORDER BY timestamp DESC, id DESC LIMIT 1
	`).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // empty log, chain starts fresh
	}
	if err != nil {
		return fmt.Errorf("resume audit chain: %w", err)
	}

	al.mu.Lock()
	al.prevHash = hash
	al.mu.Unlock()
	return nil
}

// Log writes an immutable audit event
func (al *AuditLogger) Log(ctx context.Context, event AuditEvent) error {
	id, err := generateEventID()
	if err != nil {
		return fmt.Errorf("generate audit event id: %w", err)
	}
	event.ID = id

	// Truncate to microseconds: Postgres timestamptz stores microsecond
	// precision, so an untruncated nanosecond timestamp would hash one value
	// on write and a different value on read-back.
	event.Timestamp = time.Now().UTC().Truncate(time.Microsecond)

	// Normalize before hashing so the hashed bytes and the stored bytes are
	// identical. A nil RawMessage stores as SQL NULL but hashes as "".
	if len(event.Metadata) == 0 {
		event.Metadata = json.RawMessage(`{}`)
	}

	al.mu.Lock()
	defer al.mu.Unlock()

	event.PreviousID = al.prevHash

	// Compute HMAC for tamper detection
	event.Hash = al.computeHash(event)

	_, err = al.db.ExecContext(ctx, `
		INSERT INTO audit_logs
			(id, timestamp, actor_id, actor_type, action, resource_type, resource_id,
			 ip_address, user_agent, success, metadata, previous_id, hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
	`,
		event.ID, event.Timestamp, event.ActorID, event.ActorType,
		event.Action, event.ResourceType, event.ResourceID,
		event.IPAddress, event.UserAgent, event.Success,
		[]byte(event.Metadata), event.PreviousID, event.Hash,
	)
	if err != nil {
		return fmt.Errorf("write audit log: %w", err)
	}

	al.prevHash = event.Hash
	return nil
}

func (al *AuditLogger) computeHash(event AuditEvent) string {
	// Chain hash: includes previous hash for tamper detection.
	// RFC3339Nano in UTC is the canonical form. time.Time.String() is not:
	// it renders the monotonic reading and the location, neither of which
	// survives a round trip through the database.
	data := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%v|%s",
		event.ID, event.Timestamp.UTC().Format(time.RFC3339Nano),
		event.ActorID, event.Action,
		event.ResourceType, event.ResourceID,
		event.PreviousID, event.Success,
		string(event.Metadata),
	)

	mac := hmac.New(sha256.New, al.signingKey)
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyIntegrity checks that audit logs haven't been tampered with
func (al *AuditLogger) VerifyIntegrity(ctx context.Context, from, to time.Time) error {
	rows, err := al.db.QueryContext(ctx, `
		SELECT id, timestamp, actor_id, actor_type, action, resource_type, resource_id,
		       ip_address, user_agent, success, metadata, previous_id, hash
		FROM audit_logs
		WHERE timestamp BETWEEN $1 AND $2
		ORDER BY timestamp, id
	`, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()

	var prevHash string
	count := 0

	for rows.Next() {
		var event AuditEvent
		if err := rows.Scan(
			&event.ID, &event.Timestamp, &event.ActorID, &event.ActorType,
			&event.Action, &event.ResourceType, &event.ResourceID,
			&event.IPAddress, &event.UserAgent, &event.Success,
			&event.Metadata, &event.PreviousID, &event.Hash,
		); err != nil {
			// A scan failure is not proof of integrity. Fail closed.
			return fmt.Errorf("scan audit event: %w", err)
		}

		// Verify previous hash chain
		if count > 0 && event.PreviousID != prevHash {
			return fmt.Errorf("chain broken at event %s: expected previous=%s got=%s",
				event.ID, prevHash, event.PreviousID)
		}

		// Recompute hash. Compare in constant time: the comparison runs against
		// an attacker-supplied value, and a byte-at-a-time early exit leaks how
		// much of a forged HMAC is correct.
		expectedHash := al.computeHash(event)
		if !hmac.Equal([]byte(event.Hash), []byte(expectedHash)) {
			return fmt.Errorf("tampered event detected: id=%s", event.ID)
		}

		prevHash = event.Hash
		count++
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate audit events: %w", err)
	}

	return nil
}

// ctxKey is unexported so no other package can collide with these keys.
// A bare string key is a vet finding (SA1029) and a real collision risk.
type ctxKey string

const userIDKey ctxKey = "user_id"

// AuditMiddleware wraps HTTP handlers to log all requests.
// onFailure receives events that could not be persisted. Do not pass nil and
// do not make it a no-op: a dropped audit write is the exact gap CC7.2 asks
// you to close, so it belongs on a pager, not on the floor.
func AuditMiddleware(logger *AuditLogger, resourceType string, onFailure func(AuditEvent, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rw := &responseWriter{ResponseWriter: w, code: 200}

			start := time.Now()
			next.ServeHTTP(rw, r)

			actorID, _ := r.Context().Value(userIDKey).(string)

			event := AuditEvent{
				ActorID:      actorID,
				ActorType:    "user",
				Action:       r.Method,
				ResourceType: resourceType,
				ResourceID:   r.URL.Path,
				IPAddress:    r.RemoteAddr,
				UserAgent:    r.UserAgent(),
				Success:      rw.code < 400,
				Metadata:     json.RawMessage(fmt.Sprintf(`{"duration_ms":%d}`, time.Since(start).Milliseconds())),
			}

			// The response is already written, so the request context may be on
			// its way to cancellation. Give the audit write its own deadline
			// rather than letting a client disconnect erase the record.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
			defer cancel()

			if err := logger.Log(ctx, event); err != nil {
				onFailure(event, err)
			}
		})
	}
}

type responseWriter struct {
	http.ResponseWriter
	code int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.code = code
	rw.ResponseWriter.WriteHeader(code)
}

// generateEventID returns a collision-free identifier. A UnixNano timestamp
// is not one: two events logged in the same nanosecond tick collide, and the
// primary key conflict drops an audit record.
func generateEventID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "aud-" + hex.EncodeToString(b[:]), nil
}
```

### Junior → FAANG: Why Audit Logs Are a First-Class Engineering Requirement

Audit logging is often added as an afterthought. At companies under SOC 2 scope, that approach fails the first audit. Detecting anomalies under CC7.2 presumes events are captured completely and protected against modification, and an auditor will test both. Two first-job habits that matter: first, wire audit logging into middleware rather than individual handlers so coverage is structural, not incidental. Second, never write audit logs to the same database as application data without append-only constraints, because a single compromised admin credential can erase both the data and the evidence.

Interview entry point: if asked "how would you design an audit log system," start by distinguishing between operational logs (debugging, latency) and compliance logs (who accessed what, when, from where, with what result). Compliance logs need tamper-evidence, defined retention periods, and structured fields that map to the control criteria an auditor will query. Show that you know why HMAC chaining matters: deleting a single entry breaks every subsequent hash, making omission detectable.

### Senior @ FAANG: Audit Infrastructure as a Trust Anchor

At scale, audit logging becomes an infrastructure contract, not an application feature. The audit pipeline must provide three guarantees independently of the application writing to it: completeness (no event is silently dropped), integrity (no event is modified or deleted without detection), and availability to auditors (events are queryable within the retention window without involving the application team). Each guarantee requires a different engineering control.

Completeness is achieved through a durable write-ahead buffer between the application and the storage backend: a replicated log such as Kafka with a replication factor of three and acks set to all, or a managed equivalent that replicates across availability zones. If the storage backend is unavailable, the buffer absorbs writes rather than dropping them. The application writes fire-and-forget to the buffer, which means the audit system's unavailability never becomes the application's availability problem.

Integrity is achieved through the HMAC chaining pattern shown above, combined with write-once storage (S3 Object Lock in compliance mode, GCS with retention policies, or an append-only Postgres table where the application role is granted INSERT and SELECT but never UPDATE or DELETE, with a rule or trigger rejecting both for defense in depth).

Availability requires a separate read path with its own indexing. Auditors query by actor, resource, time window, and action type. Without indexes on those fields, a query covering six months of audit data for a single user can take minutes on a large table, which is a problem during an incident investigation. A staff-level design separates the write path (high-throughput append, no indexes updated synchronously) from the read path (materialized views or a dedicated OLAP sink like BigQuery or Redshift).

ADR consideration: decide at the platform level whether audit logs are owned by the security team (centralized SIEM ingestion), the data platform team (warehouse with access controls), or each service team (federated, with a schema contract enforced by the event registry). Federated ownership scales better but produces schema drift that makes cross-service queries unreliable during incidents. The right answer for a platform at FAANG scale is a centralized schema registry with service-level event schemas that must be approved before deployment.

---
