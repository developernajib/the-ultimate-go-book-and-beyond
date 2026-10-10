## Rate Limiting Architecture Overview

The rate limiting architecture illustrates the choice between in-process token bucket limiters (fast but not distributed), Redis-backed sliding window counters (accurate across replicas), and API gateway enforcement (centralized but adding a network hop). The right choice depends on whether the deployment is single-instance or multi-replica.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                      RATE LIMITING ARCHITECTURE                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    RATE LIMITING ALGORITHMS                            │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │  │
│  │  │  Fixed Window    │  │  Sliding Window  │  │  Token Bucket    │      │  │
│  │  │                  │  │                  │  │                  │      │  │
│  │  │  ┌──┬──┬──┬──┐   │  │  ←─────────────→ │  │  ●●●●● ← refill  │      │  │
│  │  │  │10│10│10│10│   │  │  Weighted count  │  │  ●●●   ← current │      │  │
│  │  │  └──┴──┴──┴──┘   │  │  across windows  │  │                  │      │  │
│  │  │                  │  │                  │  │  Allows bursts   │      │  │
│  │  │  Simple, but     │  │  Smooth, more    │  │  up to bucket    │      │  │
│  │  │  boundary spike  │  │  accurate        │  │  size            │      │  │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────┘      │  │
│  │                                                                        │  │
│  │  ┌──────────────────┐                                                  │  │
│  │  │  Leaky Bucket    │  ← Processes at constant rate                    │  │
│  │  │                  │  ← Queue excess requests                         │  │
│  │  │  │▓▓▓▓▓▓▓│ →→    │ ← Drop when queue full                           │  │
│  │  │  └───────┘       │                                                  │  │
│  │  └──────────────────┘                                                  │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     RATE LIMITING FLOW                                 │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Request ──► Extract Key ──► Check Limit ──► [Allow?] ──► Handler      │  │
│  │                    │              │              │                     │  │
│  │                    ▼              ▼              ▼                     │  │
│  │              ┌─────────┐   ┌──────────┐   ┌──────────┐                 │  │
│  │              │ IP      │   │ In-Memory│   │ Allow    │                 │  │
│  │              │ User ID │   │ or Redis │   │ Set Rate-│                 │  │
│  │              │ API Key │   │          │   │ Limit    │                 │  │
│  │              │ Endpoint│   │          │   │ headers  │                 │  │
│  │              └─────────┘   └──────────┘   │          │                 │  │
│  │                                           │ Deny:429 │                 │  │
│  │                                           │ +Retry-  │                 │  │
│  │                                           │ After    │                 │  │
│  │                                           └──────────┘                 │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                    DISTRIBUTED RATE LIMITING                           │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │     ┌──────────┐    ┌──────────┐    ┌──────────┐                       │  │
│  │     │ Server 1 │    │ Server 2 │    │ Server 3 │                       │  │
│  │     └────┬─────┘    └────┬─────┘    └────┬─────┘                       │  │
│  │          │               │               │                             │  │
│  │          └───────────────┼───────────────┘                             │  │
│  │                          │                                             │  │
│  │                          ▼                                             │  │
│  │                  ┌───────────────┐                                     │  │
│  │                  │ Redis Cluster │                                     │  │
│  │                  │  ┌─────────┐  │                                     │  │
│  │                  │  │LuaScript│  │  ← Atomic increment                 │  │
│  │                  │  └─────────┘  │  ← Check limit                      │  │
│  │                  │               │  ← Set expiry                       │  │
│  │                  └───────────────┘                                     │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                      TIERED RATE LIMITING                              │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Tier       │ Rate        │ Burst │ Cost Multiplier                    │  │
│  │  ───────────┼─────────────┼───────┼─────────────────                   │  │
│  │  Anonymous  │ 60/min      │ 10    │ 1x                                 │  │
│  │  Free       │ 100/min     │ 20    │ 1x                                 │  │
│  │  Basic      │ 1,000/min   │ 100   │ 1x                                 │  │
│  │  Pro        │ 10,000/min  │ 500   │ 1x                                 │  │
│  │  Enterprise │ 100,000/min │ 2000  │ Custom                             │  │
│  │                                                                        │  │
│  │  Endpoint Overrides:                                                   │  │
│  │  POST /login     → 5/min   (brute force protection)                    │  │
│  │  POST /export    → 10/hour (expensive operation)                       │  │
│  │  GET  /search    → 30/min  (moderate protection)                       │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     RESPONSE HEADERS                                   │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Success (200):                     Rate Limited (429):                │  │
│  │  ┌───────────────────────────────┐  ┌───────────────────────────────┐  │  │
│  │  │ RateLimit-Policy:             │ │ RateLimit-Policy:            │    │  │
│  │  │   "api";q=100;w=60            │ │   "api";q=100;w=60           │    │  │
│  │  │ RateLimit: "api";r=95;t=45    │ │ RateLimit: "api";r=0;t=45    │    │  │
│  │  │                               │  │ Retry-After: 45              │   │  │
│  │  └───────────────────────────────┘  └───────────────────────────────┘  │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```


### Junior → FAANG: Reading Architecture Diagrams as Decision Maps

Architecture diagrams like the one above are not decoration. Each box and arrow represents a decision with trade-offs you need to be able to articulate. When an interviewer shows you a diagram similar to this, they expect you to identify what is missing, not just describe what is present.

Looking at the distributed rate limiting section: three servers converge on a single Redis cluster. A junior engineer reads this as "Redis stores the counter." A senior engineer asks: what happens when Redis is unavailable? The diagram does not show a fallback. In an interview, naming the gap and proposing a fallback (fail-open with a local limiter, or fail-closed with a fixed 429) is what moves you from a hire to a strong hire.

The tiered table shows rates from 60/min (anonymous) to 100,000/min (enterprise). A first-job exercise: sketch the data model you would use to store these tiers in a database, including which fields change per customer and which are defaults. That sketch surfaces questions about tenant isolation, runtime tier changes without restarts, and how to audit limit changes over time.

For the response headers section, the two boxes (success and rate-limited) show the minimum header set. Note the shape: the IETF draft consolidated the older split `RateLimit-Limit` / `-Remaining` / `-Reset` trio into a single `RateLimit` header carrying `r` (remaining) and `t` (seconds until reset) for a named policy, with `RateLimit-Policy` describing the quota `q` and window `w`. Before your next code review, check whether your own service reports the reset as seconds remaining or as a Unix timestamp. The draft specifies seconds remaining. Emitting a timestamp where a client expects a delta makes the client sleep for decades.

### Senior @ FAANG: Evaluating This Architecture Against Production Requirements

The diagram represents a clean, correct reference architecture for a single-region deployment. At FAANG scale, several dimensions push beyond what the diagram shows.

**Multi-region consistency.** When the same API key is used from Tokyo and Virginia simultaneously, both regional Redis clusters increment separate counters. The user's effective limit becomes 2x the configured limit. Solutions range from consistent hashing (route a key to exactly one region) to eventual consistency (accept the overshoot and reconcile periodically) to a global counter service (single source of truth with the latency cost of a cross-region call). Each has a different cost structure. The architecture choice belongs in an ADR with measured latency data.

**Tiered limits as a runtime configuration system.** The tier table shown is hard-coded in the diagram. In production, tiers change: a customer upgrades, a sales team negotiates a custom limit, an incident response team temporarily raises a limit for an affected enterprise account. This requires a configuration system with versioning, audit logging, and propagation latency guarantees. If your limit store takes 60 seconds to propagate a change to all nodes, that propagation delay is part of your SLA contract with customers.

**Header semantics under distributed state.** The remaining count in the `RateLimit` header is computed at the time of the request. If two concurrent requests from the same client hit two different servers, both might report `r=1` and both might be allowed, effectively admitting one more request than the limit allows. This is the inherent trade-off of distributed systems. The correct engineering response is to document the acceptable overshoot (typically one request per replica per window boundary), not to attempt perfect accuracy at the cost of a synchronous global lock.

**Observability gaps in this diagram.** The architecture does not show where rate limit events are logged, what dashboards monitor limit utilization, or how an on-call engineer detects that a client is approaching their limit before they hit 429s. A production-grade architecture includes a metrics pipeline that tracks `rate_limit_allowed_total`, `rate_limit_rejected_total`, and `rate_limit_utilization_ratio` per key and per tier, with alerting when utilization exceeds 80 percent for more than 60 seconds.
