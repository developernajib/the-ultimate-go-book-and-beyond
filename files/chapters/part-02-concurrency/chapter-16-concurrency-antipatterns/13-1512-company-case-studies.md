## 16.12 Company Case Studies

### Uber: Check-Then-Act Race in Surge Pricing

A check-then-act race in a surge-pricing cache can compute and store a zone multiplier more than once under concurrency, so riders in the same zone briefly see inconsistent pricing. The pattern, in a surge-pricing-style calculator:

```go
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

// ALSO WRONG: correct, but holds the lock across the expensive call
func (s *SurgePricing) GetMultiplierSerialized(zone string) float64 {
    s.mu.Lock()
    defer s.mu.Unlock()

    if mult, exists := s.multipliers[zone]; exists && mult != 0 {
        return mult
    }

    // DISASTER: calculateMultiplier is the "expensive operation". Every
    // zone in the system now queues behind this one call, on one lock.
    // The race is gone and the service is serialized.
    newMult := s.calculateMultiplier(zone)
    s.multipliers[zone] = newMult
    return newMult
}

// FIXED: singleflight collapses duplicate work, and no lock is ever
// held across the expensive call.
type SurgePricingFixed struct {
    mu          sync.Mutex
    multipliers map[string]float64
    group       singleflight.Group
}

func (s *SurgePricingFixed) GetMultiplier(zone string) (float64, error) {
    s.mu.Lock()
    mult, exists := s.multipliers[zone]
    s.mu.Unlock()
    if exists && mult != 0 {
        return mult, nil
    }

    // One calculation per zone, no matter how many callers arrive.
    // Concurrent callers for the SAME zone share this result - callers
    // for DIFFERENT zones proceed in parallel.
    v, err, _ := s.group.Do(zone, func() (any, error) {
        // Re-check inside the group: a previous holder may have just
        // finished and stored the value.
        s.mu.Lock()
        if m, ok := s.multipliers[zone]; ok && m != 0 {
            s.mu.Unlock()
            return m, nil
        }
        s.mu.Unlock()

        newMult := s.calculateMultiplier(zone) // No lock held here

        s.mu.Lock()
        s.multipliers[zone] = newMult
        s.mu.Unlock()
        return newMult, nil
    })
    if err != nil {
        return 0, err
    }
    return v.(float64), nil
}
```

**Lesson**: The obvious fix for a check-then-act race is to widen the lock until the check and the act are one operation. Notice what that costs before reaching for it. Here it converts a race into a global serialization point, because the "act" is expensive, and a service that computes one zone at a time across the whole fleet is arguably a worse outcome than the occasional duplicate multiplier.

When the expensive work is *idempotent*, as a pricing calculation is, the answer is to deduplicate rather than to serialize. `singleflight` collapses concurrent callers for the same key onto one execution and shares the result, while different keys run concurrently. The general rule stands behind it: never hold a lock across an expensive or blocking call. Take the lock, read or write, release, then do the work.

### Netflix: Goroutine Leak in Circuit Breaker

A goroutine leak commonly appears in Hystrix-style circuit breakers when the timeout path abandons the worker goroutine. Netflix's original Hystrix is a Java library, in maintenance mode since 2018, and the Go ports it inspired have largely given way to breakers like `sony/gobreaker`, but the leak pattern is timeless.

The pattern is worth pinning down precisely, because the usual telling gets the cause wrong and then "fixes" something that was never broken.

```go
// LEAKS: the result channel is UNBUFFERED
func (c *CircuitBreaker) executeLeaky(ctx context.Context, fn func() error) error {
    done := make(chan error) // <- the bug is here, and only here

    go func() {
        done <- fn() // After a timeout, nobody is receiving. Blocks forever.
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        return ctx.Err() // Caller leaves; the goroutine parks on the send
    }
}
```

The leak is the **unbuffered channel**, not the abandonment. Once `ctx` fires, the caller stops receiving, so `done <- fn()` has no receiver and never will, and the goroutine is stuck on the send permanently, holding `fn`'s stack and everything it captured. Every timed-out request leaks one, which means the leak scales with exactly the thing that causes timeouts: load.

```go
// CORRECT: a buffer of one
func (c *CircuitBreaker) execute(ctx context.Context, fn func() error) error {
    done := make(chan error, 1) // <- the entire fix

    go func() {
        // A panic in fn would otherwise kill the process AND leave the
        // caller blocked until ctx fires. Convert it to an error.
        defer func() {
            if r := recover(); r != nil {
                done <- fmt.Errorf("panic in circuit breaker: %v", r)
            }
        }()
        done <- fn()
    }()

    select {
    case err := <-done:
        return err
    case <-ctx.Done():
        // The goroutine is NOT leaked. The buffer slot means its send
        // completes with no receiver, so it exits as soon as fn returns.
        // The result lands in the buffer and is garbage collected with
        // the channel. Nothing to clean up.
        return ctx.Err()
    }
}
```

One buffer slot for one sender. The send always succeeds, so the goroutine always exits. Note what is *not* needed: no orphan-watcher goroutine, no `logOrphan` timer, no second channel for panics. A watcher spawned on the timeout path is itself a goroutine living up to a minute per timed-out request, which turns a leak into a slower leak.

Be honest about the limit. The goroutine still runs `fn` to completion, so it holds a connection and a stack for as long as `fn` takes. Buffering guarantees the goroutine *exits*, not that the work *stops*. Only making `fn` itself context-aware, so the underlying HTTP or database call is cancelled, actually stops the work. That is why every I/O function should take a `ctx`.

**Lesson**: A `select` with a cancellation branch and an unbuffered result channel is a goroutine leak. Buffer result channels to the number of sends.

### Google: Lock-Ordering Deadlock in a Mail Backend

A classic way to deadlock a mail backend is to lock two user mailboxes in an order that depends on who is sending to whom, so two concurrent sends in opposite directions wait on each other forever. The simplified pattern:

```go
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

// FIXED: consistent lock ordering, with the two traps handled
type EmailService struct {
    mu        sync.Mutex // guards userLocks itself
    userLocks map[string]*sync.Mutex
}

// lockFor lazily creates a per-user mutex.
//
// The map needs its own lock. Reading s.userLocks[from] concurrently
// with another goroutine inserting into it is a data race, and a
// missing key yields a nil *sync.Mutex whose Lock() panics.
func (s *EmailService) lockFor(user string) *sync.Mutex {
    s.mu.Lock()
    defer s.mu.Unlock()
    mu, ok := s.userLocks[user]
    if !ok {
        mu = &sync.Mutex{}
        s.userLocks[user] = mu
    }
    return mu
}

func (s *EmailService) SendEmail(from, to string) error {
    // Self-send: alice emails herself. Without this guard, first and
    // second are the SAME mutex, and the second Lock blocks forever on
    // a mutex this goroutine already holds. sync.Mutex is not reentrant.
    if from == to {
        return s.deliverSelf(from)
    }

    // Always lock in alphabetical order
    first, second := from, to
    if from > to {
        first, second = to, from
    }

    firstLock, secondLock := s.lockFor(first), s.lockFor(second)

    firstLock.Lock()
    defer firstLock.Unlock()

    secondLock.Lock()
    defer secondLock.Unlock()

    return s.deliverEmail(from, to)
}
```

**Lesson**: Acquire locks in a consistent global order, and note the two things the ordering rule does not cover.

The ordering rule breaks down when the two "different" locks turn out to be the same lock. `from == to` is trivially reachable (a user emails themselves, a test uses the same fixture twice) and it deadlocks instantly, because `sync.Mutex` is not reentrant and no ordering scheme can rescue it. Guard the equal case before locking.

And the lock registry is itself shared state. A `map[string]*sync.Mutex` that is read on the hot path and written whenever a new user appears is a data race on the map, plus a nil-pointer panic for any user not yet present. The thing handing out locks needs a lock of its own.

### Stripe: Idempotency Key Race Condition

Payment idempotency has a classic check-then-insert race that can cause duplicate charges. Stripe's idempotency-key design guards against it:

```go
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
```

**Lesson**: Get the ordering of these two mechanisms right, because the code above presents the weaker one as the fix.

A distributed lock with a TTL is **not** mutual exclusion, and treating it as though it were is how payment systems double-charge. The lock above expires after a minute. If `processPayment` takes longer than that, whether from a slow gateway, a GC pause, or the process being stopped and resumed, the lock silently expires, a second request acquires it, both believe they hold it, and both charge the card. Nothing in the code notices. Lengthening the TTL does not fix this, it only moves the threshold, and it also means a crashed holder wedges the key for that much longer.

The guarantee has to come from the database, because the database is the thing that actually knows. A `UNIQUE` constraint on the idempotency key, or `INSERT ... ON CONFLICT DO NOTHING`, is enforced atomically at the point of truth, and it cannot expire, drift, or be fooled by a pause:

```go
// The constraint is the guarantee. Claim the key FIRST, and let the
// database arbitrate. Exactly one caller can win the insert.
func (s *PaymentService) ProcessPayment(ctx context.Context, idempKey string, req PaymentRequest) (*Payment, error) {
    // INSERT ... ON CONFLICT DO NOTHING. won is false if the row exists.
    won, err := s.db.ClaimIdempotencyKey(ctx, idempKey)
    if err != nil {
        return nil, err
    }
    if !won {
        // Someone else owns this key: return their result, or report
        // in-progress. Never charge.
        return s.db.AwaitPayment(ctx, idempKey)
    }

    payment, err := s.processPayment(ctx, req)
    if err != nil {
        // Release the claim ONLY if we know the charge did not happen.
        // On an unknown outcome, keep it and resolve out of band:
        // a stuck key is recoverable, a double charge is not.
        if errors.Is(err, ErrDefinitelyNotCharged) {
            _ = s.db.ReleaseIdempotencyKey(ctx, idempKey)
        }
        return nil, err
    }

    return payment, s.db.CompletePayment(ctx, idempKey, payment)
}
```

Use a distributed lock as an *optimization* to avoid wasted duplicate work, never as the correctness boundary. The constraint is what makes it correct. The lock just makes it cheaper.

### Staff Lens: Case Studies as Institutional Memory

Each case study documents an incident that cost real money, hours, or reputation. Teams that read them benefit from the prevention. Teams that do not reinvent the bugs. The staff-level investment is ensuring every team member reads the relevant cases. Make them part of onboarding. Reference them in incident reviews. "We have seen this before, here is how we prevent it" is a team's most valuable asset.

### Principal Lens: Patterns Across Case Studies

Looking across case studies, common themes emerge:

- Most incidents trace to missing cancellation (goroutine leaks).
- Most deadlocks trace to inconsistent lock order.
- Most panics trace to channel misuse (close, send on closed).
- Most performance incidents trace to contention on a single mutex.

These themes tell you where to invest prevention: context discipline, lock hierarchies, channel ownership, mutex profiling. A principal engineer who sees the themes can shape the org's prevention strategy. Without the pattern recognition, each incident is a surprise.

---
