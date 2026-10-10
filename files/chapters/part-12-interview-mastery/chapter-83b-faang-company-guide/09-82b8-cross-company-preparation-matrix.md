## 83B.8 Cross-Company Preparation Matrix

Each company weights interview dimensions differently based on its engineering culture and the problems it cares most about. Amazon's 40% behavioral weight reflects its Leadership Principles-driven hiring process, where demonstrating ownership and customer obsession matters as much as coding. By contrast, Datadog and Cloudflare place 30-35% weight on Go-specific knowledge because their core infrastructure is written in Go and new hires are expected to contribute to production systems immediately. Use this matrix to allocate study time proportionally rather than preparing uniformly across all dimensions.

```
┌──────────────┬──────────┬──────────┬───────────┬───────────┬───────────┐
│   Company    │ Coding   │ System   │Behavioral │ Go-Spec.  │   Total   │
│              │ Weight   │ Design   │  Weight   │  Weight   │  Rounds   │
├──────────────┼──────────┼──────────┼───────────┼───────────┼───────────┤
│ Google       │   40%    │   25%    │   20%     │   15%     │   4-5     │
│ Meta         │   50%    │   25%    │   15%     │   10%     │   4-5     │
│ Amazon       │   30%    │   20%    │   40%     │   10%     │   4-5     │
│ Apple        │   35%    │   25%    │   20%     │   20%     │   5-6     │
│ Netflix      │   25%    │   35%    │   30%     │   10%     │   5-6     │
│ Microsoft    │   35%    │   25%    │   25%     │   15%     │   4-5     │
│ Stripe       │   35%    │   30%    │   15%     │   20%     │   4-5     │
│ Uber         │   30%    │   30%    │   15%     │   25%     │   5-6     │
│ Cloudflare   │   30%    │   30%    │   10%     │   30%     │   4-5     │
│ Datadog      │   30%    │   25%    │   10%     │   35%     │   4-5     │
└──────────────┴──────────┴──────────┴───────────┴───────────┴───────────┘
```

### Universal Preparation Priorities

Regardless of your target company, the following preparation order maximizes your chances across all companies:

**Priority 1: Core Coding (Weeks 1-4)**
- Arrays, strings, hash maps - appears in every company
- Trees and graphs - BFS/DFS is universal
- Dynamic programming - required for Google, Meta, Amazon
- Sliding window, two pointers, binary search - high-frequency patterns

**Priority 2: System Design (Weeks 3-8)**
- Fundamentals: load balancing, caching, database sharding, message queues
- Company-specific: streaming (Netflix), payments (Stripe), real-time (Uber)
- Go-specific design: goroutine pools, channel patterns, context propagation

**Priority 3: Behavioral (Weeks 5-10)**
- Amazon LP stories (transferable to all companies)
- Netflix culture stories (demonstrate seniority)
- Growth mindset stories (Microsoft, but universal)

**Priority 4: Go-Specific (Weeks 6-12)**
- Concurrency: goroutines, channels, select, sync primitives
- Internals: GC, scheduler, memory model, escape analysis
- Production patterns: graceful shutdown, health checks, metrics

### Mapping Your Preparation to This Book

| Topic | Chapters | Companies That Test It |
|-------|----------|----------------------|
| Arrays & Strings | Ch. 65-66 | All |
| Trees & Graphs | Ch. 67-68 | All |
| Dynamic Programming | Ch. 71-73 | Google, Meta, Amazon |
| Concurrency | Ch. 18-25 | Google, Uber, Cloudflare, Datadog |
| System Design | Ch. 80 | All (heavy: Netflix, Stripe, Uber) |
| Go Internals | Ch. 26-30 | Google, Apple, Datadog |
| Production Go | Ch. 31-40 | Netflix, Stripe, Cloudflare |
| Behavioral | Ch. 81 | All (heavy: Amazon, Netflix) |
| API Design | Ch. 41-48 | Stripe, Meta, Microsoft |
| Database | Ch. 49-55 | Amazon, Stripe, Airbnb |


### Junior → FAANG: Using a Cross-Company Preparation Matrix

A cross-company preparation matrix maps your preparation activities against the specific requirements of each company you are targeting. The rows are companies. The columns are preparation dimensions (coding, system design, behavioral, company-specific knowledge). Each cell contains your current readiness level and the specific gaps you need to address. This structure prevents the common mistake of over-preparing one dimension for all companies when the differential between companies is on a different dimension.

### Senior @ FAANG: Cross-Company Matrix as a Portfolio Strategy

Senior candidates running multiple interview loops simultaneously should treat the process as a portfolio strategy. The goal is to have at least two strong offers from companies at the appropriate level, because the negotiation leverage of a competing offer is significant. The cross-company matrix helps you identify where your preparation overlaps (most coding preparation transfers across companies) and where it is company-specific (Amazon LP stories, Apple platform knowledge, Google algorithm depth). Sequencing interview loops by difficulty is also a preparation strategy: start with companies where you are more confident to build interview stamina, and schedule your highest-priority company later in the loop when your skills are sharp. Be honest about readiness signals: if mock interviews reveal consistent gaps in a specific area, delay the loop for that company rather than attempting the interview and burning the opportunity.

---
