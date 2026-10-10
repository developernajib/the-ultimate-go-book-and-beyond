## 85.8 Company Case Studies: Systems Thinking in Practice

### Google: Handling Cascading Failures

Google's infrastructure deals with complex system interactions:

```
GOOGLE CASCADING FAILURE CASE STUDY:

Scenario: Gmail outage from memory leak in dependency

Initial State:
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Gmail     │────►│  Spanner    │────►│  Colossus   │
│   Frontend  │     │  (Database) │     │ (Storage)   │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Quota     │ ◄── Memory leak here
                    │   Service   │
                    └─────────────┘

Cascade Progression:
1. Quota Service memory leak (slow response)
2. Spanner queries to Quota Service timeout
3. Spanner retry storms (3x traffic to Quota)
4. Quota Service completely fails
5. Spanner marks replicas unhealthy
6. Gmail can't check storage quotas
7. Gmail returns errors to users

SYSTEMS THINKING LESSONS:
┌─────────────────────────────────────────────────────────┐
│ 1. Retry storms amplify failures                        │
│    - Without backoff: 3x, 9x, 27x traffic               │
│    - With exponential backoff: linear degradation       │
│                                                         │
│ 2. Health check cascades                                │
│    - If A health-checks B, and B fails, A may be        │
│      incorrectly marked unhealthy                       │
│                                                         │
│ 3. Cross-dependency failures                            │
│    - Gmail doesn't directly depend on Quota Service     │
│    - But fails when Quota fails (hidden dependency)     │
│                                                         │
│ 4. Blast radius                                         │
│    - One service can affect entire product area         │
│    - Need circuit breakers at boundaries                │
└─────────────────────────────────────────────────────────┘

Google's Mitigations:
- Graceful degradation (serve without quota check)
- Circuit breakers with fallback defaults
- Request hedging instead of retry storms
- Regional isolation to limit blast radius
```

### Amazon: Dependency Management at Scale

Amazon's service-oriented architecture requires sophisticated dependency thinking:

```
AMAZON DEPENDENCY MAPPING EXAMPLE:

Order Service Dependencies:

Direct (Hard):
├── OrderDB (DynamoDB) - Required for all operations
├── PaymentService - Required for checkout
└── InventoryService - Required for availability

Direct (Soft):
├── RecommendationService - Graceful degradation OK
├── ReviewService - Can fail without blocking
└── PromotionService - Default to no promotions

Hidden:
├── DNS (Route53) - All services need it
├── IAM - Auth for all AWS calls
├── KMS - Encryption key retrieval
└── CloudWatch - Metrics/logging

DEPENDENCY ANALYSIS:

For each dependency, Amazon asks:
1. What happens if it's unavailable?
2. What happens if it's slow (2x, 10x latency)?
3. What happens if it returns errors?
4. What happens if it returns stale data?
5. What is the retry/timeout strategy?

EXAMPLE: InventoryService Failure Modes

Unavailable:
┌─────────────────────────────────────────────────────────┐
│ Strategy: Fallback to cache                             │
│ TTL: 5 minutes                                          │
│ Risk: May oversell by ~2% during outage                 │
│ Mitigation: Post-outage reconciliation process          │
└─────────────────────────────────────────────────────────┘

Slow (10x latency):
┌─────────────────────────────────────────────────────────┐
│ Strategy: Timeout after 500ms, use cache                │
│ Risk: User sees stale inventory                         │
│ Mitigation: UI indicates "real-time stock may vary"     │
└─────────────────────────────────────────────────────────┘
```

### Netflix: Chaos Engineering and System Resilience

Netflix pioneered chaos engineering for systems thinking:

```
NETFLIX CHAOS ENGINEERING PRINCIPLES:

1. BUILD HYPOTHESIS ABOUT STEADY STATE
   - Define normal behavior metrics
   - Example: "P99 latency < 100ms, error rate < 0.1%"

2. VARY REAL-WORLD EVENTS
   - Server failures
   - Network partitions
   - Dependency slowdowns
   - Resource exhaustion

3. RUN EXPERIMENTS IN PRODUCTION
   - Controlled blast radius
   - Automated rollback
   - During business hours initially

4. AUTOMATE TO RUN CONTINUOUSLY
   - Chaos Monkey: Random instance termination
   - Chaos Kong: Entire region failure
   - Latency Monkey: Artificial delays

EXAMPLE: Content Delivery Failure Test

Hypothesis:
"If 30% of CDN edge servers fail, video start time
 increases by < 20% due to automatic failover"

Experiment:
1. Select 30% of edge servers in region
2. Block traffic to selected servers
3. Measure video start time
4. Duration: 10 minutes

Results:
- Video start time increased 15% (within hypothesis)
- Discovered: One cluster had 50% increase
- Root cause: Misconfigured failover rules
- Fix: Updated failover configuration

SYSTEMS INSIGHT:
The 50% increase in one cluster was due to a second-order
effect: those servers had warm caches for popular content.
When they failed, cold caches caused additional latency.
```

### Uber: Real-Time Systems Interactions

Uber's systems handle complex real-time interactions:

```
UBER SURGE PRICING SYSTEMS ANALYSIS:

System Components:
┌─────────────┐
│   Demand    │ ◄── Ride requests per region
│  Estimator  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Supply    │ ◄── Available drivers per region
│  Estimator  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Surge     │ ◄── Calculates multiplier
│ Calculator  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Pricing   │ ◄── Applies to ride requests
│   Service   │
└─────────────┘

FEEDBACK LOOPS:

Reinforcing Loop (Positive Feedback):
High demand → Surge pricing → Drivers move to area →
More supply → Surge decreases → Drivers leave →
Demand exceeds supply → Surge increases again

This creates oscillation if not dampened!

Balancing Loop (Negative Feedback):
High surge → Fewer ride requests (price sensitive users wait) →
Lower demand → Surge decreases

SYSTEMS THINKING APPLICATION:

Problem: Surge pricing oscillated wildly in some areas

Analysis:
1. Feedback delay: 5-10 min for drivers to respond
2. Demand measurement: Real-time (no delay)
3. Mismatch causes oscillation

Solution: Predictive smoothing
- Don't just use current demand
- Use 15-minute rolling average
- Apply damping factor to changes
- Result: Smooth surge transitions
```

### Stripe: Financial System Correctness

Stripe's systems require absolute correctness:

```
STRIPE LEDGER SYSTEM THINKING:

Invariants That Must Never Break:
1. Money in = Money out (at all times)
2. No double charges
3. No lost refunds
4. Audit trail complete

SYSTEMS APPROACH TO INVARIANTS:

Double-Entry Bookkeeping:
┌──────────────────────────────────────────────────────────┐
│ Every transaction creates TWO entries:                   │
│                                                          │
│ Charge 10,000 cents ($100):                              │
│ - Debit: Merchant Balance (asset)   +10,000 cents ($100) │
│ - Credit: Platform Liability        +10,000 cents ($100) │
│                                                          │
│ Sum of all debits MUST equal sum of all credits          │
│ This is checked every transaction AND daily batch        │
└──────────────────────────────────────────────────────────┘

Idempotency for Correctness:
┌──────────────────────────────────────────────────────────┐
│ Problem: Network retry could double-charge               │
│                                                          │
│ Solution: Idempotency key per charge attempt             │
│                                                          │
│ Request 1: Charge 10,000 cents ($100), key=abc123        │
│   → Process charge, store result                         │
│                                                          │
│ Request 2 (retry): Charge 10,000 cents ($100), key=abc123│
│   → Key exists, return stored result                     │
│   → NO new charge created                                │
│                                                          │
│ Key expiry: 24 hours (covers retry window)               │
└──────────────────────────────────────────────────────────┘

CONSISTENCY VS AVAILABILITY:

Stripe chooses CONSISTENCY over availability

"Better to reject a payment attempt than to
 potentially double-charge a customer"

This means:
- Synchronous writes to ledger
- Strong consistency database
- Accept higher latency for correctness
- Trade throughput for accuracy
```

### Junior → FAANG: Learning from Company Failures, Not Just Successes

The case studies in this section are primarily from failures: Google's cascading failures, Amazon's dependency storms, Netflix's chaos engineering origin story. This is intentional. Systems thinking is best learned from failures because failures make the feedback loops visible in ways that smooth operation does not.

When preparing for your interview, research one well-documented production incident at a company you admire. Read the post-mortem, understand the feedback loops that caused the failure to escalate, and be able to explain what structural change the company made afterward. This kind of informed analysis of a real failure is a strong differentiator in a system design interview.

### Senior @ FAANG: Building Institutional Learning from External Case Studies

At staff level, your job is not just to learn from other companies' failures. It is to make sure your organization learns from them faster than it can rediscover the same failures itself. When a major incident occurs at another company and is publicly post-mortemed, the best staff engineers turn that case study into an internal "could this happen to us?" exercise.

The governance mechanism: establish a regular review cadence (monthly or quarterly) where the team reviews one external post-mortem and explicitly maps it to your own architecture. For each failure mode, answer: do we have the structural conditions for this failure to occur in our system? If yes, what is the mitigation plan? This practice builds systemic resilience proactively rather than reactively.

---
