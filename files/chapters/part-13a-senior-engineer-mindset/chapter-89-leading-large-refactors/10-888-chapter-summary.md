## 89.9 Core Concepts Recap

### Key Takeaways

1. **Refactor for concrete reasons** - Measure the pain, not just feel it
2. **Plan thoroughly** - Scope, risk, strategy, resources, communication
3. **Migrate gradually** - Strangler fig pattern reduces risk
4. **Always have rollback** - Feature flags, dual-write, expand-contract
5. **Monitor obsessively** - Compare old vs new at every step
6. **Coordinate explicitly** - Multi-team work needs structure

### Refactoring Checklist

Use this checklist as a gate before starting any large refactor. Every item should be checked off before you write the first line of migration code. If you cannot check an item, that is a signal that you are not ready to begin and need to do more preparation work first.

- [ ] Concrete problem identified and measured
- [ ] Success criteria defined
- [ ] Migration strategy chosen
- [ ] Rollback plan documented
- [ ] Monitoring in place
- [ ] Stakeholders aligned
- [ ] Team trained
- [ ] Timeline communicated

---

## 89.10 Interview Questions with Detailed Frameworks

### Question 1: "Tell me about a time you led a large-scale refactoring effort. How did you approach it?"

**What interviewers are looking for**:
- Structured approach to planning
- Risk management thinking
- Stakeholder management skills
- Measurable outcomes

**Strong Answer Framework**:

```
"I led a migration of our payment processing system from a monolithic
architecture to microservices. Here's how I approached it:

PHASE 1: DISCOVERY AND JUSTIFICATION (2 weeks)
- Quantified the problem:
  * 47% of production incidents originated from payment code
  * Average change lead time: 3 weeks (should be 3 days)
  * Onboarding new engineers: 6 weeks to make first change
- Calculated ROI: $2.4M annual savings in developer productivity

PHASE 2: PLANNING (2 weeks)
- Chose strangler fig pattern over big-bang rewrite
- Identified 5 bounded contexts to extract
- Created RFC reviewed by 3 teams
- Got stakeholder buy-in with clear milestones

PHASE 3: EXECUTION (6 months)
- Extracted services in order of risk (lowest first):
  1. Payment notifications (read-only, low risk)
  2. Payment history (mostly reads)
  3. Payment authorization (critical, last)
- Each extraction followed pattern:
  * Shadow mode: 2 weeks
  * 5% traffic: 1 week
  * 50% traffic: 2 weeks
  * 100% traffic: 2 weeks
  * Old code deletion: 1 week

PHASE 4: VALIDATION
- Incident rate in payment code: 47% → 12%
- Change lead time: 3 weeks → 4 days
- Developer satisfaction score: 3.2 → 4.1 (out of 5)

KEY DECISIONS:
1. We kept dual-write for 3 months before cutting over
2. Created 'migration buddy' role on each sprint
3. Weekly demo of progress to stakeholders
4. Celebrated each service extraction milestone

WHAT I'D DO DIFFERENTLY:
- Start communication earlier with downstream teams
- Invest in better comparison tooling upfront
- Set harder deadline for old code deletion
"
```

**Key Points to Mention**:
1. "Started with quantifying the problem, not gut feeling"
2. "Used strangler fig to reduce risk"
3. "Gradual rollout with easy rollback"
4. "Measured outcomes against initial goals"
5. "Communicated continuously with stakeholders"

---

### Question 2: "How do you decide whether to refactor or rewrite a legacy system?"

**What interviewers are looking for**:
- Nuanced thinking about trade-offs
- Understanding of when each approach works
- Risk awareness
- Business context consideration

**Strong Answer Framework**:

```
"The decision framework I use considers multiple factors:

FAVOR REFACTORING (Strangler Fig) WHEN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ System is business-critical and can't have extended downtime
✓ You need to maintain feature velocity during migration
✓ The team doesn't fully understand all system behaviors
✓ There are many undocumented integrations and edge cases
✓ Risk tolerance is low
✓ Time to value matters (need incremental wins)

FAVOR REWRITE WHEN:
━━━━━━━━━━━━━━━━━━━━
✓ Technology stack is completely obsolete (no security patches)
✓ Original source code is lost or corrupted
✓ System is small and well-understood
✓ Current architecture fundamentally blocks required changes
✓ You can afford to run both systems in parallel for testing
✓ Team has extensive domain knowledge (not just code knowledge)

THE QUESTIONS I ASK:
1. What happens if we stop midway? (Refactor: partial value delivered.
   Rewrite: likely project failure)

2. How do we know we're done? (Refactor: measurable metrics improve.
   Rewrite: all features replicated... but are we sure?)

3. What's the rollback story? (Refactor: feature flag, instant.
   Rewrite: months of work lost)

4. What's the team morale cost? (Refactor: steady progress.
   Rewrite: marathon of uncertainty)

REAL EXAMPLE:
At [Previous Company], we had a legacy billing system. Initial push was
for rewrite, but when we mapped all integrations, we found 47 different
systems calling it in undocumented ways. Rewrite would have taken 18+
months with high risk of missing behaviors.

Instead, we strangled it over 8 months:
- Month 1-2: Added API gateway in front
- Month 3-4: Extracted customer management
- Month 5-6: Extracted invoicing
- Month 7-8: Extracted payments
- Old system: deleted

Each step delivered immediate value and reduced technical debt
incrementally.
"
```

---

### Question 3: "A refactoring project you're leading is behind schedule. What do you do?"

**What interviewers are looking for**:
- Problem-solving under pressure
- Communication skills
- Prioritization ability
- Leadership in difficult situations

**Strong Answer Framework**:

```
"First, I'd diagnose why we're behind, then adjust accordingly:

STEP 1: UNDERSTAND THE GAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- How far behind are we? (days vs weeks vs months)
- What's causing the delay?
  * Scope creep?
  * Unexpected complexity?
  * Resource issues?
  * External dependencies?
- Is the delay in the critical path?

STEP 2: ASSESS OPTIONS
━━━━━━━━━━━━━━━━━━━━━━━
Option A: Reduce Scope
- What's the minimum viable migration?
- Can we defer some components to a second phase?
- Does the 80/20 rule apply?

Option B: Extend Timeline
- What's the impact of delay?
- Are there downstream dependencies?
- What does 'on time' really mean for this project?

Option C: Add Resources
- Will more people help or hurt? (Brook's Law)
- Are there specific skills we're missing?
- Can we parallelize work that's currently sequential?

Option D: Accept Technical Debt
- Can we ship with known limitations?
- What's the cost of cleaning up later?

STEP 3: COMMUNICATE EARLY
━━━━━━━━━━━━━━━━━━━━━━━━━━
- Update stakeholders immediately
- Provide revised timeline with confidence level
- Explain trade-offs and recommendations
- Ask for input on priorities

STEP 4: ADJUST THE PLAN
━━━━━━━━━━━━━━━━━━━━━━━━
- Break remaining work into smaller milestones
- Increase check-in frequency
- Add explicit risk buffers
- Consider feature flags for partial delivery

REAL EXAMPLE:
Mid-migration of our search system, we discovered the new system
couldn't handle a query pattern we didn't know existed (historical
analytics queries). We were 3 weeks behind.

What we did:
1. Identified this was 5% of traffic but complex to fix properly
2. Proposed: Complete migration for 95% of use cases now,
   keep old system for analytics queries temporarily
3. Got buy-in from product (analytics could wait 1 quarter)
4. Delivered main migration on original timeline
5. Fixed analytics support in subsequent quarter

Key: We didn't hide the delay. We presented options with trade-offs
and let leadership choose priorities.
"
```

---

### Question 4: "How do you handle resistance from team members who don't want to do the refactoring work?"

**What interviewers are looking for**:
- Emotional intelligence
- Ability to influence without authority
- Understanding of motivation
- Practical conflict resolution

**Strong Answer Framework**:

```
"Resistance to refactoring usually comes from valid concerns. I address
the underlying reasons:

COMMON RESISTANCE PATTERNS AND RESPONSES:

1. 'This is boring work, I want to build features'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Make the impact visible: 'This migration will reduce incidents 50%'
- Connect to career growth: 'Leading this migration is Staff-level work'
- Create interesting challenges: 'How do we migrate with zero downtime?'
- Mix with feature work: Don't make anyone 100% migration duty

2. 'The old system is fine, why change?'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Show the data: incident rates, change lead times, developer surveys
- Have them experience the pain: 'Try adding this feature to old system'
- Listen to their concerns: Maybe they know something you don't
- Involve them in solution design

3. 'This will never finish, it's too big'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Break into visible milestones with celebrations
- Show incremental progress in every sprint
- Share examples of similar successful migrations
- Start with quick wins to build momentum

4. 'I don't understand the new system well enough'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Invest in training and pairing
- Create good documentation
- Assign 'migration buddies'
- Make it safe to ask questions

TECHNIQUES I USE:
- 1:1s to understand individual concerns
- Involve skeptics in planning (turns critics into advocates)
- Recognize migration work in perf reviews explicitly
- Create 'migration champion' role that rotates
- Make progress visible with dashboards and celebrations

REAL EXAMPLE:
Senior engineer refused to work on database migration. In 1:1, learned
they'd been burned by a failed migration at previous company that ended
in weekend firefighting.

Solution: We paired on the rollback testing together. They saw our
approach was more cautious. They became the biggest advocate for the
migration because they trusted the safety measures.

Key insight: Resistance is usually fear in disguise. Address the fear,
not the resistance.
"
```

---

## Exercises

### Exercise 1: Migration Plan Template

**Problem**: Create a complete migration plan for extracting a user authentication service from a monolithic application.

**Solution**:

````markdown
# Migration Plan: User Authentication Service Extraction

## 1. Executive Summary

### Current State
- Authentication logic embedded in monolith
- Mixed with session management, user profiles, and authorization
- 15,000 lines of code, 8 years of accumulated logic
- 23% of production incidents involve auth code

### Target State
- Standalone authentication microservice
- Clear API boundary
- Dedicated team ownership
- Support for modern auth protocols (OAuth2, OIDC)

### Success Criteria
- Zero authentication-related incidents during migration
- P99 latency unchanged or improved
- Reduce auth-related incidents by 50%
- Enable SSO implementation (blocked by current architecture)

## 2. Scope Definition

### In Scope
- User login/logout functionality
- Password reset flow
- Session management
- Token generation and validation
- MFA (existing TOTP implementation)

### Out of Scope (Phase 1)
- User registration (kept in monolith)
- Profile management (kept in monolith)
- Authorization/permissions (separate project)
- OAuth provider integration (Phase 2)

### Dependencies
- User database: will remain shared initially
- Session store: new Redis cluster
- Notification service: existing, no changes

## 3. Migration Strategy

### Approach: Strangler Fig with Shadow Traffic

The strangler fig pattern avoids the coordination risk of a big-bang cutover by keeping the old auth path fully operational while the new service is proven in production. Shadow mode (weeks 3 to 4) is the critical safety net: every real auth request is mirrored to the new service and its response is compared against the monolith's, surfacing correctness bugs before any real user is affected by them.

```
Week 1-2:   [Setup]     Deploy new service, route 0% traffic
Week 3-4:   [Shadow]    Mirror all auth requests to new service
                        Compare results, log discrepancies
Week 5:     [Canary]    Route 1% of traffic to new service
Week 6:     [Expand]    Route 10% of traffic
Week 7-8:   [Expand]    Route 50% of traffic
Week 9-10:  [Full]      Route 100% of traffic
Week 11-12: [Cleanup]   Remove auth code from monolith
```

## 4. Technical Design

### Architecture

The key constraint in this design is that the shared PostgreSQL database requires no schema changes during extraction. The Auth Service and the monolith read from the same tables simultaneously. The API Gateway routes exclusively on URL prefix (`/auth/*`), so the two services are never aware of each other, which eliminates the need for cross-service calls or shared libraries during the transition period.

```
┌─────────────────────────────────────────────────────────────┐
│                        API Gateway                           │
│  (Routes /auth/* to new service, everything else to monolith)│
└────────────────────────────┬────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Auth Service  │  │    Monolith     │  │  Other Services │
│   (new)         │  │   (existing)    │  │                 │
└────────┬────────┘  └────────┬────────┘  └─────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────────────────────────────────────────────────┐
│                   Shared User Database                       │
│                (PostgreSQL, no schema changes)               │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Redis Cluster  │
│  (sessions)     │
└─────────────────┘
```

### API Contract

Defining the `AuthService` interface before writing any implementation enforces the Dependency Inversion Principle: the monolith's internal code depends on this abstraction, not on a concrete HTTP client. This means the monolith can be tested against a fake implementation during the migration, and the interface itself becomes the acceptance criteria that the new service must satisfy.

```go
// Auth Service API
type AuthService interface {
    // Login validates credentials and returns session
    Login(ctx context.Context, req *LoginRequest) (*LoginResponse, error)

    // Logout invalidates session
    Logout(ctx context.Context, sessionToken string) error

    // ValidateSession checks if session is valid
    ValidateSession(ctx context.Context, token string) (*Session, error)

    // RefreshSession extends session expiry
    RefreshSession(ctx context.Context, token string) (*Session, error)

    // InitPasswordReset starts password reset flow
    InitPasswordReset(ctx context.Context, email string) error

    // CompletePasswordReset finishes password reset
    CompletePasswordReset(ctx context.Context, req *PasswordResetRequest) error
}
```

#### 5. Rollback Plan

### Rollback Triggers
- Error rate > 5% on auth endpoints
- P99 latency > 500ms (baseline: 200ms)
- Any data consistency issues detected
- Critical security vulnerability discovered

### Rollback Procedure

Because both services share the same underlying database during the migration window, rolling back requires no data migration. Flipping a single feature flag is sufficient to redirect 100% of traffic back to the monolith in under five minutes. The three-phase structure separates the immediate traffic fix from the slower diagnostic work, ensuring on-call engineers are not blocked from stabilizing production while the root cause is still unknown.

```
1. IMMEDIATE (< 5 minutes):
   - Set feature flag AUTH_USE_NEW_SERVICE=false
   - All traffic routes to monolith immediately
   - No data migration needed (shared database)

2. VALIDATION (next 30 minutes):
   - Verify auth flows working on monolith
   - Check error rates returning to baseline
   - Notify on-call that rollback occurred

3. INVESTIGATION:
   - Review logs for root cause
   - Create incident ticket
   - Plan fix and re-rollout
```

### Rollback Testing
- Tested rollback in staging: Week 2
- Tested rollback in production (1% traffic): Week 5
- Documented rollback runbook: Week 1

#### 6. Monitoring and Alerting

### Key Metrics

Tracking `auth_comparison_mismatches_total` alongside the standard latency and error-rate counters is what makes shadow mode actionable: a non-zero mismatch rate during weeks 3 to 4 indicates the new service is producing different tokens or session state, a correctness bug that would be invisible to infrastructure monitoring alone. The two alert rules enforce separate response-time SLOs (critical on error rate with a 2-minute burn versus warning on p99 latency with a 5-minute burn), reflecting that an auth outage is more damaging than a slowdown.

```yaml
# Prometheus metrics to add
auth_login_total: Counter of login attempts (status: success/failure)
auth_login_duration_seconds: Histogram of login latency
auth_session_validations_total: Counter of session checks
auth_comparison_mismatches_total: Counter of shadow mode mismatches

# Alerts
- name: AuthServiceHighErrorRate
  expr: rate(auth_login_total{status="failure"}[5m]) > 0.05
  for: 2m
  labels:
    severity: critical

- name: AuthServiceHighLatency
  expr: histogram_quantile(0.99, rate(auth_login_duration_seconds_bucket[5m])) > 0.5
  for: 5m
  labels:
    severity: warning
```

### Dashboard
- Side-by-side comparison: old vs new latency, error rates
- Migration progress: % traffic on new service
- Shadow mode mismatches: count and details
- Session validation rates

#### 7. Timeline and Milestones

| Week | Milestone | Deliverable | Success Criteria |
|------|-----------|-------------|------------------|
| 1 | Kickoff | RFC approved, team assigned | Stakeholder sign-off |
| 2 | Infrastructure | New service deployed | Health check passing |
| 3-4 | Shadow Mode | Comparison running | <0.1% mismatch rate |
| 5 | Canary (1%) | Real traffic flowing | No alerts triggered |
| 6 | Expansion (10%) | Increased traffic | Error rate same as baseline |
| 7-8 | Expansion (50%) | Half traffic | Performance validated |
| 9-10 | Full Migration | 100% traffic | All tests passing |
| 11-12 | Cleanup | Old code removed | Monolith simplified |

#### 8. Communication Plan

### Stakeholders
- Engineering: Weekly updates in #auth-migration
- Security: Review at weeks 2, 6, 10
- Product: Milestone updates, any user-facing changes
- Support: Runbook updates, training on new flows

### Communication Schedule
- Daily: Team standup (15 min)
- Weekly: Progress update (email + Slack)
- Bi-weekly: Demo to stakeholders
- At each phase: Go/no-go decision meeting

#### 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Shadow mode reveals hidden behaviors | High | Medium | Extra shadow period, detailed logging |
| Session migration causes logouts | Medium | High | Shared session store, token compatibility |
| Performance regression | Low | High | Load testing, gradual rollout |
| MFA edge cases break | Medium | High | Extensive test suite, beta tester group |
| Team pulled for urgent work | Medium | Medium | 20% buffer in timeline |

#### 10. Success Metrics (3 months post-migration)

- Auth-related incidents: 23% → <12%
- Time to deploy auth change: 2 weeks → 2 days
- Auth service availability: >99.95%
- SSO integration: Enabled (was blocked)
````

---

### Exercise 2: Strangler Fig Implementation

**Problem**: Implement a production-ready strangler fig router with shadow traffic comparison.

**Solution**:

```go
// pkg/strangler/strangler.go
package strangler

import (
    "context"
    "encoding/json"
    "fmt"
    "hash/fnv"
    "log/slog"
    "math/rand/v2"
    "sync"
    "sync/atomic"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// Service represents a backend service that can handle requests
type Service interface {
    Handle(ctx context.Context, req *Request) (*Response, error)
    Name() string
}

// Request represents a generic request
type Request struct {
    ID     string
    UserID string
    Method string
    Path   string
    Body   []byte
}

// Response represents a generic response
type Response struct {
    StatusCode int
    Body       []byte
    Headers    map[string]string
}

// Config holds the strangler configuration
type Config struct {
    // NewServicePercentage: 0-100, percentage of traffic to new service
    NewServicePercentage int

    // UseStickyRouting: if true, same user always goes to same service
    UseStickyRouting bool

    // EnableShadowMode: if true, run both services and compare
    EnableShadowMode bool

    // ShadowCompareResponses: if true, compare response bodies
    ShadowCompareResponses bool

    // ShadowTimeout: timeout for shadow requests (shouldn't block main)
    ShadowTimeout time.Duration
}

// StranglerRouter routes traffic between old and new services
type StranglerRouter struct {
    old     Service
    new     Service
    config  atomic.Value // *Config
    metrics *stranglerMetrics

    comparator ResponseComparator
    logger     *slog.Logger
}

type stranglerMetrics struct {
    requestsTotal      *prometheus.CounterVec
    requestDuration    *prometheus.HistogramVec
    shadowMismatches   prometheus.Counter
    shadowComparisons  prometheus.Counter
    currentPercentage  prometheus.Gauge
}

// ResponseComparator compares responses from old and new services
type ResponseComparator func(old, new *Response, req *Request) bool

// NewStranglerRouter creates a new router
func NewStranglerRouter(old, new Service, cfg *Config, logger *slog.Logger) *StranglerRouter {
    r := &StranglerRouter{
        old:    old,
        new:    new,
        logger: logger,
        metrics: &stranglerMetrics{
            requestsTotal: promauto.NewCounterVec(
                prometheus.CounterOpts{
                    Name: "strangler_requests_total",
                    Help: "Total requests handled by strangler router",
                },
                []string{"service", "status"},
            ),
            requestDuration: promauto.NewHistogramVec(
                prometheus.HistogramOpts{
                    Name:    "strangler_request_duration_seconds",
                    Help:    "Request duration by service",
                    Buckets: prometheus.DefBuckets,
                },
                []string{"service"},
            ),
            shadowMismatches: promauto.NewCounter(prometheus.CounterOpts{
                Name: "strangler_shadow_mismatches_total",
                Help: "Total shadow mode response mismatches",
            }),
            shadowComparisons: promauto.NewCounter(prometheus.CounterOpts{
                Name: "strangler_shadow_comparisons_total",
                Help: "Total shadow mode comparisons",
            }),
            currentPercentage: promauto.NewGauge(prometheus.GaugeOpts{
                Name: "strangler_new_service_percentage",
                Help: "Current percentage of traffic to new service",
            }),
        },
        comparator: defaultComparator,
    }

    r.SetConfig(cfg)
    return r
}

// SetConfig updates the router configuration (safe for concurrent use)
func (r *StranglerRouter) SetConfig(cfg *Config) {
    r.config.Store(cfg)
    r.metrics.currentPercentage.Set(float64(cfg.NewServicePercentage))
    r.logger.Info("strangler config updated",
        "percentage", cfg.NewServicePercentage,
        "sticky", cfg.UseStickyRouting,
        "shadow", cfg.EnableShadowMode,
    )
}

// GetConfig returns current configuration
func (r *StranglerRouter) GetConfig() *Config {
    return r.config.Load().(*Config)
}

// Handle routes the request to appropriate service
func (r *StranglerRouter) Handle(ctx context.Context, req *Request) (*Response, error) {
    cfg := r.GetConfig()

    // Shadow mode: run both, return from primary
    if cfg.EnableShadowMode {
        return r.handleShadow(ctx, req, cfg)
    }

    // Normal routing
    return r.handleNormal(ctx, req, cfg)
}

func (r *StranglerRouter) handleNormal(ctx context.Context, req *Request, cfg *Config) (*Response, error) {
    useNew := r.shouldUseNew(req, cfg)

    var service Service
    if useNew {
        service = r.new
    } else {
        service = r.old
    }

    start := time.Now()
    resp, err := service.Handle(ctx, req)
    duration := time.Since(start)

    // Record metrics
    status := "success"
    if err != nil {
        status = "error"
    }
    r.metrics.requestsTotal.WithLabelValues(service.Name(), status).Inc()
    r.metrics.requestDuration.WithLabelValues(service.Name()).Observe(duration.Seconds())

    return resp, err
}

func (r *StranglerRouter) handleShadow(ctx context.Context, req *Request, cfg *Config) (*Response, error) {
    // Always return from old service in shadow mode
    var (
        oldResp, newResp *Response
        oldErr, newErr   error
        wg               sync.WaitGroup
    )

    // Run old service (blocking, primary)
    start := time.Now()
    oldResp, oldErr = r.old.Handle(ctx, req)
    oldDuration := time.Since(start)

    r.metrics.requestsTotal.WithLabelValues(r.old.Name(), statusLabel(oldErr)).Inc()
    r.metrics.requestDuration.WithLabelValues(r.old.Name()).Observe(oldDuration.Seconds())

    // Run new service in background (non-blocking)
    wg.Add(1)
    go func() {
        defer wg.Done()

        // Use separate context with timeout
        shadowCtx, cancel := context.WithTimeout(context.Background(), cfg.ShadowTimeout)
        defer cancel()

        start := time.Now()
        newResp, newErr = r.new.Handle(shadowCtx, req)
        newDuration := time.Since(start)

        r.metrics.requestsTotal.WithLabelValues(r.new.Name(), statusLabel(newErr)).Inc()
        r.metrics.requestDuration.WithLabelValues(r.new.Name()).Observe(newDuration.Seconds())

        // Compare if configured
        if cfg.ShadowCompareResponses && oldErr == nil && newErr == nil {
            r.compareResponses(req, oldResp, newResp)
        }
    }()

    // Don't wait for shadow - return immediately
    return oldResp, oldErr
}

func (r *StranglerRouter) compareResponses(req *Request, old, new *Response) {
    r.metrics.shadowComparisons.Inc()

    if !r.comparator(old, new, req) {
        r.metrics.shadowMismatches.Inc()
        r.logger.Warn("shadow mode response mismatch",
            "request_id", req.ID,
            "path", req.Path,
            "old_status", old.StatusCode,
            "new_status", new.StatusCode,
        )
    }
}

func (r *StranglerRouter) shouldUseNew(req *Request, cfg *Config) bool {
    if cfg.NewServicePercentage == 0 {
        return false
    }
    if cfg.NewServicePercentage >= 100 {
        return true
    }

    if cfg.UseStickyRouting && req.UserID != "" {
        // Consistent hash based on user ID
        h := fnv.New32a()
        h.Write([]byte(req.UserID))
        hash := h.Sum32()
        return int(hash%100) < cfg.NewServicePercentage
    }

    // Random routing
    return rand.IntN(100) < cfg.NewServicePercentage
}

func defaultComparator(old, new *Response, req *Request) bool {
    // Compare status codes
    if old.StatusCode != new.StatusCode {
        return false
    }

    // Compare body (if both are JSON, do semantic comparison)
    if isJSON(old.Body) && isJSON(new.Body) {
        return jsonEqual(old.Body, new.Body)
    }

    // Binary comparison for non-JSON
    return string(old.Body) == string(new.Body)
}

func isJSON(data []byte) bool {
    var js json.RawMessage
    return json.Unmarshal(data, &js) == nil
}

func jsonEqual(a, b []byte) bool {
    var ja, jb any
    if err := json.Unmarshal(a, &ja); err != nil {
        return false
    }
    if err := json.Unmarshal(b, &jb); err != nil {
        return false
    }

    // Normalize and compare
    na, _ := json.Marshal(ja)
    nb, _ := json.Marshal(jb)
    return string(na) == string(nb)
}

func statusLabel(err error) string {
    if err != nil {
        return "error"
    }
    return "success"
}

// SetComparator allows custom response comparison logic
func (r *StranglerRouter) SetComparator(c ResponseComparator) {
    r.comparator = c
}

type LegacyAuthService struct{}

func (s *LegacyAuthService) Handle(ctx context.Context, req *Request) (*Response, error) {
    return &Response{StatusCode: 200}, nil
}

func (s *LegacyAuthService) Name() string { return "legacy-auth" }

type ModernAuthService struct{}

func (s *ModernAuthService) Handle(ctx context.Context, req *Request) (*Response, error) {
    return &Response{StatusCode: 200}, nil
}

func (s *ModernAuthService) Name() string { return "modern-auth" }

// Example usage
func Example() {
    logger := slog.Default()

    oldService := &LegacyAuthService{}
    newService := &ModernAuthService{}

    cfg := &Config{
        NewServicePercentage:   0,  // Start at 0%
        UseStickyRouting:       true,
        EnableShadowMode:       true,
        ShadowCompareResponses: true,
        ShadowTimeout:          5 * time.Second,
    }

    router := NewStranglerRouter(oldService, newService, cfg, logger)
    _ = router

    // Phase 1: Shadow mode (compare results)
    // Watch metrics for mismatches

    // Phase 2: Canary (1%)
    router.SetConfig(&Config{
        NewServicePercentage: 1,
        UseStickyRouting:     true,
        EnableShadowMode:     false,
    })

    // Phase 3: Expand gradually
    for _, pct := range []int{5, 10, 25, 50, 75, 100} {
        // Wait for metrics to stabilize, then increase
        router.SetConfig(&Config{
            NewServicePercentage: pct,
            UseStickyRouting:     true,
        })
        // time.Sleep(1 * 24 * time.Hour) // Wait a day between increases
    }
}
```

---

### Exercise 3: Risk Assessment Matrix

**Problem**: Create a thorough risk assessment for migrating a payment processing system.

**Solution**:

````markdown
# Risk Assessment: Payment System Migration

## Risk Matrix Key
- **Likelihood**: Very Low (1), Low (2), Medium (3), High (4), Very High (5)
- **Impact**: Very Low (1), Low (2), Medium (3), High (4), Critical (5)
- **Risk Score**: Likelihood × Impact (1-25)

## Detailed Risk Assessment

### Technical Risks

| ID | Risk | L | I | Score | Mitigation | Owner |
|----|------|---|---|-------|------------|-------|
| T1 | Data loss during migration | 2 | 5 | 10 | Dual-write pattern, backups before each phase, audit trail comparison | DBA Lead |
| T2 | Race conditions in dual-write | 3 | 4 | 12 | Idempotency keys, transaction ordering, extensive testing | Tech Lead |
| T3 | Hidden payment flows not migrated | 4 | 4 | 16 | Traffic analysis, shadow mode, extended canary period | Senior Eng |
| T4 | Performance degradation | 3 | 4 | 12 | Load testing, gradual rollout, instant rollback | SRE |
| T5 | Third-party payment provider incompatibility | 2 | 4 | 8 | Provider-specific testing, sandbox validation | Integration Eng |
| T6 | Session/state handling differences | 3 | 3 | 9 | State comparison in shadow mode, explicit state testing | Backend Eng |
| T7 | Currency/rounding differences | 2 | 5 | 10 | Financial reconciliation tests, penny-level comparison | QA Lead |

### Operational Risks

| ID | Risk | L | I | Score | Mitigation | Owner |
|----|------|---|---|-------|------------|-------|
| O1 | Extended incident during migration | 3 | 4 | 12 | Rollback under 5 minutes, dedicated on-call | SRE Lead |
| O2 | Support team not trained on new system | 4 | 3 | 12 | Training sessions, updated runbooks, shadow support | Support Lead |
| O3 | Monitoring gaps miss issues | 3 | 4 | 12 | Side-by-side dashboards, alert parity | SRE |
| O4 | Rollback doesn't work as expected | 2 | 5 | 10 | Test rollback at each phase, runbook validation | Tech Lead |

### Business Risks

| ID | Risk | L | I | Score | Mitigation | Owner |
|----|------|---|---|-------|------------|-------|
| B1 | Revenue impact from payment failures | 2 | 5 | 10 | Business hours rollout, manual fallback process | Product Lead |
| B2 | Compliance/audit concerns | 2 | 4 | 8 | Pre-migration compliance review, audit trail | Compliance |
| B3 | Customer complaints during migration | 3 | 3 | 9 | Customer communication, support script | Customer Success |
| B4 | Partner/merchant impact | 3 | 4 | 12 | Partner notification, sandbox access for testing | Partnership |

### Project Risks

| ID | Risk | L | I | Score | Mitigation | Owner |
|----|------|---|---|-------|------------|-------|
| P1 | Team pulled for urgent P0 | 4 | 3 | 12 | 20% timeline buffer, clear escalation path | Engineering Manager |
| P2 | Scope creep extends timeline | 3 | 3 | 9 | Strict scope document, change control process | Product Manager |
| P3 | Key person leaves during migration | 2 | 4 | 8 | Knowledge sharing, documentation, pair programming | Tech Lead |
| P4 | Dependencies on other teams delayed | 3 | 3 | 9 | Early dependency mapping, regular sync | Project Manager |

## High-Risk Items (Score >= 12) - Detailed Plans

### T3: Hidden Payment Flows (Score: 16)

**Scenario**: Payment flows exist that are not documented and won't be
migrated, causing payment failures for subset of customers.

**Detection Strategy**:
1. Run shadow mode for 4+ weeks covering full billing cycle
2. Log all payment paths with request signatures
3. Compare request patterns between old and new service
4. Review error logs for "unknown" or "unexpected" patterns

**Mitigation Plan**:
1. Week 1-2: Deploy detailed logging to old system
2. Week 3-6: Analyze all payment paths, document undiscovered flows
3. Week 7-8: Implement discovered flows in new system
4. Week 9-12: Extended shadow mode to verify completeness

**Contingency**:
- Keep old system available for manual fallback
- Create runbook for routing specific merchants to old system
- Define criteria for emergency rollback

### T2: Race Conditions in Dual-Write (Score: 12)

**Scenario**: During dual-write phase, race conditions cause payment
state inconsistency between old and new systems.

**Detection Strategy**:
1. Idempotency key validation on both systems
2. Periodic reconciliation comparing payment states
3. Alert on any discrepancy

**Mitigation Plan**:
1. Implement idempotency keys before migration starts
2. Use transaction IDs that guarantee ordering
3. Build reconciliation tool that runs every 5 minutes
4. Auto-pause migration if discrepancies detected

**Contingency**:
- Stop dual-write, single-write to primary only
- Replay from primary to secondary when fixed
- Manual reconciliation process documented

## Risk Monitoring Dashboard

A risk monitoring dashboard translates abstract migration concerns into concrete, measurable thresholds. Rather than reacting to user complaints after something goes wrong, you define ahead of time exactly what "wrong" looks like, whether that is a drop in payment success rate, a latency spike, or a divergence between the old and new data paths. Each metric has a baseline, an alert threshold, and a predetermined action, which eliminates ambiguity during an incident and empowers the on-call engineer to act without escalating for approval.

```yaml
# Key metrics to track
Payment Success Rate:
  - Baseline: 99.2%
  - Alert if: <98.5%
  - Action: Page on-call, consider rollback

Payment Latency (P99):
  - Baseline: 450ms
  - Alert if: >750ms
  - Action: Investigate, pause rollout

Dual-Write Discrepancy Rate:
  - Target: 0%
  - Alert if: >0.01%
  - Action: Stop migration, investigate

Shadow Mode Mismatch Rate:
  - Target: <0.1%
  - Alert if: >0.5%
  - Action: Investigate mismatches before proceeding
```

#### Go/No-Go Criteria for Each Phase

| Phase | Criteria | Threshold |
|-------|----------|-----------|
| Shadow → 1% | Shadow mismatch rate | <0.1% |
| 1% → 10% | Error rate | Same as old ±0.1% |
| 10% → 50% | Error rate + latency | P99 within 10% of old |
| 50% → 100% | All metrics stable for 1 week | No regression |
| 100% → Cleanup | All metrics stable for 2 weeks | Stakeholder sign-off |

#### Emergency Contacts

| Role | Name | Phone | When to Contact |
|------|------|-------|-----------------|
| Tech Lead | [Name] | [Phone] | Technical issues |
| SRE Lead | [Name] | [Phone] | Operational issues |
| Product Lead | [Name] | [Phone] | Business impact decisions |
| VP Engineering | [Name] | [Phone] | Major escalations |
````

---

## Summary

Leading a large refactor is fundamentally an exercise in risk management and communication, not just technical skill. The most successful refactors share common traits: they start with measured pain, use incremental migration patterns, maintain rollback capability at every step, and communicate progress obsessively to all stakeholders.

### Refactoring Decision Checklist

The table below contrasts strong answers with weak ones for the five critical questions every refactor proposal must address. If your answers look more like the "Bad Answer" column, go back and do more preparation before proposing the refactor.

| Question | Good Answer | Bad Answer |
|----------|------------|------------|
| What problem are we solving? | "Incidents down 50%, velocity up 3x" | "Code is messy" |
| How do we measure success? | "Error rate, lead time, NPS" | "We'll know when we see it" |
| What's the rollback plan? | "Feature flag, instant switch" | "Restore from backup" |
| Who's impacted? | "Teams A, B, C - all informed" | "Just us" |
| What's the timeline? | "3 months, 4 milestones" | "Until it's done" |

### Migration Pattern Quick Reference

This table summarizes the five migration patterns covered in this chapter. When choosing a pattern, consider the size and criticality of the system, whether you can afford downtime, and how much confidence you need before cutting over. For most production systems, the strangler fig or feature flag approach is the safest choice.

| Pattern | When to Use | Risk Level |
|---------|------------|------------|
| Big Bang | Small, isolated systems | High |
| Strangler Fig | Large, critical systems | Low |
| Parallel Run | Data-critical migrations | Medium |
| Feature Flags | User-facing changes | Low |
| Branch by Abstraction | Deep codebase changes | Medium |

---

**Next Chapter: Staff Engineer Playbook** - We'll provide a practical guide to operating as a Staff Engineer, including common challenges and how to navigate them.

### Junior → FAANG: Using the Checklist Before Your Interview

The refactoring checklist in this summary is a scoring rubric for your own interview stories. Before your interview, evaluate your best refactoring example against it. If your story is missing a rollback plan, a success criterion, or evidence of stakeholder alignment, strengthen the story before you tell it. Interviewers use mental checklists very similar to this one when evaluating your answer.

### Senior @ FAANG: The Summary as an Org-Wide Checklist

At L6, this checklist should live in your org's engineering handbook as a required gate before any migration larger than one team can begin. The key governance addition at staff level is adding an approval step: migrations above a certain scope (more than two teams affected, more than one quarter in duration) require sign-off from a technical lead outside the executing team. This prevents the local optimization of a migration plan that looks reasonable within one team but has unconsidered blast radius for adjacent systems.

The migration pattern quick reference table is a decision framework, not a mandate. Staff engineers document the decision criteria explicitly: what signals make you choose strangler fig over feature flags, and who makes that call. When the criteria are written down and the decision is recorded in an ADR, you have created a learning artifact that improves your org's next migration decision even if you are not involved.

---
