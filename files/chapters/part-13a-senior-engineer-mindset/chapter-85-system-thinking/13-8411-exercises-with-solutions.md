## Exercises

### Exercise 1: System Mapping Exercise

**Task**: Map the following system and identify feedback loops, dependencies, and potential emergent behaviors.

**Scenario**: An e-commerce checkout system with:
- User Service (authentication)
- Cart Service (shopping cart)
- Inventory Service (stock levels)
- Payment Service (process payments)
- Order Service (create orders)
- Notification Service (send confirmations)
- All services use a shared Redis cache

**Solution**:

```
# System Map: E-Commerce Checkout

┌──────────────────────────────────────────────────────────────────┐
│                     CHECKOUT FLOW                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐                                                 │
│  │   Client    │                                                 │
│  └──────┬──────┘                                                 │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐      ┌─────────────┐                            │
│  │    User     │◄────►│   Redis     │◄──── Shared Dependency     │
│  │   Service   │      │   Cache     │                            │
│  └──────┬──────┘      └─────────────┘                            │
│         │                    ▲                                   │
│         │                    │                                   │
│         ▼                    │                                   │
│  ┌─────────────┐            │                                    │
│  │    Cart     │────────────┘                                    │
│  │   Service   │                                                 │
│  └──────┬──────┘                                                 │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐      ┌─────────────┐                            │
│  │  Inventory  │─────►│  Inventory  │                            │
│  │   Service   │      │     DB      │                            │
│  └──────┬──────┘      └─────────────┘                            │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐      ┌─────────────┐                            │
│  │   Payment   │─────►│  Payment    │                            │
│  │   Service   │      │   Gateway   │◄──── External Dependency   │
│  └──────┬──────┘      └─────────────┘                            │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                                                 │
│  │    Order    │                                                 │
│  │   Service   │                                                 │
│  └──────┬──────┘                                                 │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                                                 │
│  │ Notification│──────► Email/SMS                                │
│  │   Service   │                                                 │
│  └─────────────┘                                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

## Dependencies

HARD DEPENDENCIES (Checkout fails without these):
- User Service → Cannot authenticate
- Inventory Service → Cannot verify stock
- Payment Service → Cannot process payment
- Order Service → Cannot create order
- Redis Cache → Cache miss falls through to DB, degraded perf

SOFT DEPENDENCIES (Checkout continues without these):
- Notification Service → Order succeeds, notification async
- Email/SMS providers → Can retry later

HIDDEN DEPENDENCIES:
- DNS → All services need it
- Redis → Shared across services (single point)
- Clock synchronization → Distributed timestamps

## Feedback Loops

REINFORCING LOOP 1 (Negative - Death Spiral):
Redis slow → All services slow → Users retry →
More load on Redis → Redis slower → ...

Mitigation: Circuit breaker on Redis, fallback to direct DB

REINFORCING LOOP 2 (Positive - Thundering Herd):
Service recovers → All cached items expired →
Everyone hits DB → DB overwhelmed → Service down again

Mitigation: Staggered cache expiry, jittered refresh

BALANCING LOOP:
Rate limiter on Payment Gateway →
Too many requests → Reject some → Fewer requests →
Gateway recovers → Accept again

## Emergent Behaviors

1. CORRELATED FAILURE
   - All services use Redis
   - Redis failure = Total system failure
   - Individual services are resilient, system is not

2. INVENTORY OVERSELLING
   - Under high load, inventory checks may use stale cache
   - Multiple orders for last item
   - Need: Distributed lock or optimistic locking

3. PAYMENT RETRY STORM
   - Payment timeout → User retries → Multiple charges
   - Need: Idempotency keys per checkout session

4. NOTIFICATION BACKLOG
   - Order surge → Notification queue grows
   - Users don't receive confirmations
   - Support tickets spike → More load on system
```

---

### Exercise 2: Second-Order Effects Analysis

**Task**: A team proposes adding a feature flag system to enable gradual rollouts. Analyze the second and third-order effects.

**Solution**:

```markdown
# Second-Order Effects: Feature Flag System

## DECISION: Add Feature Flag System

## First-Order Effects (Immediate, Intended)
+ Gradual feature rollouts (5%, 25%, 50%, 100%)
+ Instant rollback capability
+ A/B testing capability
+ Reduced deployment risk

## Second-Order Effects (Weeks)

POSITIVE:
+ Teams ship more frequently (confidence from rollback)
+ Faster feedback on new features
+ Product can run experiments easily
+ Reduced incident severity (quick rollback)

NEGATIVE:
- Code complexity increases (if flag then X else Y)
- Testing matrix explodes (all flag combinations)
- Tech debt: Old flags never removed
- "Permanent" flags replace proper feature design
- Flag service becomes critical dependency
- Teams use flags instead of fixing bugs properly

## Third-Order Effects (Months)

POSITIVE:
+ Culture shift toward experimentation
+ Data-driven product decisions
+ Faster time to market
+ Customer trust improves (fewer bad releases)

NEGATIVE:
- Flag spaghetti: Complex interactions between flags
- Flag service incidents cause widespread issues
- Security risks: Flags expose unreleased features
- Performance cost of flag evaluation on every request
- Organizational dysfunction: Arguments about flag ownership
- Technical debt crisis: Hundreds of abandoned flags

## Fourth-Order Effects (Years)

POSITIVE:
+ Organization becomes more agile
+ Competitive advantage from faster iteration

NEGATIVE:
- Major refactor needed to clean up flag debt
- System becomes harder to reason about
- Junior engineers confused by multiple code paths
- Incidents become harder to debug (which flags were on?)

## Mitigations

| Risk | Mitigation |
|------|------------|
| Flag spaghetti | Max flag lifetime (30 days default) |
| Testing explosion | Test most common flag combinations |
| Performance | Cache flag evaluations, batch reads |
| Critical dependency | Flag system has fallback defaults |
| Abandoned flags | Automated alerts for old flags |
| Security | Audit flag access, no sensitive data |

## Systems Thinking Summary

Feature flags create a SHIFTING THE BURDEN archetype:
- Quick rollback replaces fixing root cause
- Easy experimentation replaces careful design

To avoid:
- Time-box all flags
- Require cleanup as part of feature completion
- Monitor flag count as tech debt metric
```

---

### Exercise 3: Dependency Failure Analysis

**Task**: For a payment service with the following dependencies, document failure modes and design graceful degradation.

Dependencies:
- Primary PostgreSQL database
- Redis cache
- External fraud detection API
- Kafka for event publishing
- HashiCorp Vault for secrets

**Solution**:

````markdown
# Dependency Failure Analysis: Payment Service

## 1. Primary PostgreSQL Database

### Failure Modes:
| Mode | Symptoms | Detection |
|------|----------|-----------|
| Unavailable | Connection refused | TCP connect timeout |
| Slow | Query timeouts | P99 latency spike |
| Wrong data | Incorrect results | Consistency checks |
| Full | Write failures | Disk space alerts |

### Graceful Degradation:

When the primary database becomes unavailable or times out, the payment service must not drop transactions. It must preserve them for eventual processing. The strategy below distinguishes between two failure modes: a hard unavailability (where the database cannot be reached at all) and a soft timeout (where the write may or may not have succeeded). In the timeout case, querying the read replica by idempotency key prevents duplicate payments before falling back to the queue, ensuring exactly-once semantics even under partial failure.

```go
// Payment Service Database Strategy

func (s *PaymentService) ProcessPayment(ctx context.Context, p Payment) error {
    // Try primary database
    if err := s.primaryDB.Save(ctx, p); err != nil {
        if isUnavailable(err) {
            // Queue for later processing
            return s.queue.Enqueue(ctx, p)
        }
        if isTimeout(err) {
            // Use read replica to check if already processed
            exists, _ := s.replicaDB.Exists(ctx, p.IdempotencyKey)
            if exists {
                return nil // Already processed
            }
            return s.queue.Enqueue(ctx, p)
        }
        return err
    }
    return nil
}
```

### Recovery:
- On recovery: Process queued payments with idempotency checks
- Alert if queue exceeds threshold
- Manual review for payments older than 1 hour

---

## 2. Redis Cache

### Failure Modes:
| Mode | Symptoms | Detection |
|------|----------|-----------|
| Unavailable | Connection errors | Health check |
| Slow | High latency | P99 > 10ms |
| Memory full | Evictions increase | Memory alerts |
| Data loss | Missing keys | Hit rate drops |

### Graceful Degradation:

Redis is a soft dependency for payment status lookups. Its only role is to reduce database load, so the correct failure response is a transparent fallback to the database rather than an error. The cache-aside pattern below treats both a cache miss and a cache error identically: fetch from the source of truth, then attempt an async cache population so the next request benefits. The goroutine write is fire-and-forget with a fresh context specifically because the original request context may be canceled by the time the write completes.

```go
// Cache-aside pattern with fallback

func (s *PaymentService) GetPaymentStatus(ctx context.Context, id string) (*Payment, error) {
    // Try cache (soft dependency)
    if payment, err := s.cache.Get(ctx, id); err == nil {
        return payment, nil
    }
    // Cache miss or failure - go to database
    // This is expected path, just slower
    payment, err := s.db.GetPayment(ctx, id)
    if err != nil {
        return nil, err
    }
    // Try to populate cache, but don't fail if Redis down
    go s.cache.Set(context.Background(), id, payment, time.Hour)
    return payment, nil
}
```

### Recovery:
- Cache failures are self-healing (data reconstructed from DB)
- Monitor cache hit rate to detect issues
- No manual intervention needed

---

## 3. External Fraud Detection API

### Failure Modes:
| Mode | Symptoms | Detection |
|------|----------|-----------|
| Unavailable | 5xx errors | Error rate |
| Slow | Timeouts | Latency |
| Wrong results | False positives spike | Manual review rate |
| Rate limited | 429 errors | Error code |

### Graceful Degradation:

The fraud detection API is a hard dependency from a compliance perspective but a soft dependency from an availability perspective. Payments must not halt when the third-party service goes down. The circuit breaker prevents a slow or failing fraud API from consuming all request goroutines through accumulated timeouts. Once open, it routes directly to the fallback without waiting. The fallback itself applies conservative, asymmetric rules: trusted customers (high transaction history) are allowed through, while new customers and high-value transactions are blocked pending manual review, accepting some false positives to avoid the greater risk of fraudulent approvals.

```go
// Fraud check with fallback strategy

func (s *PaymentService) CheckFraud(ctx context.Context, p Payment) (bool, error) {
    // Circuit breaker for fraud service
    if s.fraudBreaker.IsOpen() {
        return s.fallbackFraudCheck(p)
    }

    ctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
    defer cancel()

    result, err := s.fraudAPI.Check(ctx, p)
    if err != nil {
        s.fraudBreaker.RecordFailure()
        return s.fallbackFraudCheck(p)
    }

    s.fraudBreaker.RecordSuccess()
    return result.IsAllowed, nil
}

// Fallback: Use simple rules when API unavailable
func (s *PaymentService) fallbackFraudCheck(p Payment) (bool, error) {
    // Conservative rules when API down:
    // - Reject high-value transactions (> 100,000 cents / $1,000)
    // - Reject new customers
    // - Allow known good customers with history
    if p.AmountCents > 100_000 {
        return false, nil // Require manual review
    }
    if p.CustomerHistory.TransactionCount > 10 {
        return true, nil // Allow trusted customers
    }
    return false, nil // Default to safe
}
```

### Recovery:
- Circuit breaker auto-recovers
- Queue rejected transactions for re-evaluation
- Alert on sustained fallback mode

---

## 4. Kafka for Event Publishing

### Failure Modes:
| Mode | Symptoms | Detection |
|------|----------|-----------|
| Unavailable | Producer errors | Connection failures |
| Slow | Producer backpressure | Latency |
| Message loss | Consumer doesn't receive | End-to-end checks |
| Partition leader unavailable | Specific topic errors | Partition health |

### Graceful Degradation:

The key insight here is that event publishing is a side effect, not the core business operation. By decoupling the two with the transactional outbox pattern, you write the event record to the same database transaction as the domain change, eliminating the dual-write problem where a crash between `db.Save` and `kafka.Publish` would cause silent event loss. A background worker then polls the outbox and forwards entries to Kafka with at-least-once delivery semantics, so a Kafka outage degrades gracefully to increased outbox queue depth rather than a failed payment.

```go
// Payment completes even if events can't be published

func (s *PaymentService) ProcessPayment(ctx context.Context, p Payment) error {
    // Core operation must succeed
    if err := s.db.Save(ctx, p); err != nil {
        return err
    }

    // Event publishing is async and retry-able
    // Use outbox pattern for reliability
    outboxEntry := OutboxEntry{
        Event:     "payment.completed",
        Payload:   p,
        Status:    "pending",
        CreatedAt: time.Now(),
    }

    if err := s.db.SaveOutbox(ctx, outboxEntry); err != nil {
        // Log but don't fail payment
        log.Warn("Failed to save outbox entry", "error", err)
        return nil
    }

    // Background worker publishes from outbox
    return nil
}

// Background worker with retries
func (s *PaymentService) PublishPendingEvents(ctx context.Context) {
    entries, _ := s.db.GetPendingOutbox(ctx, 100)
    for _, e := range entries {
        if err := s.kafka.Publish(ctx, e.Event, e.Payload); err != nil {
            // Will retry on next run
            continue
        }
        s.db.MarkOutboxPublished(ctx, e.ID)
    }
}
```

### Recovery:
- Outbox pattern ensures eventual delivery
- Monitor outbox queue size
- Alert if entries older than 5 minutes

---

## 5. HashiCorp Vault for Secrets

### Failure Modes:
| Mode | Symptoms | Detection |
|------|----------|-----------|
| Unavailable | Auth failures | Token refresh fails |
| Slow | Startup delays | Latency |
| Token expired | 403 errors | Auth errors |
| Lease revoked | Sudden failures | Revocation events |

### Graceful Degradation:

Vault is itself a runtime dependency that can be unavailable during a network partition or a rolling upgrade, so callers must never block on a live Vault read in the critical path. The pattern below solves this with a read-through cache guarded by a `sync.RWMutex`: cache hits are lock-free reads, and a Vault failure falls back to a stale-but-valid cached secret rather than cascading into an auth failure. The one-hour TTL balances secret rotation agility against resilience, short enough to pick up rotated credentials promptly and long enough to survive a brief Vault outage without service impact.

```go
// Secrets with local caching and graceful handling

type SecretManager struct {
    vault       *vault.Client
    cache       map[string]*CachedSecret
    mu          sync.RWMutex
}

func (m *SecretManager) GetSecret(ctx context.Context, key string) (string, error) {
    // Check cache first
    m.mu.RLock()
    if cached, ok := m.cache[key]; ok {
        if !cached.IsExpired() {
            m.mu.RUnlock()
            return cached.Value, nil
        }
    }
    m.mu.RUnlock()

    // Try to refresh from Vault
    secret, err := m.vault.Read(ctx, key)
    if err != nil {
        // If Vault is down but we have cached value, use it
        m.mu.RLock()
        if cached, ok := m.cache[key]; ok {
            m.mu.RUnlock()
            log.Warn("Using stale secret, Vault unavailable")
            return cached.Value, nil
        }
        m.mu.RUnlock()
        return "", err
    }

    // Update cache
    m.mu.Lock()
    m.cache[key] = &CachedSecret{
        Value:     secret,
        ExpiresAt: time.Now().Add(time.Hour),
    }
    m.mu.Unlock()

    return secret, nil
}
```

### Recovery:
- Cache secrets locally with reasonable TTL
- Pre-warm cache at startup
- Alert on cache miss + Vault failure
- Consider breaking glass procedure for emergencies

---

## Summary: Dependency Classification

| Dependency | Type | Failure Strategy |
|------------|------|------------------|
| PostgreSQL | Hard | Queue + Replica |
| Redis | Soft | Bypass, DB fallback |
| Fraud API | Soft | Rule-based fallback |
| Kafka | Soft | Outbox pattern |
| Vault | Hard (startup) | Cached secrets |
````

### Junior → FAANG: Doing the Exercises Before Your Interview

The exercises in this section are calibrated to test the same skills as FAANG system design interviews. Exercise 1 (system mapping) is directly analogous to the whiteboard portion of a design interview where you draw the system. Exercise 2 (failure mode analysis) is analogous to the "what could go wrong?" follow-up that every good interviewer asks.

Do these exercises on paper, not just in your head. Drawing the system and writing the failure modes forces a level of specificity that mental rehearsal does not. Time yourself: a good system map for a moderately complex service should take 15 to 20 minutes. If it takes longer, practice until you can do it fluently within that window.

### Senior @ FAANG: Using These Exercises as Team Workshops

At staff level, these exercises are excellent team workshop material. Running Exercise 1 (system mapping) as a collaborative team activity often reveals that different engineers have significantly different mental models of the same system. That discovery is valuable: it shows where documentation is insufficient and where architectural misunderstandings might be driving inconsistent technical decisions.

The most valuable team exercise: pick a critical path in your production system and run Exercise 2 (failure mode analysis) as a group. The goal is not to find all failure modes. It is to surface the ones that are most likely to be overlooked and to verify that the team's understanding of failure propagation is consistent and correct. The output is both a better-understood system and an updated runbook.

---
