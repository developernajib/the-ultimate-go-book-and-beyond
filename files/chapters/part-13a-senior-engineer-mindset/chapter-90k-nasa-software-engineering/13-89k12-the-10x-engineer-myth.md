## 90K.12 The 10x Engineer Myth

The shuttle software team wrote 3 to 5 lines of code per developer per day. A startup
engineer might write 500 lines per day. Does that make the startup engineer 100x more
productive? Obviously not. The shuttle team was producing software with 0.004 defects per
KLOC. The startup is producing software with 10-50 defects per KLOC.

### When NASA Rigor Applies

NASA-level rigor is appropriate when:

- **Human life is at stake.** Medical devices, avionics, automotive safety systems,
  nuclear plant controls.
- **The system is irreplaceable.** A spacecraft 200 million miles away cannot be
  physically serviced.
- **The cost of failure is catastrophic.** A bug in the Mars Climate Orbiter's unit
  conversion (imperial vs. metric) caused the loss of a $327 million spacecraft.
- **The environment is hostile.** Radiation, vacuum, extreme temperatures - no second
  chances.

### When Move-Fast Applies

Startup-speed development is appropriate when:

- **Failure is recoverable.** A web service can be rolled back in minutes.
- **The cost of delay exceeds the cost of bugs.** If your competitor ships first, you
  lose the market.
- **Users are tolerant.** Consumer apps can have minor bugs. Users will report them.
- **The system is redundant.** Load balancers, replicas, and retries mask individual
  failures.

### The Spectrum of Rigor

| Domain | Lines/Dev/Day | Defects/KLOC | Cost per Bug | Rigor Level |
|--------|--------------|--------------|-------------|-------------|
| Space Flight | 3-5 | 0.004 | $100M+ | Maximum |
| Avionics | 5-10 | 0.1 | $10M+ | Very High |
| Medical Devices | 10-20 | 0.5 | $1M+ | High |
| Financial Trading | 20-50 | 1-5 | $100K-$10M | Medium-High |
| Enterprise SaaS | 50-100 | 5-15 | $10K-$1M | Medium |
| Consumer Web | 100-200 | 15-30 | $100-$100K | Medium-Low |
| Startup MVP | 200-500 | 30-100 | $0-$10K | Low |
| Hackathon | 500+ | 100+ | $0 | None |

### The Real "10x Engineer"

The 10x engineer is not the person who writes 10x more code. It is the person who:

1. **Prevents the $100M bug.** The engineer who insists on bounded loops and catches the
   unbounded recursion in code review prevented a production outage.

2. **Reduces total cost of ownership.** Writing 3 lines per day that never need to be
   debugged, patched, or explained is more valuable than 300 lines per day that generate
   a constant stream of bug reports.

3. **Makes the right trade-off.** Knowing when to apply NASA rigor (your payment
   processing pipeline) and when to move fast (your internal admin dashboard).

4. **Writes code that others can verify.** Short functions, explicit error handling,
   bounded loops, assertions - code that reviewers can prove correct by inspection.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, format string, args ...any) {
    if !condition {
        if len(args) == 0 {
            panic("assertion failed: " + format)
        }
        panic(fmt.Sprintf("assertion failed: "+format, args...))
    }
}

// RigorLevel defines how much NASA-style discipline to apply.
// The key insight: different parts of the same system deserve
// different levels of rigor.
type RigorLevel int

const (
    // RigorStandard is for internal tools, admin pages, dev utilities.
    // Basic error handling. Standard testing. Move fast.
    RigorStandard RigorLevel = iota

    // RigorElevated is for user-facing features, API endpoints.
    // Thorough input validation. Good test coverage. Bounded resources.
    RigorElevated

    // RigorHigh is for financial transactions, security-critical paths.
    // Exhaustive validation. High test coverage. Assertions. Bounded everything.
    RigorHigh

    // RigorCritical is for life-safety, compliance, irreversible operations.
    // NASA-inspired. Maximum assertions. Formal specification.
    // Independent review. 100% MC/DC coverage.
    RigorCritical
)

// PaymentProcessor demonstrates applying different rigor levels
// to different parts of the same system.
type PaymentProcessor struct {
    rigor RigorLevel
}

// ProcessPayment applies NASA-level rigor to financial transactions.
func (pp *PaymentProcessor) ProcessPayment(ctx context.Context, payment Payment) error {
    // === RigorCritical: Exhaustive pre-conditions ===

    // Assertion: context must have a deadline.
    deadline, ok := ctx.Deadline()
    if !ok {
        return errors.New("payment processing requires a deadline")
    }
    _ = deadline

    // Assertion: payment must be valid.
    if err := payment.Validate(); err != nil {
        return fmt.Errorf("payment validation failed: %w", err)
    }

    // Assertion: amount must be positive and bounded.
    Assert(payment.AmountCents > 0, "payment amount must be positive")
    Assert(payment.AmountCents <= 100_000_00, "payment amount exceeds $100K limit")

    // Assertion: currency must be known.
    Assert(isValidCurrency(payment.Currency), "invalid currency: %s", payment.Currency)

    // Idempotency check - NASA never executes the same command twice.
    // (In space, duplicate commands can fire thrusters twice.)

    // === Execute with bounded timeout ===
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    // Process through bounded pipeline.
    if err := pp.authorizePayment(ctx, payment); err != nil {
        return fmt.Errorf("authorization failed: %w", err)
    }

    if err := pp.capturePayment(ctx, payment); err != nil {
        // Authorization succeeded but capture failed.
        // Must void the authorization - NASA always has a rollback plan.
        if voidErr := pp.voidAuthorization(ctx, payment); voidErr != nil {
            // Both capture and void failed - critical alert.
            return fmt.Errorf("CRITICAL: capture failed (%w) and void failed (%v)",
                err, voidErr)
        }
        return fmt.Errorf("capture failed (authorization voided): %w", err)
    }

    return nil
}

func (pp *PaymentProcessor) authorizePayment(ctx context.Context, p Payment) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    default:
        return nil // Placeholder.
    }
}

func (pp *PaymentProcessor) capturePayment(ctx context.Context, p Payment) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    default:
        return nil // Placeholder.
    }
}

func (pp *PaymentProcessor) voidAuthorization(ctx context.Context, p Payment) error {
    // Void gets its own timeout - independent of the parent context.
    voidCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    select {
    case <-voidCtx.Done():
        return voidCtx.Err()
    default:
        return nil // Placeholder.
    }
}

// Payment represents a payment request.
type Payment struct {
    ID           string
    AmountCents  int64
    Currency     string
    CustomerID   string
    Description  string
    IdempotencyKey string
}

// Validate checks all payment fields with NASA-level thoroughness.
func (p Payment) Validate() error {
    if p.ID == "" {
        return errors.New("payment ID is required")
    }
    if len(p.ID) > 64 {
        return errors.New("payment ID too long")
    }
    if p.AmountCents <= 0 {
        return errors.New("amount must be positive")
    }
    if p.Currency == "" {
        return errors.New("currency is required")
    }
    if len(p.Currency) != 3 {
        return errors.New("currency must be 3-letter ISO code")
    }
    if p.CustomerID == "" {
        return errors.New("customer ID is required")
    }
    if p.IdempotencyKey == "" {
        return errors.New("idempotency key is required")
    }
    return nil
}

func isValidCurrency(c string) bool {
    valid := map[string]bool{
        "USD": true, "EUR": true, "GBP": true,
        "JPY": true, "CAD": true, "AUD": true,
    }
    return valid[c]
}
```

---
