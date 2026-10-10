## 83E.15 Interview Questions

Five FAANG-style low-level design questions with model answers in Go.

### Q1 (Google): Design a thread-safe in-memory key-value store with TTL support. What interfaces and structures would you use?

**Answer:** Define a `Store` interface with `Get(key) (value, bool)`, `Set(key, value, ttl)`, and `Delete(key)`. Back it with a `sync.RWMutex`-guarded `map[string]entry` where `entry` holds value and expiry timestamp. Run a background goroutine that scans expired keys on a tick (lazy expiration on `Get` is also required for correctness). For higher throughput, shard the map by key hash to reduce lock contention. Discuss eviction policy (LRU, LFU) as an extension via the strategy pattern.

### Q2 (Amazon): Design a parking lot system. Walk through the class hierarchy and key behaviors.

**Answer:** Core entities: `ParkingLot`, `Level`, `ParkingSpot` (with `SpotType` enum: Compact, Large, Handicapped, EV), `Vehicle` (interface implemented by Car, Truck, Motorcycle), `Ticket`, `PaymentProcessor`. The `ParkingLot` exposes `Park(vehicle) (Ticket, error)` and `Leave(ticket) (Fee, error)`. Use the strategy pattern for spot allocation (nearest entry, by size). Use a min-heap of free spots per level for O(log n) allocation. Mention concurrency: spot reservation must be atomic, so use per-level mutexes or a CAS approach.

### Q3 (Meta): Design an LRU cache from scratch. Why is a doubly linked list plus hash map the canonical answer?

**Answer:** The hash map gives O(1) lookup. The doubly linked list gives O(1) move-to-front and tail-eviction. Each map value points to a list node containing key, value, prev, and next pointers. On `Get`, look up the node and move it to head. On `Put`, insert at head and evict from tail if over capacity. Storing the key in the node is required so eviction can also remove the map entry. In Go, wrap with `sync.Mutex` for thread safety, or shard for concurrency.

### Q4 (Apple): Design an elevator system for a building with N floors and M elevators. How do you dispatch?

**Answer:** Model `Elevator` with state (current floor, direction, request queue), `ElevatorController` for dispatch, and `Request` (source floor, destination, direction). Dispatch strategies: nearest-elevator, SCAN (sweep up then down), or LOOK. Each elevator maintains a sorted set of stops in its current direction. On a new request, the controller scores each elevator by estimated time to serve and picks the minimum. Use a goroutine per elevator with a request channel. The controller fans out via select.

### Q5 (Netflix): Design a rate limiter as a reusable Go package. Which algorithm and why?

**Answer:** Expose `Allow(key string) bool` and `Wait(ctx, key) error`. Implement token bucket: each key has a bucket with capacity C and refill rate R tokens per second. On `Allow`, refill based on elapsed time and consume one token if available. Token bucket allows bursts up to C, which fits API quotas better than fixed window (which has boundary spikes). Use `sync.Map` for per-key buckets and `sync.Mutex` per bucket. For distributed deployment, back with Redis using Lua scripts for atomic refill and consume.


### Junior → FAANG: LLD Practice Interview Questions

The LLD interview questions in this section are practice prompts for the full LLD interview workflow: entity identification, interface design, implementation, and extensibility discussion. For each question, practice the complete workflow rather than jumping to the code. The design discussion phase (before writing any code) should take at least 5 minutes for each problem, during which you confirm the requirements, identify the entities, and sketch the interfaces.

### Senior @ FAANG: LLD Interview Questions as a Senior Design Vocabulary Builder

Senior candidates should use these LLD interview questions to build a vocabulary of design patterns and their Go implementations. After completing each question, identify which design patterns you used and why, and think about whether a different pattern would have worked better. Over time, this builds an internalized pattern vocabulary that you can draw on in real interviews and in production code design. The goal is not to memorize pattern names but to recognize which structural problems each pattern solves and to implement them fluently in Go.

---

## Summary

Low-level design (LLD) evaluates your ability to translate abstract requirements into clean, idiomatic, maintainable Go code. Across the 10 core systems and 5 FAANG interview questions in this chapter, success rests on five non-negotiable principles:

1. **Behavior Before Data:** Always define interfaces first (`ParkingLot`, `Elevator`, `RateLimiter`) before writing struct definitions.
2. **Composition Over Inheritance:** Leverage Go's struct embedding and interface composition rather than simulating deep OOP class hierarchies.
3. **Concurrency-Safe by Default:** Protect mutable state with fine-grained mutexes (`sync.Mutex`, `sync.RWMutex`), channel coordination, or lock-free atomics where appropriate.
4. **Idempotence & Clean Error Handling:** Ensure all public APIs return descriptive typed errors (`ErrSpotUnavailable`, `ErrQuotaExceeded`) and support context cancellation (`context.Context`).
5. **Pattern Fluency:** Master Strategy, State, Observer, and Decorator patterns implemented idiomatically with Go interfaces and function closures.

---

*Next chapter: Chapter 83F - The Complete FAANG Study Plan*

