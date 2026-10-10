## 85.2 Feedback Loops in Software Systems

### Reinforcing (Positive) Feedback Loops

A reinforcing feedback loop amplifies whatever direction a system is already moving, it creates virtuous cycles when the trend is positive and vicious cycles when the trend is negative. In software systems, the classic vicious reinforcing loop is the cascading failure: a slow service causes requests to queue, queuing increases memory pressure, memory pressure triggers garbage collection pauses, and GC pauses make the service even slower. Understanding that you are looking at a reinforcing loop tells you the priority: break the cycle at its weakest link rather than trying to fix each component in isolation.

```
┌──────────────────────────────────────────────────────────────────┐
│              REINFORCING FEEDBACK LOOPS                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  GROWTH SPIRAL (Virtuous Cycle)                                  │
│                                                                  │
│  Good Product ──► More Users ──► More Revenue                    │
│       ▲                              │                           │
│       └────── More Investment ◄──────┘                           │
│                                                                  │
│  ─────────────────────────────────────────────                   │
│                                                                  │
│  DEATH SPIRAL (Vicious Cycle)                                    │
│                                                                  │
│  Poor Performance ──► Users Leave ──► Less Revenue               │
│       ▲                                  │                       │
│       └──── Cut Corners (less invest) ◄──┘                       │
│                                                                  │
│  ─────────────────────────────────────────────                   │
│                                                                  │
│  TECHNICAL EXAMPLE: Cascading Failure                            │
│                                                                  │
│  Service Slow ──► Requests Queue ──► Memory Pressure             │
│       ▲                                   │                      │
│       └────── GC Pauses (Slower) ◄────────┘                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Balancing (Negative) Feedback Loops

A balancing feedback loop works in the opposite direction from a reinforcing loop: it pushes a system back toward a target state whenever it deviates. Kubernetes autoscaling is the canonical software example, when CPU exceeds the target, new pods are added until the per-pod load returns to the desired level. The key design challenge with balancing loops is managing the delay between sensing a deviation and the corrective action taking effect. Loops with long delays oscillate rather than stabilize, which is why Kubernetes HPA has configurable stabilization windows.

```
┌──────────────────────────────────────────────────────────────────┐
│               BALANCING FEEDBACK LOOPS                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  THERMOSTAT PATTERN (Desired State vs Actual)                    │
│                                                                  │
│                    ┌───────────────┐                             │
│  Desired: 70°F ──►│   Compare     │──► Action                    │
│                    └───────────────┘                             │
│                           ▲                                      │
│  Actual: 65°F ────────────┘                                      │
│                                                                  │
│  Gap = 5°F → Turn on heater → Temperature rises                  │
│  Gap = 0°F → Turn off heater → Stable                            │
│                                                                  │
│  ─────────────────────────────────────────────                   │
│                                                                  │
│  AUTOSCALING EXAMPLE                                             │
│                                                                  │
│  Target CPU: 70% ──► Current: 90% ──► Add instances              │
│       │                                    │                     │
│       └─────── Current: 70% ◄──────────────┘                     │
│                 (Stable)                                         │
│                                                                  │
│  ─────────────────────────────────────────────                   │
│                                                                  │
│  RATE LIMITER EXAMPLE                                            │
│                                                                  │
│  Limit: 1000 RPS ──► Actual: 1500 RPS ──► Reject 500             │
│       │                                       │                  │
│       └────── System: 1000 RPS ◄──────────────┘                  │
│                (Stable under load)                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Feedback Loops in Go Systems

Feedback loops are not just conceptual diagrams, they manifest as concrete control structures in running code. The autoscaler below implements a balancing feedback loop: it compares observed CPU utilization against a target setpoint and adjusts replica count to close the gap, with a cooldown period to prevent oscillation.

```go
package main

import "time"

type ScaleAction int

const (
    NoAction ScaleAction = iota
    ScaleUp
    ScaleDown
)

type State int

const (
    Closed State = iota
    HalfOpen
    Open
)

// Example: Implementing a balancing feedback loop
type Autoscaler struct {
    targetCPU      float64
    minInstances   int
    maxInstances   int
    currentCount   int
    cooldownPeriod time.Duration
    lastScaled     time.Time
}

func (a *Autoscaler) Evaluate(currentCPU float64) ScaleAction {
    // Balancing loop: compare actual vs desired
    gap := currentCPU - a.targetCPU

    // Avoid oscillation with cooldown (delay)
    if time.Since(a.lastScaled) < a.cooldownPeriod {
        return NoAction
    }

    // Determine action based on gap
    switch {
    case gap > 20 && a.currentCount < a.maxInstances:
        return ScaleUp
    case gap < -20 && a.currentCount > a.minInstances:
        return ScaleDown
    default:
        return NoAction
    }
}

// Example: Circuit breaker as a balancing mechanism
type CircuitBreaker struct {
    failureThreshold int
    successThreshold int
    failures         int
    successes        int
    state            State
}

func (cb *CircuitBreaker) RecordResult(success bool) {
    if success {
        cb.failures = 0
        cb.successes++
        // Balancing: successes push toward Closed state
        if cb.state == HalfOpen && cb.successes >= cb.successThreshold {
            cb.state = Closed
        }
    } else {
        cb.successes = 0
        cb.failures++
        // Balancing: failures push toward Open state
        if cb.failures >= cb.failureThreshold {
            cb.state = Open
        }
    }
}
```

### Junior → FAANG: Recognizing Feedback Loops in Your Own Systems

Before your interview, map two or three feedback loops in a system you currently work on. One should be a reinforcing loop (a failure that amplifies itself) and one should be a balancing loop (a mechanism that prevents runaway failure). Being able to describe these concretely from your own experience is much more compelling than describing the concept abstractly.

A common reinforcing loop example: retries under load. When a service is slow, clients retry, which increases load, which makes the service slower, which increases retries. If you have encountered this pattern and implemented a fix (exponential backoff, jitter, circuit breakers), that is a strong systems-thinking story for your interview.

### Senior @ FAANG: Feedback Loop Analysis as Architectural Due Diligence

At staff level, every significant architectural decision should include an explicit feedback loop analysis. Before you deploy a new caching layer, a queue-based decoupling, or a new autoscaling policy, ask: what reinforcing loops does this introduce, and what are the governing mechanisms that prevent them from running away?

The engineers who have learned this lesson the hard way have stories about autoscaling policies that triggered "thundering herd" behavior: a spike in traffic triggers scaling, the new instances all hit the database simultaneously, the database slows down, the instances time out and retry, the retries further load the database, and so on. The fix is always a governing mechanism: staggered startup, connection ramping, circuit breakers. The governance standard is to require this analysis before deployment rather than discovering it in a post-mortem.

---
