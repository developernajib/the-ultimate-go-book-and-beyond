## Production Go Implementation: Idempotent Payment Processor

This production-quality payment processor implements the core payment flow with idempotency guarantees, state machine transitions, and double-entry ledger integration. Unlike the earlier code snippets that focused on individual components, this implementation wires everything together into a single cohesive service using Go interfaces for dependency injection. The repository pattern makes it straightforward to swap the SQL-backed storage for an in-memory implementation during testing.

Before the code, be clear about where the idempotency guarantee actually lives, because this is the single most common way a payment service looks correct and is not. This service runs on twenty instances. An in-process `sync.Mutex` keyed by idempotency key, which is what you will see in most implementations of this shape, serializes duplicate requests that happen to land on the same instance and does exactly nothing about the two retries that land on different ones. It is a useful optimization and it is not a guarantee. The guarantee has to be something all twenty instances share: a `UNIQUE` constraint on the idempotency key, plus a payment ID derived deterministically from that key, so that the second writer loses at the database no matter which instance it is running on.

```go
package payment

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// --- Payment Domain Types ---

type PaymentStatus string

const (
	StatusPending           PaymentStatus = "PENDING"
	StatusAuthorized        PaymentStatus = "AUTHORIZED"
	StatusCaptured          PaymentStatus = "CAPTURED"
	StatusSettled           PaymentStatus = "SETTLED"
	StatusPartiallyRefunded PaymentStatus = "PARTIALLY_REFUNDED"
	StatusRefunded          PaymentStatus = "REFUNDED"
	StatusFailed            PaymentStatus = "FAILED"
	StatusCanceled          PaymentStatus = "CANCELED"
)

// ValidTransitions defines the payment state machine.
var ValidTransitions = map[PaymentStatus][]PaymentStatus{
	StatusPending:    {StatusAuthorized, StatusFailed, StatusCanceled},
	StatusAuthorized: {StatusCaptured, StatusCanceled, StatusFailed},
	StatusCaptured:   {StatusSettled, StatusPartiallyRefunded, StatusRefunded, StatusFailed},
	StatusSettled:    {StatusPartiallyRefunded, StatusRefunded},
	// A partially refunded payment can be refunded again, up to the
	// remaining balance. Omitting the self-transition is what makes a
	// second partial refund impossible.
	StatusPartiallyRefunded: {StatusPartiallyRefunded, StatusRefunded},
	StatusRefunded:          {},
	StatusFailed:            {},
	StatusCanceled:          {},
}

// Sentinel errors. Callers need to tell these apart: a duplicate key is a
// success to be replayed, a conflict is a client error, and an ambiguous
// outcome is an operational event.
var (
	ErrDuplicateKey  = errors.New("idempotency key already exists")
	ErrKeyReuse      = errors.New("idempotency key reused with different parameters")
	ErrFraudDeclined = errors.New("payment declined by fraud check")
)

// Payment represents a payment transaction.
type Payment struct {
	ID             string        `json:"id"`
	IdempotencyKey string        `json:"idempotency_key"`
	MerchantID     string        `json:"merchant_id"`
	Amount         int64         `json:"amount"` // in smallest currency unit (cents)
	Currency       string        `json:"currency"`
	Status         PaymentStatus `json:"status"`
	// RequestHash fingerprints the parameters this key was first used
	// with. Stripe returns a 400 when a key is replayed with a different
	// payload, and the reason is worth understanding: without this, a
	// client bug that reuses one key for two genuinely different charges
	// gets the first charge's result handed back for the second, and a
	// real payment is silently never made.
	RequestHash    []byte          `json:"-"`
	ProcessorRef   string          `json:"processor_ref"` // external processor reference
	CustomerEmail  string          `json:"customer_email"`
	Description    string          `json:"description"`
	Metadata       json.RawMessage `json:"metadata"`
	RefundedAmount int64           `json:"refunded_amount"`
	FailureReason  string          `json:"failure_reason,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

// fingerprint hashes the parameters that define what this payment IS.
// Two requests with the same key and the same fingerprint are a retry.
// The same key with a different fingerprint is a client bug.
func (p *Payment) fingerprint() []byte {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%d|%s|%s",
		p.MerchantID, p.Currency, p.Amount, p.CustomerEmail, p.Description)
	return h.Sum(nil)
}

// LedgerEntry represents one side of a double-entry accounting record.
type LedgerEntry struct {
	ID          string    `json:"id"`
	PaymentID   string    `json:"payment_id"`
	AccountID   string    `json:"account_id"`
	EntryType   string    `json:"entry_type"`   // "DEBIT" or "CREDIT"
	Amount      int64     `json:"amount"`
	Currency    string    `json:"currency"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

// --- Interfaces ---

type PaymentRepository interface {
	GetByID(ctx context.Context, id string) (*Payment, error)
	// Scoped by merchant: idempotency keys are merchant-chosen and only
	// unique within a merchant, so a lookup by key alone would match
	// another merchant's payment.
	GetByIdempotencyKey(ctx context.Context, merchantID, key string) (*Payment, error)
	// Create returns ErrDuplicateKey when the UNIQUE constraint on
	// idempotency_key rejects the insert. That error is not a failure:
	// it is the database telling us another request won the race, and it
	// is the load-bearing part of the whole design.
	Create(ctx context.Context, p *Payment) error
	UpdateStatus(ctx context.Context, id string, from, to PaymentStatus) error
	SetAuthorized(ctx context.Context, id, processorRef string) error
	// ReserveRefund atomically adds amount to refunded_amount only if it
	// fits within the original, and moves status accordingly. Returns the
	// updated payment, or an error if the budget no longer covers it.
	ReserveRefund(ctx context.Context, id string, amount int64) (*Payment, error)
	ReleaseRefund(ctx context.Context, id string, amount int64) error
}

type LedgerRepository interface {
	RecordEntries(ctx context.Context, entries []LedgerEntry) error
	GetBalance(ctx context.Context, accountID, currency string) (int64, error)
}

type PaymentProcessor interface {
	Authorize(ctx context.Context, p *Payment) (processorRef string, err error)
	Capture(ctx context.Context, processorRef string, amount int64) error
	Refund(ctx context.Context, processorRef string, amount int64) error
}

type FraudChecker interface {
	Check(ctx context.Context, p *Payment) (score float64, err error)
}

// --- Idempotent Payment Service ---

// PaymentService is the core payment processing service.
// It guarantees at-most-once processing via idempotency keys.
//
// There is deliberately no in-process lock map here. The obvious
// implementation keeps a sync.Map of mutexes keyed by idempotency key,
// and it has two problems that cancel out its apparent benefit. It never
// removes entries, so it leaks a mutex per unique key forever, which at
// 100M payments a day is not a slow leak. More importantly it is
// per-process: with twenty instances behind a load balancer, two retries
// of the same key usually land on different instances and never contend
// on the same mutex at all. It provides the feeling of safety and none of
// it. The deterministic payment ID and the UNIQUE constraint below are
// what actually make this safe, and they work across every instance
// because the database is the thing they share.
type PaymentService struct {
	repo      PaymentRepository
	ledger    LedgerRepository
	processor PaymentProcessor
	fraud     FraudChecker
}

func NewPaymentService(
	repo PaymentRepository,
	ledger LedgerRepository,
	processor PaymentProcessor,
	fraud FraudChecker,
) *PaymentService {
	return &PaymentService{
		repo:      repo,
		ledger:    ledger,
		processor: processor,
		fraud:     fraud,
	}
}

// CreatePayment processes a new payment request with idempotency guarantee.
func (s *PaymentService) CreatePayment(ctx context.Context, req *Payment) (*Payment, error) {
	if req.IdempotencyKey == "" {
		return nil, fmt.Errorf("idempotency_key is required")
	}
	if req.Amount <= 0 {
		return nil, fmt.Errorf("amount must be positive")
	}
	if req.Currency == "" {
		return nil, fmt.Errorf("currency is required")
	}

	// Fast path: a retry of something we already finished.
	existing, err := s.repo.GetByIdempotencyKey(ctx, req.MerchantID, req.IdempotencyKey)
	if err != nil {
		// We could not determine whether this key was already charged.
		// Fail closed. Proceeding here means a Redis or database blip
		// turns every in-flight retry into a second charge.
		return nil, fmt.Errorf("idempotency lookup: %w", err)
	}
	if existing != nil {
		return replayOrConflict(existing, req)
	}

	// The payment ID is derived from merchant + key, not random. Two
	// racing requests with the same key compute the same ID, so the
	// second insert collides on the primary key instead of creating a
	// second payment. Note the merchant scoping: idempotency keys are
	// merchant-chosen and only unique within a merchant, so hashing the
	// key alone would let two merchants who both pick "1" collide onto
	// one payment.
	req.ID = paymentID(req.MerchantID, req.IdempotencyKey)
	req.RequestHash = req.fingerprint()
	req.Status = StatusPending
	req.CreatedAt = time.Now()
	req.UpdatedAt = time.Now()

	// Persist initial state before any external call. This row is the
	// write-ahead record reconciliation depends on.
	if err := s.repo.Create(ctx, req); err != nil {
		if errors.Is(err, ErrDuplicateKey) {
			// Lost the race. The winner's row is the truth.
			winner, gerr := s.repo.GetByIdempotencyKey(ctx, req.MerchantID, req.IdempotencyKey)
			if gerr != nil || winner == nil {
				return nil, fmt.Errorf("duplicate key but winner unreadable: %w", err)
			}
			return replayOrConflict(winner, req)
		}
		return nil, fmt.Errorf("create payment: %w", err)
	}

	// Fraud check. Fail closed: an unscored payment is an unpriced risk,
	// and "the scorer was down" is not a reason to accept it. Defaulting
	// the score to a passing value when the service is unavailable means
	// an outage of the fraud system becomes an open door, which is
	// precisely when someone is most likely to be pushing on it.
	score, err := s.fraud.Check(ctx, req)
	if err != nil {
		s.failPayment(ctx, req, "fraud_unavailable")
		return req, fmt.Errorf("fraud check unavailable: %w", err)
	}
	if score > 0.8 {
		s.failPayment(ctx, req, "fraud_detected")
		return req, fmt.Errorf("%w (score=%.2f)", ErrFraudDeclined, score)
	}

	// Authorize with payment processor
	processorRef, err := s.processor.Authorize(ctx, req)
	if err != nil {
		s.failPayment(ctx, req, err.Error())
		return req, fmt.Errorf("authorization failed: %w", err)
	}

	// Record the processor reference and the new state together. If this
	// fails we hold an authorization the database does not know about, so
	// it must not be swallowed: leave the row pending and let
	// reconciliation match it to the processor's authorization.
	if err := s.repo.SetAuthorized(ctx, req.ID, processorRef); err != nil {
		return nil, fmt.Errorf("authorized at processor (%s) but not persisted: %w",
			processorRef, err)
	}

	req.ProcessorRef = processorRef
	req.Status = StatusAuthorized
	return req, nil
}

// replayOrConflict decides what an existing row means for this request.
// Same parameters: it is a retry, replay the original answer. Different
// parameters: the client reused a key for a different charge, which is a
// bug on their side that must surface as a 400 rather than as a silent
// wrong answer.
func replayOrConflict(existing, req *Payment) (*Payment, error) {
	if !hmacEqual(existing.RequestHash, req.fingerprint()) {
		return nil, fmt.Errorf("%w: key %q", ErrKeyReuse, req.IdempotencyKey)
	}
	return existing, nil
}

// failPayment records a terminal failure. The status update is checked
// because a payment we believe we declined but never wrote is a payment
// that reconciliation will later find pending and have to resolve.
func (s *PaymentService) failPayment(ctx context.Context, p *Payment, reason string) {
	p.Status = StatusFailed
	p.FailureReason = reason
	if err := s.repo.UpdateStatus(ctx, p.ID, StatusPending, StatusFailed); err != nil {
		alertEngineering(ctx, "failed to persist payment failure", p.ID, err)
	}
}

// CapturePayment captures an authorized payment and records ledger entries.
func (s *PaymentService) CapturePayment(ctx context.Context, paymentID string) (*Payment, error) {
	payment, err := s.repo.GetByID(ctx, paymentID)
	if err != nil {
		return nil, fmt.Errorf("payment not found: %w", err)
	}

	if !s.isValidTransition(payment.Status, StatusCaptured) {
		return nil, fmt.Errorf("cannot capture payment in status %s", payment.Status)
	}

	// Capture with processor
	if err := s.processor.Capture(ctx, payment.ProcessorRef, payment.Amount); err != nil {
		return nil, fmt.Errorf("capture failed: %w", err)
	}

	// Record double-entry ledger entries
	entries := []LedgerEntry{
		{
			ID:          fmt.Sprintf("LE-%s-debit", paymentID),
			PaymentID:   paymentID,
			AccountID:   fmt.Sprintf("customer:%s", payment.CustomerEmail),
			EntryType:   "DEBIT",
			Amount:      payment.Amount,
			Currency:    payment.Currency,
			Description: fmt.Sprintf("Payment %s capture", paymentID),
			CreatedAt:   time.Now(),
		},
		{
			ID:          fmt.Sprintf("LE-%s-credit", paymentID),
			PaymentID:   paymentID,
			AccountID:   fmt.Sprintf("merchant:%s", payment.MerchantID),
			EntryType:   "CREDIT",
			Amount:      payment.Amount,
			Currency:    payment.Currency,
			Description: fmt.Sprintf("Payment %s capture", paymentID),
			CreatedAt:   time.Now(),
		},
	}

	// Entry IDs are derived from the payment ID, so a retry of this
	// capture produces the same two IDs and collides with the originals
	// rather than posting a second pair. RecordEntries writes both rows
	// in one transaction, or neither.
	if err := s.ledger.RecordEntries(ctx, entries); err != nil {
		// The money moved and the ledger does not know. Leave the status
		// at AUTHORIZED so this payment stays visible to reconciliation,
		// and page: this is a real discrepancy, not a retryable blip.
		alertEngineering(ctx, "CRITICAL: captured at processor but ledger write failed", paymentID, err)
		return nil, fmt.Errorf("ledger write failed: %w", err)
	}

	if err := s.repo.UpdateStatus(ctx, paymentID, StatusAuthorized, StatusCaptured); err != nil {
		// Captured and ledgered, but still reading as AUTHORIZED. Left
		// unhandled, a retry would call Capture again at the processor.
		alertEngineering(ctx, "CRITICAL: capture recorded but status not updated", paymentID, err)
		return nil, fmt.Errorf("capture status update failed: %w", err)
	}

	payment.Status = StatusCaptured
	return payment, nil
}

// RefundPayment processes a full or partial refund.
//
// amount of 0 means "refund whatever remains". Any negative amount is an
// error rather than a synonym for a full refund: silently reinterpreting
// a nonsense amount as "give the customer everything" is not a mercy.
func (s *PaymentService) RefundPayment(ctx context.Context, paymentID string, amount int64) (*Payment, error) {
	if amount < 0 {
		return nil, fmt.Errorf("refund amount cannot be negative: %d", amount)
	}

	payment, err := s.repo.GetByID(ctx, paymentID)
	if err != nil {
		return nil, fmt.Errorf("payment not found: %w", err)
	}

	if amount == 0 {
		amount = payment.Amount - payment.RefundedAmount // refund the remainder
	}
	if amount <= 0 {
		return nil, fmt.Errorf("payment %s is already fully refunded", paymentID)
	}

	// Reserve against the remaining refundable balance in a single
	// conditional UPDATE. The check that matters is not the one above,
	// which read a value that may already be stale: it is the one inside
	// ReserveRefund's WHERE clause, which the database re-evaluates
	// against the current row. Two concurrent $60 refunds against a $100
	// payment both pass an in-process check and only one survives this.
	payment, err = s.repo.ReserveRefund(ctx, paymentID, amount)
	if err != nil {
		return nil, fmt.Errorf("reserve refund: %w", err)
	}

	// Process refund with processor
	if err := s.processor.Refund(ctx, payment.ProcessorRef, amount); err != nil {
		// Give the reservation back so the merchant can retry. On an
		// ambiguous processor error this is the wrong move and the
		// reservation should stand pending reconciliation, which is why
		// the processor interface has to distinguish the two.
		if relErr := s.repo.ReleaseRefund(ctx, paymentID, amount); relErr != nil {
			alertEngineering(ctx, "CRITICAL: refund reservation stuck", paymentID, relErr)
		}
		return nil, fmt.Errorf("refund failed: %w", err)
	}

	// Record reverse ledger entries
	entries := []LedgerEntry{
		{
			ID:          fmt.Sprintf("LE-%s-refund-credit", paymentID),
			PaymentID:   paymentID,
			AccountID:   fmt.Sprintf("customer:%s", payment.CustomerEmail),
			EntryType:   "CREDIT",
			Amount:      amount,
			Currency:    payment.Currency,
			Description: fmt.Sprintf("Refund for payment %s", paymentID),
			CreatedAt:   time.Now(),
		},
		{
			ID:          fmt.Sprintf("LE-%s-refund-debit", paymentID),
			PaymentID:   paymentID,
			AccountID:   fmt.Sprintf("merchant:%s", payment.MerchantID),
			EntryType:   "DEBIT",
			Amount:      amount,
			Currency:    payment.Currency,
			Description: fmt.Sprintf("Refund for payment %s", paymentID),
			CreatedAt:   time.Now(),
		},
	}

	if err := s.ledger.RecordEntries(ctx, entries); err != nil {
		alertEngineering(ctx, "CRITICAL: refund issued but ledger write failed", paymentID, err)
		return nil, fmt.Errorf("ledger refund write failed: %w", err)
	}

	// ReserveRefund already moved the status to PARTIALLY_REFUNDED or
	// REFUNDED as part of the same atomic update, so there is nothing to
	// set here. Recomputing it in Go from a value read earlier is how the
	// status ends up disagreeing with refunded_amount.
	return payment, nil
}

func (s *PaymentService) isValidTransition(from, to PaymentStatus) bool {
	validTargets, exists := ValidTransitions[from]
	if !exists {
		return false
	}
	for _, t := range validTargets {
		if t == to {
			return true
		}
	}
	return false
}

// paymentID derives a stable ID from the merchant and their idempotency
// key. Deterministic on purpose: two racing retries compute the same ID,
// so the loser collides on the primary key instead of creating a second
// payment. The merchant ID is in the hash because idempotency keys are
// only unique within a merchant, and two merchants both choosing "order-1"
// must not land on the same payment.
func paymentID(merchantID, idempotencyKey string) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s", merchantID, idempotencyKey)
	return "PAY-" + hex.EncodeToString(h.Sum(nil)[:16])
}

// hmacEqual compares fingerprints in constant time. These are not
// secrets, so this is habit rather than necessity, but it is a good habit
// and it costs nothing here.
func hmacEqual(a, b []byte) bool { return subtle.ConstantTimeCompare(a, b) == 1 }

func alertEngineering(ctx context.Context, msg, paymentID string, err error) {
	// PagerDuty/OpsGenie in production. Every caller of this function is
	// a place where money and our record of it may have diverged, which
	// is a page, not a log line someone reads on Monday.
}

// --- SQL-backed Repository (production example) ---

type SQLPaymentRepo struct {
	db *sql.DB
}

// processor_ref is NULL until authorization, so it is coalesced rather
// than scanned into a string. Scanning a NULL into a non-nullable Go
// type is a runtime error, and it fires on exactly the rows this lookup
// exists to find: the pending ones.
const paymentColumns = `id, idempotency_key, merchant_id, amount, currency, status,
	COALESCE(processor_ref, ''), request_hash, COALESCE(customer_email, ''),
	refunded_amount, created_at, updated_at`

func scanPayment(row interface{ Scan(...any) error }) (*Payment, error) {
	p := &Payment{}
	err := row.Scan(&p.ID, &p.IdempotencyKey, &p.MerchantID, &p.Amount, &p.Currency,
		&p.Status, &p.ProcessorRef, &p.RequestHash, &p.CustomerEmail,
		&p.RefundedAmount, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (r *SQLPaymentRepo) GetByIdempotencyKey(ctx context.Context, merchantID, key string) (*Payment, error) {
	p, err := scanPayment(r.db.QueryRowContext(ctx,
		"SELECT "+paymentColumns+" FROM payments WHERE merchant_id = $1 AND idempotency_key = $2",
		merchantID, key))
	if errors.Is(err, sql.ErrNoRows) {
		// Not found is not an error: it is the normal answer for a new
		// payment. Any other error is real and must reach the caller,
		// which is why this returns (nil, nil) only for ErrNoRows.
		return nil, nil
	}
	return p, err
}

func (r *SQLPaymentRepo) Create(ctx context.Context, p *Payment) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO payments (id, idempotency_key, merchant_id, amount, currency, status,
			request_hash, customer_email, description, metadata, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		p.ID, p.IdempotencyKey, p.MerchantID, p.Amount, p.Currency, p.Status,
		p.RequestHash, p.CustomerEmail, p.Description, p.Metadata, p.CreatedAt, p.UpdatedAt,
	)
	if isUniqueViolation(err) {
		// Translate at the boundary. The service layer must be able to
		// recognize "someone else already created this payment" without
		// knowing what a PostgreSQL SQLSTATE is.
		return ErrDuplicateKey
	}
	return err
}

// isUniqueViolation reports whether err is a PostgreSQL unique constraint
// violation (SQLSTATE 23505).
func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	return errors.As(err, &pgErr) && pgErr.SQLState() == "23505"
}

// ReserveRefund does the whole refund-budget check in one statement. The
// arithmetic lives in the WHERE clause so the row's current value decides,
// not a value some goroutine read a moment ago. Zero rows updated means
// the budget is exhausted or the status moved on.
func (r *SQLPaymentRepo) ReserveRefund(ctx context.Context, id string, amount int64) (*Payment, error) {
	p, err := scanPayment(r.db.QueryRowContext(ctx, `
		UPDATE payments
		SET refunded_amount = refunded_amount + $2,
		    status = CASE WHEN refunded_amount + $2 = amount
		                  THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
		    updated_at = NOW()
		WHERE id = $1
		  AND status IN ('CAPTURED', 'SETTLED', 'PARTIALLY_REFUNDED')
		  AND refunded_amount + $2 <= amount
		RETURNING `+paymentColumns, id, amount))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("refund of %d not permitted for payment %s", amount, id)
	}
	return p, err
}

func (r *SQLPaymentRepo) ReleaseRefund(ctx context.Context, id string, amount int64) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE payments
		SET refunded_amount = refunded_amount - $2,
		    status = CASE WHEN refunded_amount - $2 = 0
		                  THEN 'CAPTURED' ELSE 'PARTIALLY_REFUNDED' END,
		    updated_at = NOW()
		WHERE id = $1 AND refunded_amount >= $2`, id, amount)
	return err
}

func (r *SQLPaymentRepo) SetAuthorized(ctx context.Context, id, processorRef string) error {
	result, err := r.db.ExecContext(ctx,
		`UPDATE payments SET status = $1, processor_ref = $2, updated_at = NOW()
		 WHERE id = $3 AND status = $4`,
		StatusAuthorized, processorRef, id, StatusPending)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("payment %s no longer pending", id)
	}
	return nil
}

func (r *SQLPaymentRepo) UpdateStatus(ctx context.Context, id string, from, to PaymentStatus) error {
	result, err := r.db.ExecContext(ctx,
		"UPDATE payments SET status = $1, updated_at = NOW() WHERE id = $2 AND status = $3",
		to, id, from,
	)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return fmt.Errorf("concurrent status change detected for payment %s", id)
	}
	return nil
}

func (r *SQLPaymentRepo) GetByID(ctx context.Context, id string) (*Payment, error) {
	return scanPayment(r.db.QueryRowContext(ctx,
		"SELECT "+paymentColumns+" FROM payments WHERE id = $1", id))
}
```

The schema this repository expects is the same shape as the core `transactions` table, with the constraints that make the Go code above correct rather than merely hopeful:

```sql
CREATE TABLE payments (
    id              VARCHAR(40) PRIMARY KEY,   -- PAY- + 32 hex, deterministic
    idempotency_key VARCHAR(255) NOT NULL,
    merchant_id     VARCHAR(36) NOT NULL,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    currency        VARCHAR(3) NOT NULL,
    status          VARCHAR(30) NOT NULL,
    request_hash    BYTEA NOT NULL,
    refunded_amount BIGINT NOT NULL DEFAULT 0,
    processor_ref   VARCHAR(100),
    customer_email  VARCHAR(255),
    description     TEXT,
    metadata        JSONB,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    -- This line is the exactly-once guarantee. Everything in the service
    -- layer is an optimization that makes hitting it rare.
    UNIQUE (merchant_id, idempotency_key),
    -- And this one makes it arithmetically impossible to refund more than
    -- was charged, no matter what the application believes.
    CONSTRAINT chk_refund_bounds CHECK (refunded_amount BETWEEN 0 AND amount)
);
```

Worth restating, because it is the lesson of the whole file: every guarantee in this service is enforced by a constraint or a conditional `UPDATE` in the database, and nothing important is enforced by an `if` statement in Go. The Go checks are there to produce good error messages and to avoid pointless round trips. They cannot be the guarantee, because between the moment Go reads a value and the moment it acts on it, twenty other instances have had the opportunity to act too. Push the invariant down to the one place all of them agree on.

---
