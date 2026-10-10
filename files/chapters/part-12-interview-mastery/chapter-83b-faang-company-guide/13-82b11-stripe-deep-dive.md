## 83B.11 Stripe Deep Dive

### Overview for Go Engineers

Stripe is one of the most Go-forward companies in the industry. Their payment infrastructure processes hundreds of billions of dollars annually, and Go powers critical backend services including payment processing, fraud detection, and API gateway systems. Stripe interviews emphasize API design, idempotency, distributed transactions, and the kind of precision required when every bug can move real money. Go engineers are highly valued because Stripe's core infrastructure demands the concurrency, type safety, and operational simplicity that Go provides. Stripe's engineering culture prizes correctness over speed - a stark contrast to Meta's "move fast" philosophy. In a Stripe interview, a slower but provably correct solution will always beat a fast but potentially buggy one, because in payments, a bug that double-charges a customer or drops a transaction is a regulatory and trust catastrophe.

### Interview Process

Stripe's loop leans harder on practical coding and API design than on abstract algorithms, and the stages below reflect that:

```
┌──────────────────────────────────────────────────────────────────┐
│                   STRIPE INTERVIEW PIPELINE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Role fit, experience, motivation for Stripe           │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - 1 coding problem, heavy on API/system design          │
│       ▼                                                          │
│  Bug Squash Round (60 min)                                       │
│       │  - Debug existing codebase, find and fix real bugs       │
│       ▼                                                          │
│  Virtual Onsite (4-5 rounds, 60 min each)                        │
│       │  - 1 Integration/API Design round                        │
│       │  - 1 Coding round (algorithms + data structures)         │
│       │  - 1 System Design round                                 │
│       │  - 1 Bug Squash / Code Review round                      │
│       │  - 1 Manager/Culture round                               │
│       ▼                                                          │
│  Debrief & Decision                                              │
│       │                                                          │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 3-5 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Stripe's Bug Squash round is unique among top companies. You receive an existing codebase with intentional bugs - race conditions, off-by-one errors, incorrect error handling - and must identify and fix them within 60 minutes. This round tests real-world debugging skills rather than algorithm design, and Go engineers have an advantage because Go's explicit error handling and race detector make bugs more tractable than in languages with hidden control flow.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| L1 | Software Engineer | 0-2 | $150K-$180K | $200K-$280K | Coding + debugging fundamentals |
| L2 | Software Engineer | 2-5 | $180K-$220K | $280K-$400K | API design + integration coding |
| L3 | Senior Engineer | 5-8 | $220K-$270K | $400K-$550K | System design + distributed systems |
| L4 | Staff Engineer | 8-12 | $260K-$320K | $550K-$750K | Architecture + cross-team impact |
| L5 | Senior Staff | 12+ | $300K-$380K | $700K-$1M+ | Technical vision + org-wide systems |

### Representative Interview Problems

#### Problem 1: Idempotent Payment Processor (Easy)

*Build a payment processor that guarantees exactly-once processing using idempotency keys.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type PaymentResult struct {
	PaymentID string
	Amount    int64
	Currency  string
	Status    string
	CreatedAt time.Time
}

type IdempotentProcessor struct {
	mu      sync.Mutex
	results map[string]*PaymentResult
	nextID  int
}

func NewIdempotentProcessor() *IdempotentProcessor {
	return &IdempotentProcessor{
		results: make(map[string]*PaymentResult),
	}
}

func (p *IdempotentProcessor) Process(idempotencyKey string, amount int64, currency string) (*PaymentResult, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if existing, ok := p.results[idempotencyKey]; ok {
		return existing, nil // Return cached result - idempotent
	}

	if amount <= 0 {
		return nil, fmt.Errorf("invalid amount: %d", amount)
	}

	p.nextID++
	result := &PaymentResult{
		PaymentID: fmt.Sprintf("pay_%d", p.nextID),
		Amount:    amount,
		Currency:  currency,
		Status:    "succeeded",
		CreatedAt: time.Now(),
	}
	p.results[idempotencyKey] = result
	return result, nil
}

func main() {
	proc := NewIdempotentProcessor()

	r1, _ := proc.Process("key-abc", 5000, "usd")
	fmt.Printf("First:  %s $%.2f\n", r1.PaymentID, float64(r1.Amount)/100)

	r2, _ := proc.Process("key-abc", 5000, "usd")
	fmt.Printf("Retry:  %s (same=%v)\n", r2.PaymentID, r1.PaymentID == r2.PaymentID)

	r3, _ := proc.Process("key-xyz", 3000, "usd")
	fmt.Printf("New:    %s $%.2f\n", r3.PaymentID, float64(r3.Amount)/100)
}
```
#### Problem 2: Currency Conversion with Rounding (Easy)

*Implement a currency converter that handles decimal precision correctly using integer arithmetic (Stripe style - never use floats for money).*

```go
package main

import (
	"fmt"
	"math"
)

// Rate is stored as basis points × 10000 to avoid floats
// e.g., 1 USD = 0.85 EUR → rate = 8500 (85.00%)
type ExchangeRate struct {
	From     string
	To       string
	RateBps  int64 // basis points (1/10000)
}

// ConvertAmount converts amount in minor units (cents) from one currency to another.
// Returns minor units of target currency, rounded to nearest cent.
func ConvertAmount(amountCents int64, rate ExchangeRate) int64 {
	// amountCents * rateBps / 10000, round half-up
	raw := amountCents * rate.RateBps
	result := raw / 10000
	remainder := raw % 10000
	if remainder*2 >= 10000 {
		result++
	}
	return result
}

// FormatAmount formats minor units as decimal string for display.
func FormatAmount(amountCents int64, currency string) string {
	// For simplicity: all currencies use 2 decimal places
	return fmt.Sprintf("%s %.2f", currency, float64(amountCents)/100)
}

func main() {
	rate := ExchangeRate{From: "USD", To: "EUR", RateBps: 8500} // 1 USD = 0.85 EUR

	amounts := []int64{100, 999, 1000, 12345}
	for _, a := range amounts {
		converted := ConvertAmount(a, rate)
		fmt.Printf("%s → %s\n",
			FormatAmount(a, "USD"),
			FormatAmount(converted, "EUR"),
		)
	}

	// Verify: $9.99 → €8.49 (not €8.4915)
	result := ConvertAmount(999, rate)
	fmt.Printf("\n$9.99 → €%.2f (expected €8.49, correct=%v)\n",
		float64(result)/100, result == 849)

	_ = math.Round // available but not needed - integer arithmetic preferred
}
```

#### Problem 3: Webhook Delivery with Exponential Backoff (Easy)

*Implement a webhook delivery system with retry logic using exponential backoff and jitter.*

```go
package main

import (
	"fmt"
	"math/rand/v2"
	"time"
)

type WebhookEvent struct {
	ID      string
	URL     string
	Payload string
}

type DeliveryResult struct {
	Attempts int
	Success  bool
	Error    error
}

// deliver simulates an HTTP POST - returns error 70% of the time for demo.
func deliver(event WebhookEvent) error {
	if rand.Float64() < 0.7 {
		return fmt.Errorf("connection refused")
	}
	return nil
}

// backoffDuration returns base * 2^attempt + jitter (capped at maxDelay).
func backoffDuration(attempt int, base, maxDelay time.Duration) time.Duration {
	exp := base * (1 << min(attempt, 10))
	if exp > maxDelay {
		exp = maxDelay
	}
	jitter := time.Duration(rand.Int64N(int64(exp / 4)))
	return exp + jitter
}

func DeliverWithRetry(event WebhookEvent, maxAttempts int) DeliveryResult {
	var lastErr error
	for i := range maxAttempts {
		if i > 0 {
			d := backoffDuration(i-1, 100*time.Millisecond, 30*time.Second)
			fmt.Printf("  attempt %d: waiting %v before retry\n", i+1, d.Round(time.Millisecond))
			// time.Sleep(d) // omitted for test speed
		}
		if err := deliver(event); err != nil {
			lastErr = err
			fmt.Printf("  attempt %d: failed - %v\n", i+1, err)
			continue
		}
		fmt.Printf("  attempt %d: success\n", i+1)
		return DeliveryResult{Attempts: i + 1, Success: true}
	}
	return DeliveryResult{Attempts: maxAttempts, Success: false, Error: lastErr}
}

func main() {
	event := WebhookEvent{ID: "evt_123", URL: "https://merchant.example/webhook", Payload: `{"type":"payment.succeeded"}`}
	result := DeliverWithRetry(event, 5)
	fmt.Printf("\nResult: success=%v attempts=%d\n", result.Success, result.Attempts)
}
```

#### Problem 4: Double-Entry Ledger (Medium)

*Implement a double-entry bookkeeping ledger that ensures every debit has a matching credit - the foundation of Stripe's financial infrastructure.*

```go
package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

type Entry struct {
	AccountID string
	Amount    int64 // positive = credit, negative = debit
	Memo      string
}

type Transaction struct {
	ID        string
	Entries   []Entry
	CreatedAt time.Time
}

// Validate ensures debits == credits (sum of all entries == 0).
func (t Transaction) Validate() error {
	var sum int64
	for _, e := range t.Entries {
		sum += e.Amount
	}
	if sum != 0 {
		return fmt.Errorf("unbalanced transaction: net=%d (must be 0)", sum)
	}
	if len(t.Entries) < 2 {
		return errors.New("transaction must have at least 2 entries")
	}
	return nil
}

type Ledger struct {
	mu           sync.Mutex
	transactions []Transaction
	balances     map[string]int64
	nextTxID     int
}

func NewLedger() *Ledger {
	return &Ledger{balances: make(map[string]int64)}
}

func (l *Ledger) Post(entries []Entry, memo string) (string, error) {
	tx := Transaction{Entries: entries, CreatedAt: time.Now()}
	if err := tx.Validate(); err != nil {
		return "", fmt.Errorf("invalid transaction: %w", err)
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.nextTxID++
	tx.ID = fmt.Sprintf("txn_%06d", l.nextTxID)
	l.transactions = append(l.transactions, tx)
	for _, e := range entries {
		l.balances[e.AccountID] += e.Amount
	}
	return tx.ID, nil
}

func (l *Ledger) Balance(accountID string) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.balances[accountID]
}

func main() {
	ledger := NewLedger()

	// Customer pays $100: debit customer, credit stripe_revenue + stripe_fees
	txID, err := ledger.Post([]Entry{
		{AccountID: "customer_acct", Amount: -10000, Memo: "payment"},
		{AccountID: "merchant_payable", Amount: +9710, Memo: "merchant proceeds"},
		{AccountID: "stripe_revenue", Amount: +290, Memo: "stripe fee (2.9%)"},
	}, "payment charge")
	fmt.Printf("Posted: %s err=%v\n", txID, err)

	// Attempt invalid (unbalanced) transaction
	_, err = ledger.Post([]Entry{
		{AccountID: "customer_acct", Amount: -5000},
		{AccountID: "merchant_payable", Amount: +4000}, // only +4000, not +5000
	}, "bad charge")
	fmt.Printf("Invalid tx err: %v\n", err)

	fmt.Printf("customer_acct balance: %d cents\n", ledger.Balance("customer_acct"))
	fmt.Printf("merchant_payable balance: %d cents\n", ledger.Balance("merchant_payable"))
}
```

#### Problem 5: Stripe Radar - Fraud Score Pipeline (Medium)

*Build a fraud detection pipeline that evaluates payment requests through a chain of rules, returning a risk score.*

```go
package main

import (
	"fmt"
	"strings"
)

type PaymentRequest struct {
	Amount      int64
	Currency    string
	Country     string
	Email       string
	CardBIN     string // first 6 digits
	IPCountry   string
}

type RuleResult struct {
	Rule    string
	Score   int // 0-100 risk contribution
	Blocked bool
	Reason  string
}

type FraudRule func(PaymentRequest) RuleResult

// Rule 1: High-value transaction from high-risk country
func highValueHighRisk(r PaymentRequest) RuleResult {
	highRisk := map[string]bool{"NG": true, "RU": true, "KP": true}
	if r.Amount > 100000 && highRisk[r.Country] {
		return RuleResult{Rule: "high_value_high_risk", Score: 60, Reason: "large amount from high-risk country"}
	}
	return RuleResult{Rule: "high_value_high_risk", Score: 0}
}

// Rule 2: Card BIN country mismatch with IP country
func countryMismatch(r PaymentRequest) RuleResult {
	// BIN prefix 4111 = US card - simplistic demo
	binCountry := "US"
	if strings.HasPrefix(r.CardBIN, "4") {
		binCountry = "US"
	}
	if binCountry != r.IPCountry {
		return RuleResult{Rule: "country_mismatch", Score: 30, Reason: fmt.Sprintf("card BIN country %s ≠ IP country %s", binCountry, r.IPCountry)}
	}
	return RuleResult{Rule: "country_mismatch", Score: 0}
}

// Rule 3: Disposable email domain
func disposableEmail(r PaymentRequest) RuleResult {
	disposable := []string{"mailinator.com", "guerrillamail.com", "tempmail.com"}
	for _, d := range disposable {
		if strings.HasSuffix(r.Email, d) {
			return RuleResult{Rule: "disposable_email", Score: 40, Reason: "disposable email provider"}
		}
	}
	return RuleResult{Rule: "disposable_email", Score: 0}
}

func EvaluateFraud(req PaymentRequest, rules []FraudRule) (totalScore int, results []RuleResult) {
	for _, rule := range rules {
		result := rule(req)
		results = append(results, result)
		totalScore += result.Score
		if result.Blocked {
			break
		}
	}
	return min(totalScore, 100), results
}

func main() {
	rules := []FraudRule{highValueHighRisk, countryMismatch, disposableEmail}

	req := PaymentRequest{
		Amount:    150000, // $1500
		Country:   "RU",
		Email:     "user@mailinator.com",
		CardBIN:   "411111",
		IPCountry: "CN",
	}

	score, results := EvaluateFraud(req, rules)
	for _, r := range results {
		if r.Score > 0 {
			fmt.Printf("[%s] score+%d: %s\n", r.Rule, r.Score, r.Reason)
		}
	}
	fmt.Printf("\nFinal fraud score: %d/100 - %s\n", score, func() string {
		if score >= 75 {
			return "BLOCK"
		} else if score >= 40 {
			return "REVIEW"
		}
		return "ALLOW"
	}())
}
```

#### Problem 6: Rate Limiter for Payment APIs (Medium)

*Implement a sliding window rate limiter suitable for Stripe's API - per-key, thread-safe, with configurable limits.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type SlidingWindowLimiter struct {
	mu       sync.Mutex
	windows  map[string][]time.Time
	limit    int
	duration time.Duration
}

func NewSlidingWindowLimiter(limit int, duration time.Duration) *SlidingWindowLimiter {
	return &SlidingWindowLimiter{
		windows:  make(map[string][]time.Time),
		limit:    limit,
		duration: duration,
	}
}

// Allow returns true if the request is within the rate limit.
func (l *SlidingWindowLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-l.duration)

	// Evict expired timestamps
	ts := l.windows[key]
	lo := 0
	for lo < len(ts) && ts[lo].Before(cutoff) {
		lo++
	}
	ts = ts[lo:]

	if len(ts) >= l.limit {
		l.windows[key] = ts
		return false
	}

	l.windows[key] = append(ts, now)
	return true
}

// Remaining returns requests remaining in the current window.
func (l *SlidingWindowLimiter) Remaining(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.duration)
	count := 0
	for _, t := range l.windows[key] {
		if !t.Before(cutoff) {
			count++
		}
	}
	return max(0, l.limit-count)
}

func main() {
	limiter := NewSlidingWindowLimiter(5, time.Second)

	apiKey := "sk_live_abc123"
	for i := range 8 {
		allowed := limiter.Allow(apiKey)
		remaining := limiter.Remaining(apiKey)
		fmt.Printf("Request %d: allowed=%v remaining=%d\n", i+1, allowed, remaining)
	}
}
```

#### Problem 7: Subscription Billing Engine (Medium)

*Design a subscription billing system that handles plan upgrades with prorated charges.*

```go
package main

import (
	"fmt"
	"time"
)

type Plan struct {
	ID            string
	Name          string
	PriceCents    int64 // monthly price in cents
	BillingCycle  int   // days
}

type Subscription struct {
	ID             string
	CustomerID     string
	Plan           Plan
	CurrentPeriodStart time.Time
	CurrentPeriodEnd   time.Time
}

// ProratedCharge calculates the charge when upgrading mid-cycle.
// Returns (credit for old plan, charge for new plan, net charge).
func ProratedCharge(sub Subscription, newPlan Plan, upgradeAt time.Time) (credit, charge, net int64) {
	total := sub.CurrentPeriodEnd.Sub(sub.CurrentPeriodStart)
	remaining := sub.CurrentPeriodEnd.Sub(upgradeAt)

	if remaining <= 0 || total <= 0 {
		return 0, newPlan.PriceCents, newPlan.PriceCents
	}

	fraction := float64(remaining) / float64(total)
	credit = int64(float64(sub.Plan.PriceCents) * fraction)
	charge = int64(float64(newPlan.PriceCents) * fraction)
	net = charge - credit
	return credit, charge, net
}

func main() {
	starter := Plan{ID: "plan_starter", Name: "Starter", PriceCents: 2900}
	pro := Plan{ID: "plan_pro", Name: "Pro", PriceCents: 7900}

	periodStart := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	periodEnd := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

	sub := Subscription{
		ID:                 "sub_123",
		CustomerID:         "cus_abc",
		Plan:               starter,
		CurrentPeriodStart: periodStart,
		CurrentPeriodEnd:   periodEnd,
	}

	// Upgrade on March 16 (halfway through)
	upgradeAt := time.Date(2026, 3, 16, 0, 0, 0, 0, time.UTC)
	credit, charge, net := ProratedCharge(sub, pro, upgradeAt)

	fmt.Printf("Upgrading from %s ($%.2f/mo) to %s ($%.2f/mo)\n",
		starter.Name, float64(starter.PriceCents)/100,
		pro.Name, float64(pro.PriceCents)/100)
	fmt.Printf("Upgrade date: %s (%.0f days remaining of %d-day cycle)\n",
		upgradeAt.Format("Jan 2"), sub.CurrentPeriodEnd.Sub(upgradeAt).Hours()/24,
		int(periodEnd.Sub(periodStart).Hours()/24))
	fmt.Printf("Credit for unused Starter: $%.2f\n", float64(credit)/100)
	fmt.Printf("Charge for remaining Pro:  $%.2f\n", float64(charge)/100)
	fmt.Printf("Net charge today:          $%.2f\n", float64(net)/100)
}
```

#### Problem 8: Distributed Saga - Payment with Compensating Transactions (Hard)

*Implement the Saga pattern for a payment flow across multiple services, with automatic compensation on failure.*

```go
package main

import (
	"errors"
	"fmt"
)

type Step struct {
	Name      string
	Execute   func() error
	Compensate func() error
}

type Saga struct {
	steps     []Step
	completed []Step
}

func (s *Saga) AddStep(step Step) {
	s.steps = append(s.steps, step)
}

func (s *Saga) Run() error {
	for _, step := range s.steps {
		fmt.Printf("  → Executing: %s\n", step.Name)
		if err := step.Execute(); err != nil {
			fmt.Printf("  ✗ Failed: %s (%v) - compensating...\n", step.Name, err)
			s.compensate()
			return fmt.Errorf("saga failed at step %q: %w", step.Name, err)
		}
		s.completed = append(s.completed, step)
		fmt.Printf("  ✓ Done: %s\n", step.Name)
	}
	return nil
}

func (s *Saga) compensate() {
	// Compensate in reverse order
	for i := len(s.completed) - 1; i >= 0; i-- {
		step := s.completed[i]
		if step.Compensate == nil {
			continue
		}
		fmt.Printf("  ↩ Compensating: %s\n", step.Name)
		if err := step.Compensate(); err != nil {
			fmt.Printf("  ✗ Compensation failed for %s: %v (manual intervention needed)\n", step.Name, err)
		}
	}
}

// Simulate a payment saga: reserve funds → charge card → update ledger → notify merchant
func buildPaymentSaga(failAt string) *Saga {
	saga := &Saga{}

	saga.AddStep(Step{
		Name:       "reserve_funds",
		Execute:    func() error { return simulateStep("reserve_funds", failAt) },
		Compensate: func() error { fmt.Println("    releasing reserved funds"); return nil },
	})
	saga.AddStep(Step{
		Name:       "charge_card",
		Execute:    func() error { return simulateStep("charge_card", failAt) },
		Compensate: func() error { fmt.Println("    issuing refund to card"); return nil },
	})
	saga.AddStep(Step{
		Name:       "update_ledger",
		Execute:    func() error { return simulateStep("update_ledger", failAt) },
		Compensate: func() error { fmt.Println("    reversing ledger entry"); return nil },
	})
	saga.AddStep(Step{
		Name:    "notify_merchant",
		Execute: func() error { return simulateStep("notify_merchant", failAt) },
		// Notification is idempotent - no compensation needed
	})
	return saga
}

func simulateStep(name, failAt string) error {
	if name == failAt {
		return errors.New("simulated failure")
	}
	return nil
}

func main() {
	fmt.Println("=== Successful Payment ===")
	if err := buildPaymentSaga("").Run(); err != nil {
		fmt.Printf("Error: %v\n", err)
	}

	fmt.Println("\n=== Payment failing at update_ledger ===")
	if err := buildPaymentSaga("update_ledger").Run(); err != nil {
		fmt.Printf("Final error: %v\n", err)
	}
}
```

#### Problem 9: Consistent Hashing for Payment Shard Routing (Hard)

*Build a consistent hash ring to route payment requests to shards - ensures minimal redistribution when shards are added/removed.*

```go
package main

import (
	"crypto/md5"
	"fmt"
	"slices"
)

type HashRing struct {
	replicas int
	ring     []uint32
	nodes    map[uint32]string
}

func NewHashRing(replicas int) *HashRing {
	return &HashRing{
		replicas: replicas,
		nodes:    make(map[uint32]string),
	}
}

func hash(key string) uint32 {
	h := md5.Sum([]byte(key))
	return uint32(h[0])<<24 | uint32(h[1])<<16 | uint32(h[2])<<8 | uint32(h[3])
}

func (r *HashRing) AddNode(node string) {
	for i := range r.replicas {
		h := hash(fmt.Sprintf("%s#%d", node, i))
		r.ring = append(r.ring, h)
		r.nodes[h] = node
	}
	slices.Sort(r.ring)
}

func (r *HashRing) RemoveNode(node string) {
	for i := range r.replicas {
		h := hash(fmt.Sprintf("%s#%d", node, i))
		delete(r.nodes, h)
		idx, _ := slices.BinarySearch(r.ring, h)
		if idx < len(r.ring) && r.ring[idx] == h {
			r.ring = slices.Delete(r.ring, idx, idx+1)
		}
	}
}

func (r *HashRing) GetNode(key string) string {
	if len(r.ring) == 0 {
		return ""
	}
	h := hash(key)
	idx, _ := slices.BinarySearch(r.ring, h)
	if idx == len(r.ring) {
		idx = 0
	}
	return r.nodes[r.ring[idx]]
}

func main() {
	ring := NewHashRing(3)
	for _, node := range []string{"shard-1", "shard-2", "shard-3"} {
		ring.AddNode(node)
	}

	payments := []string{"pay_aaa", "pay_bbb", "pay_ccc", "pay_ddd", "pay_eee"}

	fmt.Println("Initial routing:")
	for _, p := range payments {
		fmt.Printf("  %s → %s\n", p, ring.GetNode(p))
	}

	ring.AddNode("shard-4")
	fmt.Println("\nAfter adding shard-4:")
	for _, p := range payments {
		fmt.Printf("  %s → %s\n", p, ring.GetNode(p))
	}
}
```

#### Problem 10: Distributed Lock for Payment Deduplication (Hard)

*Implement a distributed lock service that prevents duplicate payment processing across multiple nodes using optimistic locking.*

```go
package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrAlreadyLocked = errors.New("lock already held")
var ErrLockExpired = errors.New("lock expired before release")

type Lock struct {
	owner     string
	expiresAt time.Time
}

type DistributedLockService struct {
	mu    sync.Mutex
	locks map[string]*Lock
}

func NewDistributedLockService() *DistributedLockService {
	return &DistributedLockService{locks: make(map[string]*Lock)}
}

// Acquire attempts to acquire a lock for key, held by owner, for ttl duration.
func (s *DistributedLockService) Acquire(key, owner string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if existing, ok := s.locks[key]; ok {
		if existing.expiresAt.After(now) {
			return fmt.Errorf("%w: held by %s until %v", ErrAlreadyLocked, existing.owner, existing.expiresAt)
		}
		// Lock expired - allow takeover
	}
	s.locks[key] = &Lock{owner: owner, expiresAt: now.Add(ttl)}
	return nil
}

// Release releases a lock, verifying the caller owns it.
func (s *DistributedLockService) Release(key, owner string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	lock, ok := s.locks[key]
	if !ok {
		return fmt.Errorf("lock %q not found", key)
	}
	if lock.owner != owner {
		return fmt.Errorf("cannot release: owned by %s not %s", lock.owner, owner)
	}
	if time.Now().After(lock.expiresAt) {
		delete(s.locks, key)
		return ErrLockExpired
	}
	delete(s.locks, key)
	return nil
}

// WithLock executes fn while holding the lock - guarantees release on panic/error.
func (s *DistributedLockService) WithLock(key, owner string, ttl time.Duration, fn func() error) error {
	if err := s.Acquire(key, owner, ttl); err != nil {
		return fmt.Errorf("acquire: %w", err)
	}
	defer func() {
		if err := s.Release(key, owner); err != nil && !errors.Is(err, ErrLockExpired) {
			fmt.Printf("warning: release error for %s: %v\n", key, err)
		}
	}()
	return fn()
}

func main() {
	svc := NewDistributedLockService()
	key := "payment:idempotency:key-abc"

	// Node A acquires lock and processes payment
	err := svc.WithLock(key, "node-a", 5*time.Second, func() error {
		fmt.Println("node-a: processing payment...")
		return nil
	})
	fmt.Printf("node-a result: %v\n", err)

	// Concurrent attempt by node-b (will fail while node-a holds it)
	if err := svc.Acquire(key, "node-a", 5*time.Second); err == nil {
		// node-a holds it again
		fmt.Println("node-a: re-acquired lock")
		err2 := svc.Acquire(key, "node-b", 5*time.Second)
		fmt.Printf("node-b concurrent acquire: %v\n", err2)
		_ = svc.Release(key, "node-a")
	}
}
```

---

### System Design Topics

**Top 5 Stripe System Design Questions:**

1. **Design Stripe's Idempotency Layer** - How do you guarantee exactly-once payment processing across retries, network failures, and database outages? Topics: idempotency keys, database upserts, distributed locking, TTL expiry, concurrent request handling.

2. **Design Stripe's Webhook Delivery System** - Deliver billions of events to millions of merchant endpoints reliably. Topics: message queues (Kafka/SQS), retry with backoff, dead letter queues, delivery ordering, fan-out architecture, signature verification.

3. **Design a Multi-Currency Ledger** - Store financial transactions across 135+ currencies with auditability. Topics: double-entry bookkeeping, integer arithmetic, exchange rate management, multi-currency account balances, reconciliation.

4. **Design Stripe Radar (Fraud Detection)** - Real-time fraud scoring on billions of annual transactions. Topics: ML feature pipelines, rule engines, streaming aggregation, feature stores, latency budgets (<50ms), feedback loops.

5. **Design Stripe's API Rate Limiting** - Enforce per-account limits while handling bursts. Topics: token bucket vs sliding window, Redis vs in-memory, distributed rate limiting consistency, graceful degradation, observability.

---

### Behavioral Focus

Stripe's culture centers on **"Thoughtful, Rigorous, and Empathetic."** Behavioral questions probe:

- **Correctness over speed:** "Tell me about a time you slowed down to ensure correctness when there was pressure to ship fast."
- **User trust:** "Describe a situation where you had to balance developer experience against security or correctness in an API."
- **Intellectual honesty:** "Tell me about a significant technical mistake you made and how you handled it."
- **Craft:** "Describe the most elegant system you've designed. What made it elegant?"
- **Collaboration:** "How do you handle strong technical disagreement with a senior colleague?"

Stripe values deep thinking and the courage to advocate for correctness even when unpopular. Showing that you have prevented production incidents through rigor scores very highly.

---

### Insider Tips

**Common Mistakes:**
- Using `float64` for monetary amounts - instant red flag at Stripe. Always use integer arithmetic (cents/minor units).
- Skipping error handling - Stripe's culture demands explicit, thorough error handling. Every error path must be addressed.
- Failing the Bug Squash round by fixing symptoms instead of root causes. They want you to understand why the bug exists.
- Not asking clarifying questions about edge cases (concurrent requests, partial failures, network timeouts) before coding.

**Strong Hire Signals:**
- Proactively mentioning idempotency before the interviewer asks.
- Designing for failure: discussing what happens when each step fails.
- Integer arithmetic for money without being prompted.
- Referencing Stripe's actual products/architecture during system design.

**Red Flags:**
- "I'll handle edge cases later" - at Stripe, edge cases are the job.
- Floats for money calculations.
- Saga patterns without compensation logic.
- Race conditions in concurrent code (they will run the race detector).

---

### 8-Week Preparation Timeline

```
Week 1: Payments & Financial Systems Foundations
  Mon-Tue: Study double-entry bookkeeping, idempotency patterns
  Wed-Thu: Implement idempotent payment processor, ledger system
  Fri:     Study Stripe's API design philosophy, idempotency key docs
  Weekend: Practice 3 API design questions

Week 2: Distributed Systems for Payments
  Mon-Tue: Saga pattern, two-phase commit, compensating transactions
  Wed-Thu: Distributed locks, optimistic locking, CAS operations
  Fri:     Consistent hashing, shard routing
  Weekend: Build a mini payment processing system end-to-end

Week 3: Concurrency & Race Conditions
  Mon-Tue: Go race detector, sync primitives, channel patterns
  Wed-Thu: Bug Squash practice - deliberately broken Go programs
  Fri:     Go memory model, happens-before guarantees
  Weekend: Debug 5 intentionally broken codebases

Week 4: System Design - Payment Infrastructure
  Mon-Tue: Design idempotency layer (whiteboard)
  Wed-Thu: Design webhook delivery system
  Fri:     Design multi-currency ledger
  Weekend: Mock system design interview with payment focus

Week 5: Algorithms & Data Structures
  Mon-Fri: 2 problems/day - focus on graphs, heaps, sliding window
  Weekend: 5 timed (45-min) full coding rounds

Week 6: Fraud Detection & Risk Systems
  Mon-Tue: Streaming aggregation, feature stores, rule engines
  Wed-Thu: Implement simplified Radar-style fraud pipeline
  Fri:     Study ML serving patterns (no ML required, just serving)
  Weekend: System design: Stripe Radar

Week 7: API Design & Integration
  Mon-Tue: REST best practices, backwards compatibility, versioning
  Wed-Thu: Implement complete payment API with idempotency + webhooks
  Fri:     Code review practice - review others' payment code
  Weekend: Mock Bug Squash round (find bugs in shared Go programs)

Week 8: Final Prep
  Mon-Tue: Behavioral stories - 5 STAR stories for Stripe's values
  Wed:     Full mock onsite (all 5 rounds back-to-back)
  Thu:     Review weak areas, polish answers
  Fri:     Rest, logistics, environment setup
```

---


### Junior → FAANG: Stripe Interview Preparation Basics

Stripe interviews are known for being rigorous and practical. The engineering bar is high, with a strong emphasis on distributed systems and API design. Stripe's take-home project (for some roles) is evaluated on production quality, not just correctness: error handling, edge cases, testability, and documentation matter. Behavioral interviews at Stripe focus on ownership, clarity of thinking, and genuine intellectual engagement with hard problems. Know Stripe's core engineering challenges: payment processing reliability, fraud detection at scale, API versioning, and global compliance.

### Senior @ FAANG: Stripe Senior and Staff Engineer: Reliability Culture and API Craft

At the senior and staff level, Stripe's bar reflects its core business requirement: financial transactions must be correct, idempotent, and auditable. This means senior candidates should demonstrate a reliability culture that goes beyond standard FAANG patterns. Specifically: idempotency key design for distributed payment operations (what happens when a payment request is retried after a timeout), reconciliation workflows (how do you detect and resolve discrepancies between Stripe's internal state and bank records), and the trade-off between strict consistency and availability in a payments context. Stripe's API design is a company-wide obsession: the API has served developers for 15 years with backward compatibility, which is an extraordinary engineering achievement. Senior candidates should have a clear point of view on API versioning strategies, backward-compatible schema evolution, and the long-term cost of API decisions.

---
