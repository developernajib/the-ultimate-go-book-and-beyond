## Resilience Pattern Architecture

Resilience patterns form a layered defense around each outgoing call. The following diagram shows the typical ordering, from the outermost rate limiter down to the actual dependency, and how each layer addresses a different failure mode:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Resilience Pattern Layers                              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   Client Request                                                                │
│         │                                                                       │
│         ▼                                                                       │
│   ┌─────────────────┐                                                           │
│   │   Rate Limiter  │ ─── Protects against overload (Layer 1)                   │
│   │  (Token Bucket) │                                                           │
│   └────────┬────────┘                                                           │
│            │                                                                    │
│            ▼                                                                    │
│   ┌─────────────────┐                                                           │
│   │    Bulkhead     │ ─── Isolates resources (Layer 2)                          │
│   │  (Semaphore)    │                                                           │
│   └────────┬────────┘                                                           │
│            │                                                                    │
│            ▼                                                                    │
│   ┌─────────────────┐                                                           │
│   │ Circuit Breaker │ ─── Prevents cascading failures (Layer 3)                 │
│   │  (State Machine)│                                                           │
│   └────────┬────────┘                                                           │
│            │                                                                    │
│            ▼                                                                    │
│   ┌─────────────────┐                                                           │
│   │     Timeout     │ ─── Bounds operation duration (Layer 4)                   │
│   │   (Context)     │                                                           │
│   └────────┬────────┘                                                           │
│            │                                                                    │
│            ▼                                                                    │
│   ┌─────────────────┐     ┌─────────────────┐                                   │
│   │   Retry Logic   │────►│    Fallback     │ ─── Recovery (Layer 5)            │
│   │  (Exp Backoff)  │     │    (Cache)      │                                   │
│   └────────┬────────┘     └─────────────────┘                                   │
│            │                                                                    │
│            ▼                                                                    │
│   ┌─────────────────┐                                                           │
│   │  Dependency     │ ─── External service, database, cache                     │
│   │   (Service)     │                                                           │
│   └─────────────────┘                                                           │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

Failure Propagation Without Resilience:
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│Service A │────►│Service B │────►│Service C │────►│Service D │
│  SLOW    │     │ WAITING  │     │ WAITING  │     │  FAILING │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                │                │                │
     ▼                ▼                ▼                ▼
 Resources        Resources        Resources        Resources
 EXHAUSTED        EXHAUSTED        EXHAUSTED        EXHAUSTED
     │                │                │                │
     └────────────────┴────────────────┴────────────────┘
                            │
                            ▼
                    CASCADING FAILURE

With Circuit Breaker:
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│Service A │────►│Service B │──X──│Service C │     │Service D │
│ HEALTHY  │     │ CB OPEN  │     │ DEGRADED │     │  FAILING │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                      │
                      ▼
               Returns Fallback
               (Fails Fast)
```

### The Ordering Is a Design Decision, Not a Convention

Layer diagrams make the nesting look obvious. It is not. Each ordering choice changes the semantics, and two of them are worth arguing about explicitly.

**Retry inside or outside the circuit breaker?** The layering above places the breaker outside the retry loop, so a single logical call may retry three times before the breaker records anything. The mainstream libraries do the reverse. `failsafe-go` composes outermost-first as `Fallback -> RetryPolicy -> CircuitBreaker -> Timeout -> call`, which puts the breaker *inside* the retry loop. That ordering has two properties you usually want:

- Each attempt is recorded by the breaker individually, so the breaker sees the true request rate and trips on real evidence.
- Once the breaker opens, the *next retry attempt* fails instantly with an open-circuit error instead of waiting for another timeout. The retry loop can then stop early or hand off to the fallback. With the breaker on the outside, an open breaker short-circuits the whole operation, and your retry policy never runs at all.

Neither is universally right. Breaker-outside gives you "one operation, one vote", which stops a single flapping call from tripping the breaker on its own retries. Breaker-inside gives you faster shedding under a real outage. Pick deliberately, and write down which you picked.

**Where the timeout goes matters more than whether you have one.** "Timeout" is not one layer, it is two, and the diagram's single box hides that:

- A **per-attempt** timeout bounds one call to the dependency. It belongs *inside* the retry loop, innermost, next to the call.
- A **total** deadline bounds the entire operation, retries and backoff sleeps included. It belongs *outside* the retry loop.

You need both. With only a per-attempt timeout, three retries against a dependency that hangs for the full timeout each time costs you `3 x timeout` plus backoff, and nothing bounds the total. With only a total deadline, a single wedged attempt consumes the entire budget and no retry ever happens. In Go the total deadline is usually just the caller's `context.Context` arriving with a deadline already attached, and each attempt derives a shorter one from it.

**Fallback belongs outermost**, not hanging off the side of the retry box. It is the thing that catches everything the layers beneath it could not fix: the open breaker, the exhausted retries, the blown deadline, the rejected bulkhead. If it sits inside, it cannot catch the failures of the layers outside it.

### Staff Lens: Where Resilience Lives

In a service mesh environment (Istio, Linkerd), many resilience patterns are handled by the mesh, not the application. Circuit breakers, retries, and timeouts at the RPC layer. The application focuses on business logic.

Outside a mesh, patterns live in application code. Use libraries. Standardize per service.

Know which you are, or you will implement resilience twice (once in app, once in mesh) and get surprising behavior from the interaction.

---
