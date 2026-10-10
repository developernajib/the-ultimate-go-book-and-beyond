## 89.3 The Strangler Fig Pattern

### Implementation in Go

The strangler fig pattern works by placing a routing layer in front of your old system that can send traffic to either the old or the new implementation. You start with 100% of traffic going to the old system, then gradually increase the percentage going to the new system as you gain confidence. The key insight is that you can also run both systems simultaneously in "shadow mode" to compare their outputs without affecting real users. The generic Go implementation below uses atomic operations for thread-safe percentage updates and supports both normal routing and shadow comparison modes.

```go
package migration

import (
    "context"
    "log/slog"
    "math/rand/v2"
    "sync/atomic"
)

// StranglerFig wraps old and new implementations
type StranglerFig[T any] struct {
    old          T
    new          T
    useNewPct    int64  // 0-100
    comparator   func(oldResult, newResult any) bool
    metricsEmit  func(usedNew bool, matched bool, err error)
}

func NewStranglerFig[T any](old, new T) *StranglerFig[T] {
    return &StranglerFig[T]{
        old:       old,
        new:       new,
        useNewPct: 0,
    }
}

// SetNewPercentage sets the rollout percentage (0-100)
func (s *StranglerFig[T]) SetNewPercentage(pct int64) {
    atomic.StoreInt64(&s.useNewPct, pct)
}

// Execute runs the appropriate implementation
func (s *StranglerFig[T]) Execute(ctx context.Context, fn func(T) (any, error)) (any, error) {
    pct := atomic.LoadInt64(&s.useNewPct)

    // Determine which to use (uses math/rand/v2)
    useNew := rand.Int64N(100) < pct

    var result any
    var err error

    if useNew {
        result, err = fn(s.new)
    } else {
        result, err = fn(s.old)
    }

    if s.metricsEmit != nil {
        s.metricsEmit(useNew, true, err)
    }
    return result, err
}

// ExecuteWithComparison runs both and compares (for validation)
func (s *StranglerFig[T]) ExecuteWithComparison(
    ctx context.Context,
    fn func(T) (any, error),
) (any, error) {
    // Run old (source of truth)
    oldResult, oldErr := fn(s.old)

    // Run new async for comparison
    go func() {
        newResult, newErr := fn(s.new)

        // Compare results
        if s.comparator != nil {
            matched := s.comparator(oldResult, newResult)
            if !matched {
                slog.Warn("Migration mismatch",
                    "old", oldResult,
                    "new", newResult,
                )
            }
            if s.metricsEmit != nil {
                s.metricsEmit(false, matched, newErr)
            }
        }
    }()

    return oldResult, oldErr
}

type User struct {
    ID string
}

// Example usage
type UserService interface {
    GetUser(ctx context.Context, id string) (*User, error)
}

type LegacyUserService struct{}

func (s *LegacyUserService) GetUser(ctx context.Context, id string) (*User, error) {
    return &User{ID: id}, nil
}

type NewUserService struct{}

func (s *NewUserService) GetUser(ctx context.Context, id string) (*User, error) {
    return &User{ID: id}, nil
}

func main() {
    legacy := &LegacyUserService{}
    modern := &NewUserService{}

    strangler := NewStranglerFig[UserService](legacy, modern)

    // Start at 0% new
    strangler.SetNewPercentage(0)
    _ = strangler

    // Gradually increase
    // Day 1: strangler.SetNewPercentage(5)
    // Day 3: strangler.SetNewPercentage(25)
    // Day 7: strangler.SetNewPercentage(50)
    // Day 14: strangler.SetNewPercentage(100)
}
```

### Strangler Fig Milestones

A strangler fig migration is not a single event but a series of carefully sequenced phases, each with its own goals and exit criteria. Rushing through these phases is how teams end up with production incidents during migrations. Each phase builds confidence in the new system before exposing more real traffic to it. The timeline below assumes a moderately complex service. Adjust the durations based on your system's criticality and complexity.

```
PHASE 1: SETUP (Week 1-2)
├── Implement new system alongside old
├── Set up routing/switching mechanism
├── Add comparison metrics
└── Deploy with 0% to new

PHASE 2: SHADOW (Week 3-4)
├── Run new system in shadow mode
├── Compare outputs, log differences
├── Fix discrepancies found
└── Build confidence

PHASE 3: CANARY (Week 5-6)
├── Route 1-5% of traffic to new
├── Monitor closely
├── Quick rollback if issues
└── Expand slowly

PHASE 4: GRADUAL ROLLOUT (Week 7-10)
├── Increase to 25%, 50%, 75%, 100%
├── Watch metrics at each step
├── Address edge cases as found
└── Document differences in behavior

PHASE 5: CLEANUP (Week 11-12)
├── Remove old system
├── Delete switching code
├── Archive old code
└── Update documentation
```

### Junior → FAANG: Strangler Fig as a System Design Answer

The strangler fig pattern comes up in both behavioral and system design interviews. When asked "how would you migrate a legacy service without downtime," the expected answer at entry level covers the facade, the shadow mode, and the gradual traffic shift. Know the five phases by name and be able to explain why each one exists. The most common mistake is skipping shadow mode: interviewers at Google and Meta explicitly probe whether you understand that you cannot discover behavioral differences without running both systems against real traffic simultaneously.

### Senior @ FAANG: Strangler Fig at Organizational Scale

At staff level, the strangler fig is not just a pattern you apply to one service. It is a standard you introduce to your org so that every migration follows it. This means writing the library that provides the routing abstraction (so teams do not reimplement percentage-based traffic splitting six times), the metrics dashboard template (so every migration has comparable observability), and the phase gate criteria (so promotion from shadow to canary requires a written data-backed decision rather than an informal "it looks good").

The cleanup phase deserves special attention at senior levels. At FAANG scale, old code paths survive long past their useful life because no one wants to own the decommission work. A staff engineer closes this loop by attaching a hard decommission date to the migration RFC at inception, making the date visible on the team dashboard, and treating incomplete decommissions as technical debt that blocks future promotions. The "temporary" routing code that becomes permanent is a maturity failure, not just a technical one.

---
