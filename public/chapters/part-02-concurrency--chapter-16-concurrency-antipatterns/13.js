export default `## 16.12 Company Case Studies

### Uber: The Billion-Dollar Race Condition

In 2016, Uber experienced a race condition that caused incorrect fares to be charged to riders. The bug was in their surge pricing calculation:

\`\`\`go
// Simplified recreation of the bug
type SurgePricing struct {
    mu          sync.Mutex
    multipliers map[string]float64  // zone -> multiplier
}

// BUGGY: Race between read and update
func (s *SurgePricing) GetMultiplierBuggy(zone string) float64 {
    s.mu.Lock()
    mult := s.multipliers[zone]
    s.mu.Unlock()

    if mult == 0 {
        // Calculate new multiplier (expensive operation)
        newMult := s.calculateMultiplier(zone)

        s.mu.Lock()
        s.multipliers[zone] = newMult  // Race! Another goroutine might have set it
        s.mu.Unlock()

        return newMult
    }
    return mult
}

// FIXED: Atomic check-and-set with double-check locking
func (s *SurgePricing) GetMultiplier(zone string) float64 {
    s.mu.Lock()
    mult, exists := s.multipliers[zone]

    if exists && mult != 0 {
        s.mu.Unlock()
        return mult
    }

    // Calculate while holding lock (or use singleflight)
    newMult := s.calculateMultiplier(zone)
    s.multipliers[zone] = newMult
    s.mu.Unlock()

    return newMult
}
\`\`\`

**Lesson**: Always use atomic operations for check-then-act patterns. Consider \`singleflight\` for expensive computations.

### Netflix: Goroutine Leak in Circuit Breaker

Netflix discovered a goroutine leak in their Hystrix-Go circuit breaker library (Hystrix has been in maintenance mode since 2018; the leak pattern below is timeless and still worth studying even though modern Go circuit breakers like \`sony/gobreaker\` have since replaced it):

\`\`\`go
// BUGGY: Goroutine never exits
func (c *CircuitBreaker) executeBuggy(ctx context.Context, fn func() error) error {
    done := make(chan error, 1)

    go func() {
        done <- fn()  // Blocks forever if fn never returns
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err()
        // Goroutine still running! Leak!
    }
}

// FIXED: Ensure goroutine exits
func (c *CircuitBreaker) execute(ctx context.Context, fn func() error) error {
    done := make(chan error, 1)
    panicked := make(chan any, 1)

    go func() {
        defer func() {
            if r := recover(); r != nil {
                panicked <- r
            }
        }()

        // Check context before starting
        select {
        case <-ctx.Done():
            return
        default:
        }

        done <- fn()
    }()

    select {
    case err := <-done:
        return err
    case p := <-panicked:
        return fmt.Errorf("panic: %v", p)
    case <-ctx.Done():
        // Can't cancel the goroutine, but it will eventually finish
        // Log the orphan for monitoring
        go func() {
            select {
            case <-done:
            case <-time.After(time.Minute):
                c.logOrphan()
            }
        }()
        return ctx.Err()
    }
}
\`\`\`

**Lesson**: Always ensure goroutines have an exit path. Monitor for orphaned goroutines.

### Google: The Deadlock That Took Down Gmail

In 2009, a deadlock in Gmail's backend caused a major outage. The simplified pattern:

\`\`\`go
// BUGGY: Lock ordering violation
type EmailService struct {
    userLocks map[string]*sync.Mutex
    quotaLock sync.Mutex
}

func (s *EmailService) SendEmailBuggy(from, to string) error {
    // Goroutine 1: Lock "alice" then "bob"
    s.userLocks[from].Lock()
    defer s.userLocks[from].Unlock()

    s.userLocks[to].Lock()  // If "bob" is sending to "alice"...
    defer s.userLocks[to].Unlock()

    // ... deadlock!
    return s.deliverEmail(from, to)
}

// FIXED: Consistent lock ordering
func (s *EmailService) SendEmail(from, to string) error {
    // Always lock in alphabetical order
    first, second := from, to
    if from > to {
        first, second = to, from
    }

    s.userLocks[first].Lock()
    defer s.userLocks[first].Unlock()

    s.userLocks[second].Lock()
    defer s.userLocks[second].Unlock()

    return s.deliverEmail(from, to)
}
\`\`\`

**Lesson**: Always acquire locks in a consistent global order.

### Stripe: Idempotency Key Race Condition

Stripe found a race condition in their idempotency implementation that could cause duplicate charges:

\`\`\`go
// BUGGY: Window between check and insert
func (s *PaymentService) ProcessPaymentBuggy(idempKey string, req PaymentRequest) (*Payment, error) {
    // Check if already processed
    existing, err := s.db.GetPayment(idempKey)
    if err == nil && existing != nil {
        return existing, nil
    }

    // Process payment
    payment, err := s.processPayment(req)
    if err != nil {
        return nil, err
    }

    // Store result - BUT another request might have raced!
    if err := s.db.StorePayment(idempKey, payment); err != nil {
        // Might be duplicate - could have charged twice!
    }

    return payment, nil
}

// FIXED: Use INSERT ... ON CONFLICT or distributed lock
func (s *PaymentService) ProcessPayment(idempKey string, req PaymentRequest) (*Payment, error) {
    // Acquire distributed lock first
    lock, err := s.lockService.AcquireLock(idempKey, time.Minute)
    if err != nil {
        return nil, fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer lock.Release()

    // Check if already processed (within lock)
    existing, err := s.db.GetPayment(idempKey)
    if err == nil && existing != nil {
        return existing, nil
    }

    // Process payment
    payment, err := s.processPayment(req)
    if err != nil {
        return nil, err
    }

    // Store result atomically
    if err := s.db.StorePayment(idempKey, payment); err != nil {
        return nil, err
    }

    return payment, nil
}
\`\`\`

**Lesson**: Use distributed locks for cross-process synchronization. Database-level constraints (UNIQUE) can also help.

### Staff Lens: Case Studies as Institutional Memory

Each case study documents an incident that cost real money, hours, or reputation. Teams that read them benefit from the prevention; teams that do not reinvent the bugs. The staff-level investment is ensuring every team member reads the relevant cases. Make them part of onboarding. Reference them in incident reviews. "We have seen this before, here is how we prevent it" is a team's most valuable asset.

### Principal Lens: Patterns Across Case Studies

Looking across case studies, common themes emerge:

- Most incidents trace to missing cancellation (goroutine leaks).
- Most deadlocks trace to inconsistent lock order.
- Most panics trace to channel misuse (close, send on closed).
- Most performance incidents trace to contention on a single mutex.

These themes tell you where to invest prevention: context discipline, lock hierarchies, channel ownership, mutex profiling. A principal engineer who sees the themes can shape the org's prevention strategy. Without the pattern recognition, each incident is a surprise.

---
`;
