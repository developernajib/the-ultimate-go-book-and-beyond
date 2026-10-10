## 90G.6 Grab's Counter Service: 5x CPU Reduction by Leaving Go

### The Incident

Grab, the Southeast Asian ride-hailing and delivery company, migrated their fraud detection counter service from
Go to Rust, achieving dramatic resource savings.

**Before (Go):**
- 20 CPU cores for a given QPS target
- Memory usage proportional to Go runtime overhead + GC headroom

**After (Rust):**
- 4.5 CPU cores for the same QPS - a 5x reduction
- Infrastructure cost savings: 70-80%
- Rust consumed approximately 20% of Go's resources at equivalent throughput

### Analysis: Where Go's Overhead Comes From

The 5x CPU gap between Go and Rust on this workload is not a fluke. It reflects a structural difference in how each runtime manages memory. Go's concurrent garbage collector must periodically scan the heap, move the GC write barrier into every pointer write, and pause goroutines for stack scanning. For a counter service that performs millions of small, short-lived allocations per second (increment operations, map lookups, serialization), GC pressure is continuous rather than bursty, consuming roughly 25% of all CPU time. Add the goroutine scheduler's cooperative preemption overhead and the allocator's per-goroutine cache maintenance, and Go spends more than half its cycles on runtime bookkeeping rather than application logic.

```
┌──────────────────────────────────────────────────────────────────────┐
│           Go vs Rust CPU Usage Breakdown (Same QPS)                  │
│                                                                      │
│  Go (20 cores)                    Rust (4.5 cores)                   │
│  ┌──────────────────────┐         ┌──────────────────────┐           │
│  │ Application Logic    │ 30%     │ Application Logic    │ 80%       │
│  │ ████████████         │         │ ████████████████████ │           │
│  ├──────────────────────┤         ├──────────────────────┤           │
│  │ GC (mark + sweep)    │25%     │ (no GC)              │  0%        │
│  │ ██████████           │        │                      │            │
│  ├──────────────────────┤         ├──────────────────────┤           │
│  │ Goroutine scheduler  │15%     │ Async runtime (tokio)│ 10%        │
│  │ ███████              │        │ ████                 │            │
│  ├──────────────────────┤         ├──────────────────────┤           │
│  │ Runtime overhead     │ 15%     │ Runtime overhead     │  5%       │
│  │ ███████              │        │ ██                   │            │
│  ├──────────────────────┤         ├──────────────────────┤           │
│  │ Memory alloc/dealloc │ 15%     │ Stack allocation    │  5%        │
│  │ ███████              │        │ ██                   │            │
│  └──────────────────────┘         └──────────────────────┘           │
│                                                                      │
│  Key insight: Go spends ~55% of CPU on runtime overhead              │
│  (GC + scheduler + allocator + runtime). Rust spends ~20%.           │
│  For a CPU-bound counter service, this difference is massive.        │
└──────────────────────────────────────────────────────────────────────┘
```

### Vercel Turborepo: Type System Limitations

Vercel's migration of Turborepo from Go to Rust highlighted a different problem: Go's type system was too
permissive for cross-platform tooling.

**The specific issue:** Unix file permissions represented as integers would compile on Windows but silently
produce nonsensical values. Go does not have platform-conditional compilation at the type level - the code
compiles on all platforms, but the behavior is undefined on Windows.

Rust's approach: Compilation fails if platform-specific code is used without proper conditional compilation
attributes. The bug is caught at build time, not in production.

**The CGo problem:** Turborepo needed to call C libraries. In Go, CGo forces the entire build to use the slower
C toolchain, and CGo introduces runtime overhead for every C function call. Rust's FFI has zero overhead - it
is a direct function call across the language boundary.

### Lesson for Go Engineers

These migrations do not mean Go is a bad language. They mean that Go engineers must understand the language's
overhead characteristics and choose the right tool:

| Workload | Go | Rust | Recommendation |
|---|---|---|---|
| Web API services | Excellent | Excellent | Go (faster development) |
| CPU-bound hot paths | Good | Excellent | Consider Rust for critical paths |
| Large in-memory caches | Challenging (GC) | Excellent | Evaluate GOMEMLIMIT first, then Rust |
| Cross-platform CLI tools | Good (but permissive) | Excellent (compile-time guarantees) | Depends on safety requirements |
| Network proxies (low latency) | Good | Excellent | Rust for sub-microsecond requirements |
| Microservice fleet | Excellent | Good (slower development) | Go (developer productivity wins) |
| Fraud detection / counters | Good | Excellent | Rust if cost optimization is priority |

The senior Go engineer's job is not to defend Go in every situation. It is to choose the right tool for the job
and to know when Go's trade-offs (runtime overhead in exchange for development speed and safety) are not the right
trade-offs for a specific workload.

### Junior → FAANG: Right-Tool-for-Job as an Engineering Principle

Interviewers at FAANG companies probe language choice reasoning. The Grab counter service case demonstrates that the same language change (Go to a different runtime model) can have dramatically different outcomes depending on the workload characteristics. Candidates who say "Go is always the right choice for microservices" or "Rust is always faster" are not demonstrating engineering judgment. The correct framing is: measure the bottleneck, understand the root cause, evaluate mitigations in the current language, and only then consider a language change.

### Senior @ FAANG: Runtime Model Selection at Platform Scale

At L6, the lesson from Grab's counter service is that CPU budget allocation is a platform concern, not a per-service concern. A 5x CPU reduction on one service frees resources for other services. At FAANG scale, systematic identification of services with high CPU-to-value ratios (high compute cost, low throughput impact) and targeted runtime model changes can free significant infrastructure budget. This is the kind of cost-optimization leverage that staff engineers identify through fleet-wide analysis rather than per-service profiling.

The key governance question is: who makes the call to change the runtime model for a service, and what evidence is required? At a well-run FAANG company, this decision requires a performance ADR with measured baseline, measured improvement after the change, and a migration risk assessment. The decision is reviewed by a technical lead outside the team to ensure it is reproducible and documented.

---
