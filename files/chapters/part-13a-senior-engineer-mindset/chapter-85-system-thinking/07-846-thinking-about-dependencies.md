## 85.6 Thinking About Dependencies

### Dependency Mapping

Every service has a dependency graph, but most engineers only know the first layer. Hidden and transitive dependencies are the ones that cause the most surprising production failures: a service goes down not because it was overloaded, but because a service it transitively depends on lost its NTP synchronization. Classifying dependencies as hard (system cannot function), soft (system degrades gracefully), hidden (not visible until failure), or transitive (dependency of a dependency) determines the appropriate mitigation strategy for each.

```
┌──────────────────────────────────────────────────────────────────┐
│                  DEPENDENCY ANALYSIS                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Types of Dependencies:                                          │
│                                                                  │
│  HARD DEPENDENCY                                                 │
│  └── System cannot function without it                           │
│      Example: Database for a CRUD app                            │
│      Mitigation: Redundancy, failover                            │
│                                                                  │
│  SOFT DEPENDENCY                                                 │
│  └── System degraded but functional without it                   │
│      Example: Recommendation engine                              │
│      Mitigation: Graceful degradation, defaults                  │
│                                                                  │
│  HIDDEN DEPENDENCY                                               │
│  └── Dependency not obvious until failure                        │
│      Example: DNS, NTP, cloud metadata service                   │
│      Mitigation: Document, test failure scenarios                │
│                                                                  │
│  TRANSITIVE DEPENDENCY                                           │
│  └── Dependency of a dependency                                  │
│      Example: Your service → Auth → Database                     │
│      Mitigation: Understand full dependency tree                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

DEPENDENCY QUESTIONS:
1. What happens if X is unavailable?
2. What happens if X is slow?
3. What happens if X returns errors?
4. What happens if X returns wrong data?
5. What are X's dependencies?
```

### Designing for Dependency Failure

Resilient services treat every dependency as a potential failure point and implement explicit fallback strategies for each one. The pattern below distinguishes between hard and soft dependencies in code: the primary database is tried first, a read replica provides a fallback for reads, and the recommendation cache degrades gracefully to a static response when unavailable. This structure makes the failure modes explicit and testable, you can inject failures in each dependency independently during testing and verify that the degradation is graceful rather than catastrophic.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "time"
)

// Pattern: Graceful degradation with fallbacks
type UserService struct {
    primaryDB   *Database
    cacheLayer  *Cache
    fallbackDB  *Database  // Read replica
}

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
    // Try cache first (soft dependency)
    if user, err := s.cacheLayer.Get(ctx, id); err == nil {
        return user, nil
    }

    // Try primary (hard dependency, but with timeout)
    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    user, err := s.primaryDB.GetUser(ctx, id)
    if err == nil {
        // Populate cache asynchronously
        go s.cacheLayer.Set(context.Background(), id, user)
        return user, nil
    }

    // Fallback to replica (degraded mode)
    if errors.Is(err, context.DeadlineExceeded) {
        user, err = s.fallbackDB.GetUser(ctx, id)
        if err == nil {
            // Log degradation for monitoring
            slog.Warn("Using read replica fallback for GetUser")
            return user, nil
        }
    }

    return nil, fmt.Errorf("all GetUser sources failed: %w", err)
}

// Pattern: Timeout budget across dependencies
type TimeoutBudget struct {
    total     time.Duration
    remaining time.Duration
}

func NewTimeoutBudget(total time.Duration) *TimeoutBudget {
    return &TimeoutBudget{total: total, remaining: total}
}

func (b *TimeoutBudget) Allocate(portion float64) (time.Duration, bool) {
    allocated := time.Duration(float64(b.total) * portion)
    if allocated > b.remaining {
        allocated = b.remaining
    }
    if allocated <= 0 {
        return 0, false
    }
    b.remaining -= allocated
    return allocated, true
}
```

### Junior → FAANG: Dependency Analysis as a Design Interview Skill

System design interviews at FAANG consistently test dependency thinking, though often implicitly. When the interviewer asks "how does this scale?" or "what is the blast radius if this component fails?", they are asking you to trace dependencies. The candidate who can draw the dependency graph and reason about it fluently has a significant advantage.

Before your interview, practice mapping the dependencies of a system you know: draw the runtime dependencies (what must be running for this to work), the data dependencies (what data sources does this read and write), and the operational dependencies (what infrastructure must exist for this to deploy). This three-layer dependency map is more complete than the typical architecture diagram and produces better answers to failure-mode questions.

### Senior @ FAANG: Dependency Governance as a Platform Concern

At staff level, dependency management is a platform governance problem. In organizations with many microservices, dependency graphs tend to accumulate cycles, hidden shared mutable state, and implicit ordering constraints that make deployments fragile and failures non-local. The staff engineer who maps the dependency graph across the platform and identifies the highest-risk patterns is providing architectural intelligence that management and product cannot see.

The governance intervention: establish a dependency policy that prevents circular dependencies between service layers, requires explicit versioning for shared data schemas, and mandates documentation of any "must deploy before" operational dependencies. These policies are most effective when enforced by tooling rather than code review, which means the staff engineer needs to also advocate for the investment in dependency analysis tooling.

---
