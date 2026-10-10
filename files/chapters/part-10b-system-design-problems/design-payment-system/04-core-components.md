## Core Components

### 1. Payment Service

The Payment Service is the central orchestrator of the entire payment flow. When a merchant submits a payment request, this service coordinates every step: validating the input, checking for duplicate requests via idempotency keys, running fraud detection, charging the card through an external processor, and recording the result in the ledger. Think of it as the "conductor" that tells each specialized component when to act. The code below defines the core types and the `ProcessPayment` method that ties everything together.

Read the ordering carefully, because in a payment flow the order of the steps is the design. The idempotency lock is taken before the cache is read, or two retries both miss and both charge. The transaction row is written before the charge, not after, so a crash mid-charge leaves evidence for reconciliation instead of a silent hole. Fraud scoring gates the charge instead of running alongside it. And every failure resolves toward refusing the payment rather than toward charging it, because a merchant can always retry a refused charge, while a customer charged twice needs a human.

```go
package payment

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// PaymentService orchestrates the full payment flow
type PaymentService struct {
	ledger        Ledger
	cardProcessor CardProcessor
	fraudEngine   FraudScorer
	idempotency   *IdempotencyStore
	txnRepo       TransactionRepository
	notifier      NotificationService
}

// The collaborators the flow depends on. They are interfaces so the
// payment flow can be tested against a processor that returns a timeout
// on demand, which is the case that matters and the one you cannot
// provoke reliably against a real sandbox. The concrete Ledger and
// FraudScorer implementations are the LedgerService and FraudEngine in
// sections 3 and 4.
type (
	Ledger interface {
		Record(ctx context.Context, entry LedgerEntry) error
	}

	FraudScorer interface {
		Evaluate(ctx context.Context, signals FraudSignals) (*FraudResult, error)
		RecordDecline(ctx context.Context, fingerprint string)
	}

	CardProcessor interface {
		Charge(ctx context.Context, req ChargeRequest) (*ChargeResult, error)
		Refund(ctx context.Context, chargeRef string, amount int64, refundID string) (*ProcessorRefund, error)
	}

	TransactionRepository interface {
		Create(ctx context.Context, txn *Transaction) error
		Update(ctx context.Context, txn *Transaction) error
		GetByID(ctx context.Context, id string) (*Transaction, error)
		GetByIdempotencyKey(ctx context.Context, key string) (*Transaction, error)
		// ReserveRefund atomically adds amount to refunded_amount if it
		// still fits within the original charge, returning the updated
		// row. It is the conditional UPDATE in Refund below.
		ReserveRefund(ctx context.Context, txnID string, amount int64) (*Transaction, error)
		ReleaseRefund(ctx context.Context, txnID string, amount int64) error
	}

	NotificationService interface {
		PaymentSucceeded(ctx context.Context, txn *Transaction, email string)
	}
)

// ChargeRequest is what we send the processor. IdempotencyKey is ours,
// not the merchant's: it scopes retry-safety to this one charge attempt.
type ChargeRequest struct {
	TokenID        string
	Amount         int64 // minor units
	Currency       string
	Desc           string
	IdempotencyKey string
}

type ChargeResult struct {
	ChargeID string
	Status   string
}

type ProcessorRefund struct {
	RefundID string
	Status   string
}

// PaymentRequest is the input from a merchant
type PaymentRequest struct {
	IdempotencyKey string            `json:"idempotency_key"` // merchant-provided
	MerchantID     string            `json:"merchant_id"`
	Amount         int64             `json:"amount"`   // in smallest currency unit (cents)
	Currency       string            `json:"currency"` // ISO 4217
	PaymentMethod  PaymentMethod     `json:"payment_method"`
	Customer       CustomerInfo      `json:"customer"`
	Description    string            `json:"description"`
	Metadata       map[string]string `json:"metadata"`
}

// PaymentMethod contains tokenized payment details.
//
// Fingerprint is the processor's stable per-card identifier: the same
// card yields the same value across customers and tokens. Stripe returns
// it as `fingerprint` on the Card object, and Adyen exposes the same idea
// as a card alias. It is what fraud rules and velocity counters must key
// on. Last4 is for display only: keying on it would lump roughly one in
// ten thousand of the world's cards into the same bucket, so a blocklist
// entry would block strangers and a velocity counter would count
// strangers' transactions.
//
// If you must derive this yourself rather than take the processor's, it
// is an HMAC of the PAN under a key in a KMS or HSM, never a bare SHA of
// the PAN: the card number space is small enough to enumerate, so an
// unkeyed digest is reversible by brute force.
type PaymentMethod struct {
	Type        string `json:"type"`     // "card", "bank_transfer", "wallet"
	TokenID     string `json:"token_id"` // Stripe-style token (never raw card data)
	Fingerprint string `json:"fingerprint"`
	CardLast4   string `json:"card_last4"`
	CardBrand   string `json:"card_brand"`
	ExpiryMonth int    `json:"expiry_month"`
	ExpiryYear  int    `json:"expiry_year"`
}

// CustomerInfo contains buyer information
type CustomerInfo struct {
	ID      string `json:"id"`
	Email   string `json:"email"`
	IP      string `json:"ip"`
	Country string `json:"country"`
}

// Transaction is the persisted payment record
type Transaction struct {
	ID             string `json:"id"`
	IdempotencyKey string `json:"idempotency_key"`
	MerchantID     string `json:"merchant_id"`
	Amount         int64  `json:"amount"`
	Currency       string `json:"currency"`
	// pending, authorized, captured, failed, blocked,
	// partially_refunded, refunded
	Status string `json:"status"`
	// RefundedAmount is the running total already refunded, in minor
	// units. Refunds check against this rather than against Amount, so
	// two partial refunds cannot together exceed the original charge.
	RefundedAmount int64     `json:"refunded_amount"`
	FraudScore     float64   `json:"fraud_score"`
	ProcessorRef   string    `json:"processor_ref"` // external charge ID
	FailureCode    string    `json:"failure_code,omitempty"`
	FailureMsg     string    `json:"failure_message,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// ProcessPayment is the main entry point.
//
// Every step that can fail must fail closed. A payment path that charges
// the card when it is unsure whether it already charged the card is worse
// than one that refuses the request and lets the merchant retry.
func (s *PaymentService) ProcessPayment(ctx context.Context, req PaymentRequest) (*Transaction, error) {
	// 1. Validate before touching Redis or the database
	if err := validatePaymentRequest(req); err != nil {
		return nil, fmt.Errorf("validation: %w", err)
	}

	// 2. Serialize concurrent retries of the same key. Without this lock
	// two simultaneous retries both miss the idempotency cache and both
	// charge the card. Redis is the gate, but the UNIQUE constraint on
	// transactions.idempotency_key in step 4 is the real guarantee: a
	// lock that can expire is not a correctness argument on its own.
	locked, release, err := s.idempotency.AcquireLock(ctx, req.IdempotencyKey)
	if err != nil {
		return nil, fmt.Errorf("idempotency lock: %w", err)
	}
	if !locked {
		return nil, ErrRequestInFlight
	}
	defer release()

	// 3. Idempotency check, now that we hold the lock. A cache miss is
	// redis.Nil. Any other error means we cannot tell whether this key
	// was already charged, so we refuse rather than risk a double charge.
	existing, err := s.idempotency.Get(ctx, req.IdempotencyKey)
	switch {
	case err == nil:
		return existing, nil
	case errors.Is(err, redis.Nil):
		// genuinely new request, fall through
	default:
		return nil, fmt.Errorf("idempotency lookup: %w", err)
	}

	// 4. Create transaction record (status=pending) before charging.
	// This is the write-ahead record: if the process dies mid-charge,
	// reconciliation finds the pending row and asks the processor what
	// actually happened. The UNIQUE index on idempotency_key means a
	// duplicate that slipped past the lock loses here instead of at the
	// card network.
	txn := &Transaction{
		ID:             uuid.New().String(),
		IdempotencyKey: req.IdempotencyKey,
		MerchantID:     req.MerchantID,
		Amount:         req.Amount,
		Currency:       req.Currency,
		Status:         "pending",
		CreatedAt:      time.Now(),
		UpdatedAt:      time.Now(),
	}

	if err := s.txnRepo.Create(ctx, txn); err != nil {
		if errors.Is(err, ErrDuplicateIdempotencyKey) {
			return s.txnRepo.GetByIdempotencyKey(ctx, req.IdempotencyKey)
		}
		return nil, fmt.Errorf("create transaction: %w", err)
	}

	// 5. Fraud detection. This blocks the charge rather than running
	// beside it: a score that arrives after the card is charged is a
	// report, not a control.
	fraudCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()

	fraudResult, err := s.fraudEngine.Evaluate(fraudCtx, FraudSignals{
		MerchantID:      req.MerchantID,
		Amount:          req.Amount,
		Currency:        req.Currency,
		CustomerIP:      req.Customer.IP,
		Country:         req.Customer.Country,
		CardFingerprint: req.PaymentMethod.Fingerprint,
		CardBrand:       req.PaymentMethod.CardBrand,
	})
	if err != nil {
		// The scorer is down or too slow. Fail closed: an unscored
		// charge is an unpriced risk, and the merchant can retry.
		txn.Status = "failed"
		txn.FailureCode = "fraud_unavailable"
		txn.FailureMsg = "Fraud scoring unavailable"
		s.finalize(ctx, req.IdempotencyKey, txn)
		return txn, fmt.Errorf("fraud evaluation: %w", err)
	}
	if fraudResult.Score > 0.85 {
		txn.Status = "blocked"
		txn.FraudScore = fraudResult.Score
		txn.FailureCode = "fraud_suspected"
		txn.FailureMsg = "Transaction blocked by fraud detection"
		s.finalize(ctx, req.IdempotencyKey, txn)
		return txn, fmt.Errorf("transaction blocked: fraud score %.2f", fraudResult.Score)
	}
	txn.FraudScore = fraudResult.Score

	// 6. Charge via payment processor. The processor gets our
	// transaction ID as its own idempotency key, so a retry of this
	// request after a network timeout returns the original charge
	// instead of creating a second one.
	chargeResult, err := s.cardProcessor.Charge(ctx, ChargeRequest{
		TokenID:        req.PaymentMethod.TokenID,
		Amount:         req.Amount,
		Currency:       req.Currency,
		Desc:           req.Description,
		IdempotencyKey: txn.ID,
	})

	if err != nil {
		txn.Status = "failed"
		txn.FailureMsg = err.Error()
		// Feed the decline back into the velocity counters. Card testing
		// is a burst of declines, so a decline the fraud engine never
		// hears about is the signal that mattered most.
		s.fraudEngine.RecordDecline(ctx, req.PaymentMethod.Fingerprint)
		s.finalize(ctx, req.IdempotencyKey, txn)
		return txn, fmt.Errorf("charge failed: %w", err)
	}

	// 7. Update transaction with success
	txn.Status = "captured"
	txn.ProcessorRef = chargeResult.ChargeID
	txn.UpdatedAt = time.Now()
	if err := s.txnRepo.Update(ctx, txn); err != nil {
		// The card was charged but our record still says pending. Do not
		// cache this as a finished result and do not report success: the
		// row stays pending so reconciliation reconciles it against the
		// processor, which is the one path that can tell the truth here.
		alertEngineering(ctx, "CRITICAL: charge succeeded but DB update failed", txn)
		return nil, fmt.Errorf("charge %s recorded at processor but not persisted: %w",
			chargeResult.ChargeID, err)
	}

	// 8. Record in ledger. The ledger is the money record, so a failure
	// here is not something to log and walk past. Record is keyed by
	// transaction ID and is safe to retry.
	if err := s.ledger.Record(ctx, LedgerEntry{
		TransactionID: txn.ID,
		MerchantID:    req.MerchantID,
		Amount:        req.Amount,
		Currency:      req.Currency,
		Type:          "payment",
		OccurredAt:    txn.CreatedAt,
	}); err != nil {
		alertEngineering(ctx, "CRITICAL: captured charge missing from ledger", txn)
		return nil, fmt.Errorf("ledger record: %w", err)
	}

	// 9. Store idempotency result
	if err := s.idempotency.Set(ctx, req.IdempotencyKey, txn); err != nil {
		// Not fatal: the UNIQUE constraint on idempotency_key still
		// stops a retry from charging twice. The cache is the fast path,
		// not the guarantee.
		alertEngineering(ctx, "idempotency cache write failed", txn)
	}

	// 10. Send notification. context.WithoutCancel keeps the value chain
	// (trace IDs, tenant) while detaching the deadline, because ctx is
	// cancelled the moment this handler returns and would otherwise kill
	// the notification before it is sent.
	notifyCtx := context.WithoutCancel(ctx)
	go s.notifier.PaymentSucceeded(notifyCtx, txn, req.Customer.Email)

	return txn, nil
}

var (
	// ErrRequestInFlight means another copy of this idempotency key is
	// being processed right now. The merchant should retry shortly, which
	// is when the cached result will be waiting.
	ErrRequestInFlight = errors.New("request already in flight for this idempotency key")

	// ErrDuplicateIdempotencyKey is what the repository returns when the
	// UNIQUE index on transactions.idempotency_key rejects an insert.
	ErrDuplicateIdempotencyKey = errors.New("duplicate idempotency key")
)

// finalize records a terminal outcome and caches it under the idempotency
// key so a retry replays the same answer instead of re-running the flow.
func (s *PaymentService) finalize(ctx context.Context, key string, txn *Transaction) {
	txn.UpdatedAt = time.Now()
	if err := s.txnRepo.Update(ctx, txn); err != nil {
		alertEngineering(ctx, "failed to persist terminal transaction state", txn)
		return
	}
	if err := s.idempotency.Set(ctx, key, txn); err != nil {
		alertEngineering(ctx, "idempotency cache write failed", txn)
	}
}

// Refund processes a refund for a captured transaction.
//
// The dangerous shape here is read-check-write: read the transaction, see
// that the requested amount fits, then refund. Two concurrent refunds of
// $60 against a $100 charge both read refunded_amount = 0, both decide
// they fit, and together they return $120. The check therefore lives in
// the database, as a conditional UPDATE whose WHERE clause re-tests the
// budget at write time. Only the request that actually moves the row is
// allowed to call the processor.
func (s *PaymentService) Refund(ctx context.Context, txnID, reason string, amount int64) (*Refund, error) {
	if amount <= 0 {
		return nil, fmt.Errorf("refund amount must be positive")
	}

	// Reserve the amount atomically. ReserveRefund runs:
	//
	//   UPDATE transactions
	//      SET refunded_amount = refunded_amount + $2,
	//          status = CASE WHEN refunded_amount + $2 = amount
	//                        THEN 'refunded' ELSE 'partially_refunded' END,
	//          updated_at = NOW()
	//    WHERE id = $1
	//      AND status IN ('captured', 'partially_refunded')
	//      AND refunded_amount + $2 <= amount
	//  RETURNING * - 	//
	// The arithmetic is in the WHERE clause, so the row's own current
	// value decides, not a value some goroutine read a moment ago. Zero
	// rows updated means the budget is gone or the status moved on.
	txn, err := s.txnRepo.ReserveRefund(ctx, txnID, amount)
	if err != nil {
		return nil, fmt.Errorf("reserve refund: %w", err)
	}

	refundID := uuid.New().String()

	// Refund via processor, keyed by our refund ID so a retry after a
	// timeout returns the original refund rather than issuing a second.
	processorRefund, err := s.cardProcessor.Refund(ctx, txn.ProcessorRef, amount, refundID)
	if err != nil {
		// The reservation is now money we promised but did not return.
		// Release it so the merchant can retry, and accept that a
		// processor timeout may leave this ambiguous: reconciliation
		// against the processor's refund list is what settles it.
		if relErr := s.txnRepo.ReleaseRefund(ctx, txnID, amount); relErr != nil {
			alertEngineering(ctx, "CRITICAL: refund reservation stuck after processor failure", txn)
		}
		return nil, fmt.Errorf("processor refund failed: %w", err)
	}

	refund := &Refund{
		ID:            refundID,
		TransactionID: txnID,
		Amount:        amount,
		Reason:        reason,
		ProcessorRef:  processorRefund.RefundID,
		Status:        "succeeded",
		CreatedAt:     time.Now(),
	}

	// Record in ledger: credit the customer back, debit the merchant.
	if err := s.ledger.Record(ctx, LedgerEntry{
		TransactionID: refund.ID,
		MerchantID:    txn.MerchantID,
		Amount:        -amount, // negative = debit the merchant
		Currency:      txn.Currency,
		Type:          "refund",
		RelatedID:     txnID,
		OccurredAt:    refund.CreatedAt,
	}); err != nil {
		alertEngineering(ctx, "CRITICAL: refund issued but missing from ledger", txn)
		return nil, fmt.Errorf("ledger record: %w", err)
	}

	return refund, nil
}

type Refund struct {
	ID            string    `json:"id"`
	TransactionID string    `json:"transaction_id"`
	Amount        int64     `json:"amount"`
	Reason        string    `json:"reason"`
	ProcessorRef  string    `json:"processor_ref"`
	Status        string    `json:"status"`
	CreatedAt     time.Time `json:"created_at"`
}

func validatePaymentRequest(req PaymentRequest) error {
	if req.Amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}
	if len(req.Currency) != 3 {
		return fmt.Errorf("invalid currency code")
	}
	if req.IdempotencyKey == "" {
		return fmt.Errorf("idempotency_key is required")
	}
	if req.PaymentMethod.TokenID == "" {
		return fmt.Errorf("payment_method.token_id is required")
	}
	return nil
}

func alertEngineering(ctx context.Context, msg string, txn *Transaction) {
	// PagerDuty/OpsGenie alert in production
}
```

### 2. Idempotency Store

Idempotency is what prevents a customer from being charged twice if a network timeout causes the merchant to retry a request. The Idempotency Store uses Redis to cache the result of every processed payment, keyed by a unique string the merchant provides. When a duplicate request arrives, the store returns the cached result instead of re-running the entire payment flow. It also provides a distributed lock, which `ProcessPayment` takes before the cache lookup so that two concurrent retries of the same key cannot both miss the cache and both charge the card.

Be clear about what the Redis layer is and is not. It is a fast path and a way to collapse concurrent retries. It is not the correctness guarantee, because a lock with a TTL can expire while its holder is still working and a cache can be evicted or lost with the node. The guarantee is the `UNIQUE` constraint on `transactions.idempotency_key`: whatever races past Redis still loses at the database. Design the Redis layer to be helpful and the database constraint to be right. Note also that this cache stores the result for a key without recording what the key was for. A complete implementation also fingerprints the request body and rejects a key that is reused with different parameters, which is what Stripe does when it returns a `400` for a reused idempotency key whose payload changed. Silently returning the first charge's result for a second, different charge is a quiet way to lose a payment.

```go
package payment

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// IdempotencyStore ensures exactly-once processing
type IdempotencyStore struct {
	rdb *redis.Client
}

// Get retrieves a cached transaction result for an idempotency key
func (s *IdempotencyStore) Get(ctx context.Context, key string) (*Transaction, error) {
	data, err := s.rdb.Get(ctx, idempotencyKey(key)).Bytes()
	if err != nil {
		return nil, err
	}
	var txn Transaction
	if err := json.Unmarshal(data, &txn); err != nil {
		return nil, err
	}
	return &txn, nil
}

// Set stores a transaction result with TTL
func (s *IdempotencyStore) Set(ctx context.Context, key string, txn *Transaction) error {
	data, err := json.Marshal(txn)
	if err != nil {
		return err
	}
	return s.rdb.Set(ctx, idempotencyKey(key), data, 24*time.Hour).Err()
}

// releaseScript deletes the lock only if we still hold it. A plain DEL is
// a bug waiting for a slow request: if our 30-second TTL expires while we
// are still working, another request acquires the lock, and our DEL then
// unlocks it out from under them. Comparing the token first means we can
// only ever delete our own lock.
var releaseScript = redis.NewScript(`
	if redis.call("GET", KEYS[1]) == ARGV[1] then
		return redis.call("DEL", KEYS[1])
	end
	return 0
`)

// AcquireLock prevents concurrent processing of the same key.
// Returns false if another request is already processing this key.
func (s *IdempotencyStore) AcquireLock(ctx context.Context, key string) (bool, func(), error) {
	lockKey := fmt.Sprintf("idempotency:lock:%s", key)
	token := uuid.New().String()

	ok, err := s.rdb.SetNX(ctx, lockKey, token, 30*time.Second).Result()
	if err != nil {
		return false, nil, err
	}
	if !ok {
		return false, nil, nil // another request holds the lock
	}
	release := func() {
		// Detach from ctx: the release must run even when the request
		// was cancelled, otherwise the key stays locked until the TTL.
		releaseScript.Run(context.WithoutCancel(ctx), s.rdb, []string{lockKey}, token)
	}
	return true, release, nil
}

func idempotencyKey(key string) string {
	return fmt.Sprintf("idempotency:%s", key)
}
```

### 3. Ledger Service

The Ledger Service implements double-entry bookkeeping, the same accounting principle that banks have used for centuries. Every payment creates exactly two journal entries: a debit from the customer and a credit to the merchant. Because the two entries always sum to zero, you can detect data corruption or missing transactions simply by checking that all accounts balance. This service also maintains a materialized running balance per merchant so that balance lookups are fast, while the immutable journal entries serve as a complete audit trail.

```go
package ledger

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LedgerService implements double-entry bookkeeping
// Every payment creates two journal entries: debit customer, credit merchant
type LedgerService struct {
	db *pgxpool.Pool
}

// LedgerEntry is a single journal entry
type LedgerEntry struct {
	TransactionID string
	MerchantID    string
	Amount        int64  // positive = credit, negative = debit
	Currency      string
	Type          string // payment, refund, fee, payout
	RelatedID     string // for refunds: original txn ID
	// OccurredAt is the business timestamp of the event being posted,
	// taken from the transaction, not the clock at insert time. It is the
	// posting date, and keeping it deterministic is what lets a retry of
	// Record collide with the first attempt instead of posting again.
	OccurredAt time.Time
}

// Record adds both halves of the double entry, plus the balance update,
// in one database transaction. All three or none: a committed debit
// without its matching credit is precisely the corruption the ledger
// exists to make impossible.
//
// Record is safe to retry. ProcessPayment calls it after the card has
// already been charged, so "retry until it succeeds" is the only sane
// error policy, and that policy is only sane if a retry cannot post the
// entries twice. The UNIQUE constraint on (transaction_id, account_type)
// makes the second attempt a no-op rather than a duplicate credit.
func (s *LedgerService) Record(ctx context.Context, entry LedgerEntry) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// The posting timestamp comes from the event, not from time.Now, so
	// that a retry writes byte-identical rows and hits the constraint.
	posted := entry.OccurredAt

	// Debit customer account
	tag, err := tx.Exec(ctx, `
		INSERT INTO ledger_entries (id, account_id, account_type, transaction_id,
			amount, currency, type, related_id, created_at)
		VALUES (gen_random_uuid(), $1, 'customer', $2, $3, $4, $5, $6, $7)
		ON CONFLICT (transaction_id, account_type, created_at) DO NOTHING`,
		customerAccountID(entry.TransactionID),
		entry.TransactionID, -entry.Amount, entry.Currency, entry.Type,
		entry.RelatedID, posted,
	)
	if err != nil {
		return fmt.Errorf("debit entry: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already recorded by an earlier attempt. The balance was moved
		// in that same committed transaction, so applying it again here
		// would credit the merchant twice for one payment.
		return nil
	}

	// Credit merchant account
	_, err = tx.Exec(ctx, `
		INSERT INTO ledger_entries (id, account_id, account_type, transaction_id,
			amount, currency, type, related_id, created_at)
		VALUES (gen_random_uuid(), $1, 'merchant', $2, $3, $4, $5, $6, $7)`,
		entry.MerchantID,
		entry.TransactionID, entry.Amount, entry.Currency, entry.Type,
		entry.RelatedID, posted,
	)
	if err != nil {
		return fmt.Errorf("credit entry: %w", err)
	}

	// Update merchant balance
	_, err = tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, currency, available, pending, updated_at)
		VALUES ($1, $2, 0, $3, NOW())
		ON CONFLICT (merchant_id, currency) DO UPDATE
		SET pending = merchant_balances.pending + $3, updated_at = NOW()`,
		entry.MerchantID, entry.Currency, entry.Amount,
	)
	if err != nil {
		return fmt.Errorf("update balance: %w", err)
	}

	return tx.Commit(ctx)
}

// GetMerchantBalance returns current balance for a merchant
func (s *LedgerService) GetMerchantBalance(ctx context.Context, merchantID, currency string) (int64, error) {
	var available, pending int64
	err := s.db.QueryRow(ctx,
		"SELECT available, pending FROM merchant_balances WHERE merchant_id = $1 AND currency = $2",
		merchantID, currency,
	).Scan(&available, &pending)
	if err != nil {
		return 0, err
	}
	return available + pending, nil
}

// DayTotals sums the day's merchant-side ledger movement per currency.
// This is one half of reconciliation: the settlement pipeline compares
// these totals against the acquirer's statement and investigates any
// currency where the two disagree. Producing the number is the easy half.
func (s *LedgerService) DayTotals(ctx context.Context, date time.Time) (*ReconciliationReport, error) {
	rows, err := s.db.Query(ctx, `
		SELECT currency, SUM(amount) as total, COUNT(*) as count
		FROM ledger_entries
		WHERE created_at >= $1 AND created_at < $2
		  AND account_type = 'merchant'
		GROUP BY currency`,
		date, date.Add(24*time.Hour),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	report := &ReconciliationReport{Date: date, Entries: make(map[string]ReconciliationEntry)}
	for rows.Next() {
		var currency string
		var total int64
		var count int
		// A dropped scan error here would silently report a currency's
		// total as zero, and a zero that should be a million looks
		// exactly like a balanced day.
		if err := rows.Scan(&currency, &total, &count); err != nil {
			return nil, fmt.Errorf("scan day totals: %w", err)
		}
		report.Entries[currency] = ReconciliationEntry{Total: total, Count: count}
	}
	// rows.Err reports a mid-iteration failure. Without it a connection
	// that dies halfway through returns a short report that reads as a
	// complete one.
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate day totals: %w", err)
	}
	return report, nil
}

type ReconciliationReport struct {
	Date    time.Time
	Entries map[string]ReconciliationEntry
}

type ReconciliationEntry struct {
	Total int64
	Count int
}

func customerAccountID(txnID string) string {
	return "customer:" + txnID
}
```

### 4. Fraud Detection

The Fraud Engine is responsible for deciding whether a transaction looks legitimate before the system charges the card. It uses a two-layer approach: first, cheap deterministic rules (blocked countries, IP blocklists, amount limits) that give instant verdicts, then, for transactions that pass the hard rules, a machine-learning model that scores risk based on velocity features like how many transactions this card has made in the last hour. The entire evaluation must complete in under 100 milliseconds to avoid slowing down the payment flow.

Two details in this code are where fraud engines usually go wrong. The first is what identifies a card. Every counter and blocklist here keys on the processor's card fingerprint, never on the last four digits, because roughly one card in ten thousand shares any given last4: a blocklist keyed on last4 blocks strangers, and a velocity counter keyed on last4 counts strangers' transactions as this card's. The second is that every feature the model reads has a writer. It is easy to ship an `extractVelocityFeatures` that queries a decline counter nothing ever increments, and the failure is silent, because the model does not error, it just reads a permanent zero and concludes this card has never been declined.

```go
package fraud

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

// MLModel scores a transaction from its velocity features.
// In production this is an RPC to a model server, not an in-process call.
type MLModel interface {
	Predict(features VelocityFeatures) float64
}

// FraudEngine evaluates transaction risk
type FraudEngine struct {
	rdb     *redis.Client
	mlModel MLModel // gradient boosted tree model
}

// FraudSignals are features fed into the fraud model.
// CardFingerprint, not last4, identifies the card: see PaymentMethod.
type FraudSignals struct {
	MerchantID      string
	Amount          int64
	Currency        string
	CustomerIP      string
	Country         string
	CardFingerprint string
	CardBrand       string
}

// FraudResult contains the risk assessment
type FraudResult struct {
	Score         float64  // 0.0 (safe) to 1.0 (fraudulent)
	Reasons       []string // human-readable risk factors
	RuleTriggered string   // if a hard rule was triggered
}

// Evaluate computes fraud score for a transaction
func (e *FraudEngine) Evaluate(ctx context.Context, signals FraudSignals) (*FraudResult, error) {
	result := &FraudResult{}

	// 1. Hard rules (instant decisions)
	if rule := e.checkHardRules(ctx, signals); rule != "" {
		result.Score = 1.0
		result.RuleTriggered = rule
		return result, nil
	}

	// 2. Velocity checks (rate limiting based fraud signals)
	features := e.extractVelocityFeatures(ctx, signals)

	// 3. ML model scoring
	result.Score = e.mlModel.Predict(features)

	// 4. Record velocity counters
	e.recordVelocity(ctx, signals)

	return result, nil
}

// checkHardRules applies deterministic fraud rules
func (e *FraudEngine) checkHardRules(ctx context.Context, signals FraudSignals) string {
	// Blocked countries
	blockedCountries := map[string]bool{"KP": true, "IR": true}
	if blockedCountries[signals.Country] {
		return "blocked_country"
	}

	// Amount limits
	if signals.Amount > 100_000_00 { // > $100,000
		return "amount_too_large"
	}

	// IP in blocklist
	blocked, _ := e.rdb.SIsMember(ctx, "fraud:blocked_ips", signals.CustomerIP).Result()
	if blocked {
		return "blocked_ip"
	}

	// Card in blocklist, by fingerprint. Blocking by last4 would block
	// every card ending in those four digits.
	blocked, _ = e.rdb.SIsMember(ctx, "fraud:blocked_cards", signals.CardFingerprint).Result()
	if blocked {
		return "blocked_card"
	}

	return ""
}

// VelocityFeatures are computed from recent transaction history
type VelocityFeatures struct {
	TxnsLast1h       int
	TxnsLast24h      int
	AmountLast1h     int64
	UniqueIPsLast24h int
	DeclinedLast1h   int
	AmountZScore     float64 // how unusual is this amount
}

// Velocity state lives under four keys per card. Every key that
// extractVelocityFeatures reads must be one that recordVelocity or
// RecordDecline writes: a feature nobody populates is not a neutral
// feature, it is a constant zero, and a model trained on real data will
// read that constant as "this card has never been declined".
func cardVelocityKeys(fingerprint string) (txns, amounts, declines, ips string) {
	base := "vel:card:" + fingerprint
	return base, base + ":amounts", base + ":declines", base + ":ips"
}

// extractVelocityFeatures computes sliding-window velocity features
func (e *FraudEngine) extractVelocityFeatures(ctx context.Context, signals FraudSignals) VelocityFeatures {
	now := time.Now().Unix()
	txnsKey, amountsKey, declinesKey, ipsKey := cardVelocityKeys(signals.CardFingerprint)

	// Transaction count in last hour (using Redis sorted set, score=timestamp)
	hourAgo := fmt.Sprintf("%d", now-3600)
	dayAgo := fmt.Sprintf("%d", now-86400)
	txns1h, _ := e.rdb.ZCount(ctx, txnsKey, hourAgo, "+inf").Result()
	txns24h, _ := e.rdb.ZCount(ctx, txnsKey, dayAgo, "+inf").Result()

	// Amount velocity. Members are "<amount>:<nanos>", the amount being
	// the part we want and the nanos only there to keep two identical
	// amounts in the same second from collapsing into one set member.
	members1h, _ := e.rdb.ZRangeByScore(ctx, amountsKey,
		&redis.ZRangeBy{Min: hourAgo, Max: "+inf"}).Result()
	var amountLast1h int64
	for _, m := range members1h {
		var a int64
		if _, err := fmt.Sscanf(m, "%d:", &a); err != nil {
			continue
		}
		amountLast1h += a
	}

	// Declined transactions
	declined1h, _ := e.rdb.ZCount(ctx, declinesKey, hourAgo, "+inf").Result()

	// Distinct IPs this card has been used from in the last day. One card
	// across many IPs in an hour is a strong card-testing signal.
	e.rdb.ZRemRangeByScore(ctx, ipsKey, "0", dayAgo)
	uniqueIPs, _ := e.rdb.ZCard(ctx, ipsKey).Result()

	// Amount z-score against card's historical avg
	avgAmount := e.getAvgAmount(ctx, signals.CardFingerprint)
	stdAmount := e.getStdAmount(ctx, signals.CardFingerprint)
	zScore := 0.0
	if stdAmount > 0 {
		zScore = math.Abs(float64(signals.Amount)-avgAmount) / stdAmount
	}

	return VelocityFeatures{
		TxnsLast1h:       int(txns1h),
		TxnsLast24h:      int(txns24h),
		AmountLast1h:     amountLast1h,
		UniqueIPsLast24h: int(uniqueIPs),
		DeclinedLast1h:   int(declined1h),
		AmountZScore:     zScore,
	}
}

// recordVelocity updates sliding-window counters
func (e *FraudEngine) recordVelocity(ctx context.Context, signals FraudSignals) {
	now := time.Now()
	sec := now.Unix()
	txnsKey, amountsKey, _, ipsKey := cardVelocityKeys(signals.CardFingerprint)

	pipe := e.rdb.Pipeline()

	// Score is the timestamp, so range queries are window queries. In v9
	// ZAdd takes redis.Z values, not pointers.
	member := fmt.Sprintf("%d:%d", signals.Amount, now.UnixNano())
	pipe.ZAdd(ctx, txnsKey, redis.Z{Score: float64(sec), Member: member})
	pipe.ZAdd(ctx, amountsKey, redis.Z{Score: float64(sec), Member: member})
	pipe.ZAdd(ctx, ipsKey, redis.Z{Score: float64(sec), Member: signals.CustomerIP})

	// Trim to the 24h window, then let the TTL reap a card that stops
	// transacting entirely.
	cutoff := fmt.Sprintf("%d", sec-86400)
	for _, k := range []string{txnsKey, amountsKey, ipsKey} {
		pipe.ZRemRangeByScore(ctx, k, "0", cutoff)
		pipe.Expire(ctx, k, 24*time.Hour)
	}

	pipe.Exec(ctx)
}

// RecordDecline is called by the payment flow when a charge is declined,
// which is what makes DeclinedLast1h a real feature. Card testing shows up
// as a burst of declines long before it shows up as a successful charge.
func (e *FraudEngine) RecordDecline(ctx context.Context, fingerprint string) {
	now := time.Now()
	sec := now.Unix()
	_, _, declinesKey, _ := cardVelocityKeys(fingerprint)

	pipe := e.rdb.Pipeline()
	pipe.ZAdd(ctx, declinesKey, redis.Z{
		Score:  float64(sec),
		Member: fmt.Sprintf("%d", now.UnixNano()),
	})
	pipe.ZRemRangeByScore(ctx, declinesKey, "0", fmt.Sprintf("%d", sec-86400))
	pipe.Expire(ctx, declinesKey, 24*time.Hour)
	pipe.Exec(ctx)
}

func (e *FraudEngine) getAvgAmount(ctx context.Context, fingerprint string) float64 {
	val, _ := e.rdb.Get(ctx, "avg_amount:"+fingerprint).Float64()
	return val
}

func (e *FraudEngine) getStdAmount(ctx context.Context, fingerprint string) float64 {
	val, _ := e.rdb.Get(ctx, "std_amount:"+fingerprint).Float64()
	return val
}
```

---
