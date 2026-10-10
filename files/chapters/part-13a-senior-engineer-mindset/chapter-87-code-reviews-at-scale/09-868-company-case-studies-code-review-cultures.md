## 87.8 Company Case Studies: Code Review Cultures

### Google's Readability Review System

Google has a unique "Readability" certification system for code reviews. This system ensures that every code change in a given language is reviewed by someone who has demonstrated mastery of that language's style, idioms, and best practices. The process doubles as one of the most effective onboarding and mentorship tools at the company, because engineers absorb quality standards through direct, repeated review feedback.

```
GOOGLE READABILITY PROGRAM:

PURPOSE:
- Ensure code in each language meets Google standards
- Provide mentorship through review process
- Create experts who spread best practices

HOW IT WORKS:
1. New Google engineer writes code
2. Code reviewed by "Readability Reviewer" (certified expert)
3. Feedback on style, idioms, best practices
4. After enough approved changes, engineer earns "Readability"
5. Can now approve others' code in that language

LANGUAGES WITH READABILITY:
- C++, Java, Python, JavaScript, Go, Objective-C
- Each has language-specific style guide
- ~500 pages of Go style guidance at Google

GOOGLE GO REVIEW CHECKLIST:
┌────────────────────────────────────────────────────────────┐
│  □ Error handling (wrapped with context?)                  │
│  □ Naming (follows Go conventions?)                        │
│  □ Documentation (exported symbols documented?)            │
│  □ Concurrency (race-free? proper sync?)                   │
│  □ Resource cleanup (defer Close()?)                       │
│  □ Testing (table-driven? edge cases?)                     │
│  □ Performance (appropriate algorithms?)                   │
│  □ Security (input validation? secrets safe?)              │
└────────────────────────────────────────────────────────────┘

TIME TO READABILITY:
- Typically 10-30 reviewed changes
- 3-6 months for most engineers
- Faster for experienced Go developers
```

```go
// Example: Google-style Go code review feedback

// SUBMISSION (needs work):
func GetUser(id string) *User {
    user, _ := db.Find(id)  // BAD: ignoring error
    return user
}

// READABILITY REVIEW:
/*
reviewer: This needs a few changes for readability approval:

1. Error handling: Never ignore errors. Either handle
   or wrap and return:

   user, err := db.Find(id)
   if err != nil {
       return nil, fmt.Errorf("get user %s: %w", id, err)
   }

2. Consider returning (User, error) instead of *User
   to follow Go conventions for fallible operations.

3. Add a doc comment explaining what happens if user
   not found (nil? error?).

See go/go-style#error-handling for more guidance.
*/

// REVISED:
// GetUser retrieves a user by ID. Returns ErrNotFound if
// no user exists with the given ID.
func GetUser(id string) (*User, error) {
    user, err := db.Find(id)
    if err != nil {
        if errors.Is(err, sql.ErrNoRows) {
            return nil, ErrNotFound
        }
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return user, nil
}
```

### Meta's Phabricator-Based Review Process

Meta (formerly Facebook) built its engineering culture around fast iteration and high trust. Their code review process, historically centered on the Phabricator tool, reflects this philosophy by emphasizing speed and pragmatism over exhaustive gatekeeping. The expectation is that engineers ship small changes frequently, and reviews should enable that velocity rather than slow it down.

```
META CODE REVIEW PHILOSOPHY:

1. "SHIP EARLY AND OFTEN"
   - Bias toward smaller, frequent PRs
   - Don't let reviews block shipping
   - Trust + Verify model

2. DIFF CULTURE (Phabricator terminology)
   - "Diff" = Pull Request
   - "Land" = Merge
   - "Accept" = Approve
   - Culture of fast turnaround

3. REVIEW EXPECTATIONS:
   ┌─────────────────────────────────────────────────────────┐
   │  RESPONSE TIME:                                         │
   │  - First response: same business day                    │
   │  - Blocking issues: communicate immediately             │
   │  - Non-blocking: can land, address later                │
   │                                                         │
   │  REVIEW DEPTH:                                          │
   │  - Production code: thorough review required            │
   │  - Test-only changes: can self-land with tests passing  │
   │  - Documentation: lower bar, encourage updates          │
   └─────────────────────────────────────────────────────────┘

4. AUTOMATION:
   - Automated code quality checks
   - Required CI pass before review
   - Auto-assignment based on code ownership
```

```go
// Meta-style review: Focus on correctness and safety

package feed

// Reviewer: sandraguo
// This looks good for the most part. A few comments:

// COMMENT 1 (Blocking): Race condition
type FeedCache struct {
    mu    sync.RWMutex
    items map[string]*FeedItem
}

func (c *FeedCache) Get(id string) *FeedItem {
    c.mu.RLock()
    item := c.items[id]  // Good: holding lock
    c.mu.RUnlock()
    return item  // ⚠️ Returning pointer, could be modified
}

// Suggestion: Return a copy or ensure FeedItem is immutable:
func (c *FeedCache) GetSafe(id string) FeedItem {
    c.mu.RLock()
    defer c.mu.RUnlock()
    if item, ok := c.items[id]; ok {
        return *item  // Return copy
    }
    return FeedItem{}
}

// COMMENT 2 (Non-blocking): Consider adding metrics
// It would be helpful to track cache hit rate. Not blocking,
// but please add a TODO or follow-up task.
```

### Amazon's Code Review Bar Raiser Concept

Amazon's engineering culture is deeply focused on operational excellence, and their code review process reflects this. Every review is expected to consider not just whether the code is correct, but how it will behave in production under failure conditions. The "bar raiser" concept means that reviews should actively raise the quality standard of the codebase, not merely maintain it.

```
AMAZON CODE REVIEW PRINCIPLES:

1. "BAR RAISER" MENTALITY
   - Every review should raise the bar
   - Don't accept "good enough"
   - Think about long-term maintainability

2. OPERATIONAL EXCELLENCE FOCUS
   Reviews must consider:
   - How will this fail?
   - How will we know it failed?
   - How will we recover?
   - What's the blast radius?

3. AMAZON CR CHECKLIST:
   ┌─────────────────────────────────────────────────────────────┐
   │  OPERATIONAL READINESS                                      │
   │  □ Monitoring and alerting in place                         │
   │  □ Runbook updated for new failure modes                    │
   │  □ Rollback plan documented                                 │
   │  □ On-call aware of change                                  │
   │                                                             │
   │  SECURITY                                                   │
   │  □ Input validation                                         │
   │  □ Authentication/Authorization checked                     │
   │  □ No secrets in code                                       │
   │  □ Threat modeling for new features                         │
   │                                                             │
   │  SCALABILITY                                                │
   │  □ Considered for 10x current load                          │
   │  □ Database queries analyzed                                │
   │  □ Caching strategy appropriate                             │
   └─────────────────────────────────────────────────────────────┘
```

```go
// Amazon-style review: Operational excellence focus

package order

// Reviewer: Principal Engineer

// QUESTION: What happens under load?
func ProcessOrder(ctx context.Context, order *Order) error {
    // Call payment service
    err := paymentClient.Charge(ctx, order.PaymentInfo)
    if err != nil {
        return err
    }

    // Call inventory service
    err = inventoryClient.Reserve(ctx, order.Items)
    if err != nil {
        // ⚠️ BLOCKING: Payment charged but inventory failed
        // What's the recovery path?
        return err
    }

    return nil
}

// REQUIRED CHANGES:
// 1. Add saga pattern or compensating transaction
// 2. Add metrics for failure rate at each step
// 3. Document runbook for manual intervention
// 4. Consider idempotency key for retry safety

// SUGGESTED APPROACH:
func ProcessOrderSafe(ctx context.Context, order *Order) error {
    // Use idempotency key
    idemKey := order.IdempotencyKey
    if idemKey == "" {
        return errors.New("idempotency key required")
    }

    // Check if already processed
    existing, err := orderStore.GetByIdempotencyKey(ctx, idemKey)
    if err == nil {
        return existing.Status.ToError()  // Return cached result
    }

    // Process with compensation
    paymentID, err := paymentClient.Charge(ctx, order.PaymentInfo)
    if err != nil {
        recordFailure(ctx, "payment", err)
        return fmt.Errorf("payment failed: %w", err)
    }

    err = inventoryClient.Reserve(ctx, order.Items)
    if err != nil {
        // Compensate: refund payment
        recordFailure(ctx, "inventory", err)
        if refundErr := paymentClient.Refund(ctx, paymentID); refundErr != nil {
            alertOps(ctx, "MANUAL_INTERVENTION_REQUIRED", order, refundErr)
        }
        return fmt.Errorf("inventory failed, payment refunded: %w", err)
    }

    return nil
}
```

### Stripe's Craft-Focused Reviews

Stripe treats code quality as a core competitive advantage, and their review culture reflects a deep commitment to craftsmanship. Reviews at Stripe tend to be more detailed and thoughtful than at companies that optimize primarily for speed. The philosophy is that taking extra time in review pays dividends in reliability and maintainability, which is especially critical for a company that processes billions of dollars in payments.

```
STRIPE CODE REVIEW CULTURE:

1. "CRAFT" AS CORE VALUE
   - Code quality is a competitive advantage
   - Take time to do it right
   - Learn from every review

2. REVIEW NORMS:
   - Detailed, thoughtful comments
   - Explain the "why" not just "what"
   - No drive-by criticism
   - Praise good code explicitly

3. STRIPE QUALITY BARS:
   ┌─────────────────────────────────────────────────────────────┐
   │  CORRECTNESS (Non-negotiable)                               │
   │  - Handles all edge cases                                   │
   │  - Error handling is complete                               │
   │  - Concurrency is correct                                   │
   │                                                             │
   │  CLARITY (High bar)                                         │
   │  - Code is self-documenting                                 │
   │  - Complex logic is commented                               │
   │  - Names are precise and meaningful                         │
   │                                                             │
   │  EFFICIENCY (Context-dependent)                             │
   │  - Appropriate for the use case                             │
   │  - Not prematurely optimized                                │
   │  - Considered for payment-critical paths                    │
   └─────────────────────────────────────────────────────────────┘
```

```go
// Stripe-style review: Craft and clarity focus

package idempotency

// Reviewer: Staff Engineer

// This is a thoughtful implementation! A few suggestions
// to make it even more robust:

// PRAISE: Love the use of context for cancellation
// and the clear separation of concerns.

type IdempotencyStore struct {
    db    *sql.DB
    cache *redis.Client
    ttl   time.Duration
}

// SUGGESTION: Consider making the key generation strategy explicit
//
// The current approach embeds assumptions about key format.
// Making it configurable would allow different use cases:
//
//   type KeyStrategy interface {
//       GenerateKey(req Request) string
//       ValidateKey(key string) error
//   }
//
// This isn't blocking, but worth considering for the next iteration.

func (s *IdempotencyStore) Get(ctx context.Context, key string) (*Result, error) {
    // COMMENT: Nice use of cache-aside pattern!

    // Try cache first
    cached, err := s.cache.Get(ctx, key).Result()
    if err == nil {
        var result Result
        if err := json.Unmarshal([]byte(cached), &result); err != nil {
            // QUESTION: Should we fall through to DB on cache corruption?
            // Current behavior: return error
            // Alternative: log and try DB
            return nil, fmt.Errorf("unmarshal cached result: %w", err)
        }
        return &result, nil
    }

    // Fall through to database
    // ...
}

// BLOCKING: The Set method needs atomic guarantees
//
// Between checking and inserting, another request could complete.
// Consider using database-level idempotency (INSERT ON CONFLICT)
// or distributed locking.
```

### Netflix's Review Philosophy

Netflix takes a distinctly different approach from most large companies by not requiring code review for all changes. Their "Freedom and Responsibility" culture trusts engineers to decide when they need review based on the risk level of their changes. This model only works because Netflix invests heavily in other quality mechanisms like chaos engineering, extensive monitoring, and post-incident analysis.

```
NETFLIX CODE REVIEW: "FREEDOM AND RESPONSIBILITY"

1. TRUST ENGINEERS
   - No mandatory review for all changes
   - Engineers choose when they need review
   - Trust judgment on risk level

2. WHEN REVIEWS ARE EXPECTED:
   - New systems or major changes
   - Security-sensitive code
   - Performance-critical paths
   - When you want feedback

3. REVIEW CULTURE:
   ┌─────────────────────────────────────────────────────────────┐
   │  PRINCIPLES:                                                │
   │  • "We're all adults here"                                  │
   │  • Focus on real risks, not style                           │
   │  • If you break it, you fix it                              │
   │  • Post-incident reviews > pre-merge reviews                │
   │                                                             │
   │  EMPHASIS:                                                  │
   │  • Does it work under chaos?                                │
   │  • Is it observable?                                        │
   │  • Can we roll it back?                                     │
   │  • Does it handle edge cases?                               │
   └─────────────────────────────────────────────────────────────┘

4. CHAOS ENGINEERING MINDSET IN REVIEWS:
   - "What happens when X fails?"
   - "How do we detect this failure?"
   - "What's the fallback behavior?"
```

```go
// Netflix-style review: Resilience and observability focus

package stream

// Reviewer: Senior Engineer
// CONTEXT: This is in the critical path for video playback

// QUESTION: What's the failure mode here?
func GetStreamURL(ctx context.Context, titleID string) (string, error) {
    // Get CDN allocation
    cdn, err := cdnService.GetBestCDN(ctx, titleID)
    if err != nil {
        return "", err  // ⚠️ No fallback
    }

    return cdn.BuildURL(titleID), nil
}

// SUGGESTION: Netflix's resilience patterns
func GetStreamURLResilient(ctx context.Context, titleID string) (string, error) {
    // Instrument for observability
    span, ctx := tracer.StartSpan(ctx, "GetStreamURL")
    defer span.End()

    cdn, err := cdnService.GetBestCDN(ctx, titleID)
    if err != nil {
        // Log for analysis
        log.Warn("primary CDN allocation failed",
            "titleID", titleID,
            "error", err,
        )

        // Fallback to default CDN (degraded but working)
        span.AddEvent("fallback_to_default_cdn")
        metrics.Incr("cdn.fallback")
        return defaultCDN.BuildURL(titleID), nil
    }

    span.SetAttribute("cdn", cdn.Name)
    return cdn.BuildURL(titleID), nil
}

// PRAISE: Good use of context for cancellation.
// Consider adding a timeout specific to this operation
// since it's in the critical playback path.
```

### Common Patterns Across Companies

Despite their different philosophies, the most successful engineering organizations converge on several shared principles for code review. Automation handles the mechanical checks, feedback is clearly categorized by priority, turnaround time is treated as a first-class metric, and reviews are viewed as teaching opportunities rather than gatekeeping exercises. These patterns represent battle-tested wisdom from organizations that review millions of lines of code per year.

```
┌──────────────────────────────────────────────────────────────────┐
│             CODE REVIEW BEST PRACTICES ACROSS FAANG              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. AUTOMATION FIRST                                             │
│     All companies automate what can be automated:                │
│     - Formatting (gofmt, prettier)                               │
│     - Linting (golangci-lint)                                    │
│     - Security scanning                                          │
│     - Test coverage                                              │
│                                                                  │
│  2. CATEGORIZE FEEDBACK                                          │
│     Distinguish between:                                         │
│     - Blocking (must fix)                                        │
│     - Should fix (strongly recommended)                          │
│     - Suggestion (nice to have)                                  │
│     - Nitpick (take it or leave it)                              │
│                                                                  │
│  3. SPEED MATTERS                                                │
│     Fast review turnaround is universal expectation:             │
│     - Google: same-day for most changes                          │
│     - Meta: same-day first response                              │
│     - Amazon: 24-hour SLO                                        │
│                                                                  │
│  4. TEACH THROUGH REVIEWS                                        │
│     Reviews are mentorship opportunity:                          │
│     - Explain the "why"                                          │
│     - Link to documentation                                      │
│     - Share context for decisions                                │
│                                                                  │
│  5. OPERATIONAL THINKING                                         │
│     All companies expect reviews to consider:                    │
│     - Failure modes                                              │
│     - Observability                                              │
│     - Rollback                                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Choosing the Right Reference Point for Your Target Company

Each company's review culture described in this section gives you a calibration reference for your target interview. If you are targeting Google, your behavioral examples about code review should demonstrate familiarity with the readability concept: write about a time your review feedback was aimed at teaching a language idiom, not just catching a bug. If you are targeting Amazon, your examples should demonstrate operational excellence thinking: write about a time you asked "how will we know this failed?" in a review.

The Netflix model is worth studying even if you are not targeting Netflix because it sharpens your thinking about when review is and is not the right quality mechanism. Candidates who can articulate tradeoffs between mandatory review and strong monitoring culture are demonstrating systems thinking that transcends any single company's process.

The "common patterns across companies" table at the end of this section is the most valuable interview preparation content: automation first, categorize feedback, speed matters, teach through reviews, and operational thinking. These five patterns are the universal senior engineer code review standard. If you can demonstrate all five in your behavioral examples, you are review-ready for any FAANG company.

### Senior @ FAANG: Selecting and Adapting Review Models to Your Org Context

At L6 and above, studying these company-specific models gives you a menu of options for designing or improving your own organization's review culture, not just a set of company histories.

Google's readability system is appropriate for organizations where language-specific expertise needs to scale across many teams and where the investment in a certification program is justified by the size of the engineering organization. For a 50-person team, a full readability system is overkill. A pair of designated Go quality reviewers who rotate through a review queue achieves most of the benefit at a fraction of the cost.

Netflix's "freedom and responsibility" model is appropriate for organizations with very strong engineers, mature monitoring infrastructure, and a culture of high accountability. Introducing it prematurely, before the monitoring infrastructure exists or before the engineering culture supports high accountability without guardrails, produces the worst outcome: engineers with review freedom but without the consequence-detection mechanisms that make freedom sustainable.

Amazon's operational excellence checklist is appropriate for any organization that has experienced incidents caused by missing runbooks, inadequate monitoring, or unplannable rollbacks. Making operational readiness a review gate, rather than a deployment gate, moves the cost of the checklist to where context is freshest. Staff engineers who introduce operational review checklists and track their adoption have data to show that incident-related metrics improved in the quarters after adoption.

---
