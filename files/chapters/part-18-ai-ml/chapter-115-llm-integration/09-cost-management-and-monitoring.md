## 115.8 Cost Management and Monitoring

### Token Tracking and Cost Calculation

LLM costs are driven entirely by token consumption. Tracking per-request input and output token counts, mapping them to per-model pricing, and aggregating by user or feature enables chargeback and budget alerting before costs become a surprise.

Two warnings before the code. First, this tracker keeps every event in an in-memory slice, which is fine for a single-process illustration and wrong for production twice over: the slice grows without bound until the process dies, and the totals evaporate on restart while the provider's invoice does not. A real deployment writes usage events to a store and aggregates there. Second, the price table below is *illustrative and already drifting*. Providers cut prices, introduce tiers, and retire models continuously. Hardcoding prices in a binary guarantees that your cost reports are quietly wrong. Load the table from configuration, version it, and reconcile it against the provider's invoice.

```go
// cost/tracker.go
package cost

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

type ModelPricing struct {
	InputPer1K  float64 // Cost per 1K input tokens
	OutputPer1K float64 // Cost per 1K output tokens
}

// Pricing is a seed/default table, NOT a source of truth. Verify every entry
// against the provider's current pricing page and override from config.
// Prices here are USD per 1K tokens.
var Pricing = map[string]ModelPricing{
	"gpt-4o-mini": {
		InputPer1K:  0.00015,
		OutputPer1K: 0.0006,
	},
	"claude-sonnet-4-6": {
		InputPer1K:  0.003,
		OutputPer1K: 0.015,
	},
}

type Usage struct {
	Model        string
	InputTokens  int
	OutputTokens int
	Cost         float64
	Timestamp    time.Time
}

type Tracker struct {
	mu    sync.RWMutex
	usage []Usage
}

func NewTracker() *Tracker {
	return &Tracker{
		usage: make([]Usage, 0),
	}
}

// Estimate prices a hypothetical request without recording it. Use it to
// pre-authorize spend before calling the provider, passing your MaxTokens
// ceiling as outputTokens so the estimate is an upper bound rather than a hope.
func (t *Tracker) Estimate(model string, inputTokens, outputTokens int) (float64, error) {
	pricing, ok := Pricing[model]
	if !ok {
		return 0, fmt.Errorf("no pricing configured for model %q", model)
	}
	return (float64(inputTokens)/1000)*pricing.InputPer1K +
		(float64(outputTokens)/1000)*pricing.OutputPer1K, nil
}

// Track records usage and returns the computed cost.
//
// An unknown model is an ERROR, not a free request. The tempting shortcut is to
// fall back to zero pricing and carry on, and it is a genuine trap: the day
// someone points a feature at a model missing from this table, every request
// prices at $0.00, sails through every budget check, and reports a perfectly
// healthy spend graph while the real invoice climbs. A cost control that fails
// open is not a cost control. Fail loudly instead.
func (t *Tracker) Track(model string, inputTokens, outputTokens int) (float64, error) {
	pricing, ok := Pricing[model]
	if !ok {
		return 0, fmt.Errorf("no pricing configured for model %q: refusing to price it at zero", model)
	}

	cost := (float64(inputTokens)/1000)*pricing.InputPer1K +
		(float64(outputTokens)/1000)*pricing.OutputPer1K

	t.mu.Lock()
	defer t.mu.Unlock()

	t.usage = append(t.usage, Usage{
		Model:        model,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		Cost:         cost,
		Timestamp:    time.Now(),
	})

	return cost, nil
}

func (t *Tracker) TotalCost() float64 {
	t.mu.RLock()
	defer t.mu.RUnlock()

	var total float64
	for _, u := range t.usage {
		total += u.Cost
	}
	return total
}

func (t *Tracker) CostByModel() map[string]float64 {
	t.mu.RLock()
	defer t.mu.RUnlock()

	costs := make(map[string]float64)
	for _, u := range t.usage {
		costs[u.Model] += u.Cost
	}
	return costs
}

// UsageReport renders a summary.
//
// Note that it computes the overall total inline rather than calling
// TotalCost(). That is not a style preference, it is a deadlock fix.
// sync.RWMutex is not reentrant, and read locks are not recursively safe:
// Go blocks a new RLock while a writer is waiting, so that writers cannot be
// starved. If this method holds RLock and then calls TotalCost(), which takes
// RLock again, a Track() call arriving in between parks the writer, the inner
// RLock queues behind that writer, and the goroutine waits on a lock it is
// itself holding. Everything downstream wedges.
//
// The bug is load-dependent, which is what makes it dangerous: single-threaded
// tests pass every time, and it only bites under production concurrency.
//
// Rule of thumb: an exported method that takes a lock must never call another
// exported method that takes the same lock. Factor the shared work into an
// unexported helper that assumes the lock is already held.
func (t *Tracker) UsageReport() string {
	t.mu.RLock()
	defer t.mu.RUnlock()

	var sb strings.Builder
	sb.WriteString("LLM Usage Report\n")
	sb.WriteString("================\n\n")

	costByModel := make(map[string]float64)
	tokensByModel := make(map[string]int)
	var overall float64

	for _, u := range t.usage {
		costByModel[u.Model] += u.Cost
		tokensByModel[u.Model] += u.InputTokens + u.OutputTokens
		overall += u.Cost
	}

	for model, cost := range costByModel {
		sb.WriteString(fmt.Sprintf("Model: %s\n", model))
		sb.WriteString(fmt.Sprintf("  Total Cost: $%.4f\n", cost))
		sb.WriteString(fmt.Sprintf("  Total Tokens: %d\n\n", tokensByModel[model]))
	}

	sb.WriteString(fmt.Sprintf("Overall Total: $%.4f\n", overall))

	return sb.String()
}
```

### Budget Enforcement

Budget enforcement limits API spending by tracking consumption per user or tenant and rejecting requests that would exceed the configured limit.

The implementation below is deliberately in-process: a mutex-guarded counter in one binary. Read that as the sequential model of the problem, not as a deployment. The moment you run two replicas, each one enforces its own private budget, and a "limit" of $100 becomes $100 *per pod*, silently scaling your spend with your replica count. A distributed budget needs shared state with atomic increments (Redis `INCRBYFLOAT` and a Lua script for the check-and-debit, or a database row with the appropriate isolation), because the check and the debit have to be one indivisible step. Split them and concurrent requests all read "under budget" before any of them writes, and they all sail through together. That race is the whole problem.

```go
// cost/budget.go
package cost

import (
	"errors"
	"sync"
)

var ErrBudgetExceeded = errors.New("budget exceeded")

type Budget struct {
	mu             sync.RWMutex
	limit          float64
	spent          float64
	softLimit      float64 // Warn threshold
	softLimitFired bool    // latch, so the warning fires once per budget period
	onSoftLimit    func()
	onHardLimit    func()
}

func NewBudget(limit float64) *Budget {
	return &Budget{
		limit:     limit,
		softLimit: limit * 0.8, // 80% warning
	}
}

func (b *Budget) OnSoftLimit(fn func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onSoftLimit = fn
}

func (b *Budget) OnHardLimit(fn func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onHardLimit = fn
}

// Check atomically verifies and debits the budget in a single critical section.
// Do not be tempted to split this into a Check() and a separate Debit(): under
// concurrency every caller would read the pre-debit balance, all conclude they
// fit, and all proceed. The check and the write must be indivisible.
//
// The callbacks are invoked on their own goroutines on purpose, so that a slow
// alerting hook cannot stall every request queued behind this lock. They must
// therefore not touch Budget's fields, or they would deadlock on b.mu.
func (b *Budget) Check(cost float64) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	newTotal := b.spent + cost

	if newTotal > b.limit {
		if b.onHardLimit != nil {
			go b.onHardLimit()
		}
		return ErrBudgetExceeded
	}

	b.spent = newTotal

	// Latch the soft-limit warning. Without the latch this fires on every
	// request once spend passes 80%, so the one alert that matters arrives
	// buried in thousands of duplicates and the team mutes the channel.
	if !b.softLimitFired && b.spent > b.softLimit {
		b.softLimitFired = true
		if b.onSoftLimit != nil {
			go b.onSoftLimit()
		}
	}

	return nil
}

// Reconcile settles a pre-authorized estimate against the actual charge,
// completing the authorize-then-settle cycle Check begins. Without it the
// budget permanently reflects estimates rather than reality, and it drifts in
// whichever direction your estimator is biased.
func (b *Budget) Reconcile(estimated, actual float64) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.spent += actual - estimated
	if b.spent < 0 {
		b.spent = 0
	}
}

// Reset clears the counter at the start of a new budget period and re-arms
// the soft-limit warning.
func (b *Budget) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.spent = 0
	b.softLimitFired = false
}

func (b *Budget) Remaining() float64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.limit - b.spent
}

func (b *Budget) Spent() float64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.spent
}
```

One accounting subtlety this design has to confront: you cannot know the true cost of a request until it has completed, because output tokens are only counted after generation. So `Check` is necessarily a pre-authorization against an *estimate*, and the actual charge has to be reconciled afterwards. Model this the way a card payment does, by authorizing an upper bound (your `MaxTokens` ceiling gives you one) and settling the real amount once usage comes back. Skip the reconciliation step and a budget enforced purely on input tokens will happily approve a request whose output costs many times the estimate.

### Junior → FAANG: Cost Management as Engineering Discipline

LLM API costs are the most common source of production surprises for junior engineers who have only worked with free or fixed-cost infrastructure. A chat application that sends full conversation history in every request will see cost grow linearly with conversation length: a 20-turn conversation has 20x the token cost of a 1-turn conversation if you send the full history. Understanding this and designing cost management from the start, including conversation summarization to compress long histories, is the difference between a service that is affordable at scale and one that generates an unexpected bill.

Build a cost tracking service as a learning exercise: accept token usage events (request tokens, response tokens, model name, user ID, feature name), compute cost per event using a model pricing table, aggregate by user/feature/day, expose a summary API, and emit a Prometheus counter for total cost per model. This exercise covers: data modeling, time-series aggregation, cost computation, and observability. Each of these skills is directly applicable to production LLM systems, and the resulting service is a portfolio artifact worth demonstrating in interviews.

Token budget enforcement per user is the operational control that prevents a single user from generating disproportionate cost. Implement it with a sliding window rate limiter backed by Redis: on each request, check the user's token consumption in the last 24 hours, reject the request if the budget is exhausted, and debit the actual token count from the response against the budget after the API call completes. This is a standard rate limiting pattern applied to tokens rather than requests, and Go's atomic operations make the counter update safe for concurrent access.

### Senior @ FAANG: LLM Cost as a Product and Engineering Concern

At FAANG, LLM cost is a first-class product concern. Product managers need to know the cost per user per month for LLM features because it directly affects the unit economics of the product. Engineers need to know the cost per request per feature to evaluate whether optimizations (prompt compression, caching, model downgrade) have a positive ROI. Finance needs cost attribution per cost center for budget allocation. Building a cost analytics system that satisfies all three audiences is a platform investment with clear stakeholders.

Cost optimization strategies stack: semantic caching (avoid duplicate API calls for similar prompts) pays off in proportion to how repetitive your traffic actually is, which is an empirical question you answer by measuring your own prompt-duplication rate rather than by quoting someone else's savings figure. Model routing (use a cheap model for simple tasks, an expensive model only for complex ones) can move average cost per request substantially, since the price gap between tiers is often an order of magnitude, but the saving is entirely contingent on the accuracy of the router: every misrouted hard request either degrades quality or costs you two calls instead of one. Provider-side prompt caching, where a long stable prefix is billed at a steep discount on subsequent reuse, is frequently the most effective change available and needs only correct request structure. Prompt compression (remove redundant context before sending) reduces input token count. Response length constraints reduce output token count. Conversation summarization reduces the cost of multi-turn conversations. At senior level, you measure the ROI of each optimization against its implementation and maintenance cost, and deploy the highest-ROI optimizations first.

At L6, LLM cost governance includes the policy for when LLM costs are visible to users (for example, displaying a "this analysis consumed X credits" message), how costs are allocated across teams (flat rate, per-request billing, or revenue-based allocation), and what the policy is for experiments that might have unusually high costs (requiring approval before running). These governance decisions affect how teams use LLM features and require cross-functional alignment between product, engineering, and finance. Staff engineers are often the right people to drive these conversations because they have the technical context to translate cost metrics into business terms that non-technical stakeholders understand.

The monitoring strategy for LLM costs must distinguish between expected cost growth (the feature is being used more, which is a positive indicator) and unexpected cost growth (a bug is causing redundant API calls, or a user is abusing the feature). This distinction requires baseline forecasting: if last week's daily cost was $500 and growing at 10% week-over-week, an alert should fire when the daily cost is more than 20% above the forecast, not when it exceeds an absolute threshold. Building this forecast-based alerting on top of the cost tracking system is a senior-level observability feature that prevents both under-alerting (missing real anomalies) and over-alerting (firing on expected growth). Pair it with a hard absolute ceiling that no forecast can talk you out of, because forecast-relative alerting has one catastrophic blind spot: a cost anomaly that ramps smoothly enough stays inside the forecast band the whole way up.
