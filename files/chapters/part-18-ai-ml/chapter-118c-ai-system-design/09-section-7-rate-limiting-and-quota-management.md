## 118C.8 Rate Limiting and Quota Management

Rate limiting protects backend services from abuse and overload by capping the volume of requests any single client can make within a time window. The following implementation uses a token bucket algorithm, which permits short bursts while enforcing a sustained average rate without penalizing legitimate bursty traffic.

```go
package quota

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// QuotaManager enforces per-user and per-org token and budget limits.
type QuotaManager struct {
	store QuotaStore
}

func NewQuotaManager(store QuotaStore) *QuotaManager {
	return &QuotaManager{store: store}
}

// UserQuota is a snapshot of one user's limits and usage.
//
// Plain int64 counters, not atomic.Int64. The atomics were worse than useless
// here: GetQuota returns a fresh struct per call, so an atomic increment on it
// mutates a copy that is discarded at the end of the request. Atomics on a
// per-call snapshot buy no safety and imply a thread-safety that does not
// exist. The real serialisation has to happen in the store, which is shared.
type UserQuota struct {
	UserID        string
	MonthlyTokens int64
	UsedTokens    int64
	MonthlyBudget float64 // USD
	UsedBudget    int64   // cents
	ResetAt       time.Time
}

type QuotaStore interface {
	GetQuota(ctx context.Context, userID string) (*UserQuota, error)
	// IncrementUsage must be atomic in the store (a single UPDATE ... SET
	// used = used + $1, or a Redis INCRBY), never read-modify-write in Go.
	IncrementUsage(ctx context.Context, userID string, tokens int, costCents int64) error
	// ResetIfDue atomically zeroes the counters and advances ResetAt to the
	// next period, returning the refreshed quota. See the note in Check.
	ResetIfDue(ctx context.Context, userID string, now time.Time) (*UserQuota, error)
}

// Check validates whether a user can make a request.
//
// The rollover logic is where the original went badly wrong:
//
//	if time.Now().After(quota.ResetAt) {
//		quota.UsedTokens.Store(0)   // in-memory copy only
//		quota.UsedBudget.Store(0)   // never persisted
//	}                               // ResetAt never advanced
//
// Three bugs stacked into four lines. The counters were zeroed on a snapshot
// that is thrown away when the function returns, so nothing was persisted.
// ResetAt was never moved forward, so the condition stays true forever. And
// because the zeroing happens immediately before the limit comparison, every
// subsequent call sees used == 0 and allows the request.
//
// The result is not "quota resets monthly". It is "quota stops existing the
// moment the first period ends, permanently, for that user". The system reports
// no errors and the meter reads zero while spend runs unbounded. Like the
// vacuous-pass in the eval harness, this fails open: the check is still there,
// still running, and no longer checking anything.
//
// Rollover is a state transition on shared state, so it belongs in the store,
// executed atomically, not in a read-only snapshot in the request path.
func (q *QuotaManager) Check(ctx context.Context, userID string, estimatedTokens int) error {
	quota, err := q.store.GetQuota(ctx, userID)
	if err != nil {
		return err
	}

	if time.Now().After(quota.ResetAt) {
		quota, err = q.store.ResetIfDue(ctx, userID, time.Now())
		if err != nil {
			// Fail closed. If we cannot establish the user's remaining quota,
			// we do not get to assume there is some.
			return fmt.Errorf("quota rollover for %s: %w", userID, err)
		}
	}

	if quota.UsedTokens+int64(estimatedTokens) > quota.MonthlyTokens {
		return &QuotaError{
			UserID:  userID,
			Type:    "token_limit",
			Used:    quota.UsedTokens,
			Limit:   quota.MonthlyTokens,
			ResetAt: quota.ResetAt,
		}
	}

	// Enforce the spend limit too. MonthlyBudget existed on this struct while
	// nothing ever compared against it, which is the most expensive kind of
	// dead code: a limit the operator believes is in force and that has never
	// once rejected a request.
	budgetCents := int64(math.Round(quota.MonthlyBudget * 100))
	if quota.UsedBudget >= budgetCents {
		return &QuotaError{
			UserID:  userID,
			Type:    "budget_limit",
			Used:    quota.UsedBudget,
			Limit:   budgetCents,
			ResetAt: quota.ResetAt,
		}
	}

	return nil
}

// Record updates usage after a successful request.
func (q *QuotaManager) Record(ctx context.Context, userID string, tokens int, costUSD float64) error {
	// Round, do not truncate. int64(costUSD * 100) discards the fraction, so
	// every sub-cent request bills zero. At LLM per-request prices that is a
	// large share of traffic, and the meter drifts steadily below reality in
	// the direction that costs you money.
	costCents := int64(math.Round(costUSD * 100))
	return q.store.IncrementUsage(ctx, userID, tokens, costCents)
}

type QuotaError struct {
	UserID  string
	Type    string
	Used    int64
	Limit   int64
	ResetAt time.Time
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("quota exceeded for %s: used %d/%d tokens, resets at %v",
		e.UserID, e.Used, e.Limit, e.ResetAt)
}

// TokenBucketRateLimiter provides per-user rate limiting.
//
// Scope note: this is per-process. Run three replicas behind a load balancer
// and each keeps its own buckets, so the effective limit is 3x what you
// configured. Enforcing a global limit needs shared state (Redis) or
// consistent routing of a user to one replica. Say which one you mean.
type TokenBucketRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	rate    float64 // tokens per second
	burst   int
	ttl     time.Duration // idle buckets older than this are collectable
}

type tokenBucket struct {
	tokens   float64
	lastTime time.Time
}

func NewTokenBucketRateLimiter(rps float64, burst int) *TokenBucketRateLimiter {
	rl := &TokenBucketRateLimiter{
		buckets: make(map[string]*tokenBucket),
		rate:    rps,
		burst:   burst,
		ttl:     10 * time.Minute,
	}
	return rl
}

func (rl *TokenBucketRateLimiter) Allow(userID string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()

	bucket, ok := rl.buckets[userID]
	if !ok {
		bucket = &tokenBucket{tokens: float64(rl.burst), lastTime: now}
		rl.buckets[userID] = bucket
	}

	elapsed := now.Sub(bucket.lastTime).Seconds()
	bucket.tokens = math.Min(float64(rl.burst), bucket.tokens+elapsed*rl.rate)
	bucket.lastTime = now

	if bucket.tokens >= 1 {
		bucket.tokens--
		return true
	}
	return false
}

// EvictIdle drops buckets that have been idle long enough to have refilled.
//
// Without this the map only ever grows: one entry per distinct user ID, kept
// forever. On an endpoint keyed by anything user-supplied or high-cardinality,
// that is an unbounded memory leak reachable by an anonymous caller, and the
// rate limiter becomes the denial-of-service it was installed to prevent.
//
// A bucket idle for longer than burst/rate seconds has refilled to full, so it
// is indistinguishable from a fresh one and can be dropped without giving the
// user extra allowance. Call this from a background ticker.
func (rl *TokenBucketRateLimiter) EvictIdle() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	cutoff := time.Now().Add(-rl.ttl)
	for userID, bucket := range rl.buckets {
		if bucket.lastTime.Before(cutoff) {
			delete(rl.buckets, userID)
		}
	}
}

// RunEviction sweeps idle buckets until ctx is cancelled.
func (rl *TokenBucketRateLimiter) RunEviction(ctx context.Context) {
	ticker := time.NewTicker(rl.ttl)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			rl.EvictIdle()
		}
	}
}
```

---

### Junior → FAANG: Token Bucket Algorithm as Classic Interview Topic

The token bucket algorithm is the most commonly asked rate limiting algorithm in FAANG system design interviews. The key parameters are: bucket capacity (maximum burst size), refill rate (tokens per second added to the bucket), and cost per request (tokens consumed per request). A request is allowed if the bucket has enough tokens. Otherwise it is rejected (or queued). The algorithm permits bursts up to the bucket capacity while enforcing a sustained average rate equal to the refill rate. Understanding the difference between token bucket (allows bursts) and sliding window counter (more uniform rate enforcement) is the rate limiting algorithm question that appears in system design interviews.

For AI systems specifically, rate limiting has two dimensions that traditional web services do not have: request count rate limiting (standard HTTP rate limiting) and token count rate limiting (how many LLM tokens this user can consume per hour). Token rate limiting requires counting tokens before the LLM call (based on input prompt token count) and after the call (based on actual output token count), and deducting from the user's token budget. Implementing both dimensions of rate limiting, and handling the case where the user has request capacity but no token capacity (or vice versa), is AI-specific rate limiting knowledge.

The asymmetry between the two dimensions is what makes AI quotas genuinely harder, and it is worth being able to articulate. A request either happens or it does not, so you can count it before admitting it. Token spend cannot be known until the response finishes: `Check` can only work from an *estimate* of the output length, and the true number arrives at `Record`. Three consequences follow. `Check` and `Record` form a check-then-act race, so N concurrent requests can each pass a check against the same pre-request balance and collectively blow through the limit. Enforcement is therefore inherently approximate, and the design question is which way you want to be wrong: reserve the estimate up front and refund the difference (users are throttled slightly early, spend is bounded) or record after the fact (users get their full allowance, and a burst can overshoot). Pick deliberately, and note that a user who requests a very large `max_tokens` can make the estimate arbitrarily wrong unless you clamp it. For a hard spend ceiling, reserve up front. For a soft usage meter, record after.

### Senior @ FAANG: Quota Management as Product and Business Engineering

At senior level, quota management is both a technical and a business engineering concern. Technical quotas (requests per minute, tokens per hour) protect the infrastructure from overload. Business quotas (tokens per user per month, based on the user's subscription tier) determine the product's revenue model: free tier users get fewer tokens than paid tier users, enterprise users get dedicated capacity. The quota management system must enforce both types of quotas while providing visibility to users (how many tokens have they used this month? how many remain?) and to the business (which users are approaching their quota? which quota tiers are most commonly used?). This combination of technical enforcement and business visibility is the product engineering dimension of AI systems that staff engineers are expected to understand and design.
