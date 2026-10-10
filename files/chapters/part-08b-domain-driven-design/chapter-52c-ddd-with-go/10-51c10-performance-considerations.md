## 52C.10 Performance Considerations

### Aggregate Loading Performance

Large aggregates with many child entities can be slow to load. Strategies:

**Lazy loading child collections.** Instead of always loading all order lines when you load an order, consider loading them only when accessed. This requires more careful API design but can significantly reduce I/O for operations that only need the aggregate root data.

**Read model for queries.** For read operations, bypass the aggregate entirely. Use the query repository that returns denormalized `OrderView` objects. Do not load a full aggregate just to display it.

**Aggregate snapshots.** For deeply historical aggregates (common in event sourcing), store periodic snapshots so you don't have to replay all events from the beginning. (Covered in Chapter 52D.)

**Optimistic concurrency overhead.** The version-based optimistic concurrency check requires a `version` column on every save. This is cheap (a single WHERE clause condition) but worth measuring under high write contention. If you see many retries, consider partitioning your aggregates more aggressively.

### Repository Query Optimization

Proper indexing is critical for repository performance. Without indexes on foreign key columns and common filter conditions, query times grow linearly with table size. Partial indexes are particularly useful for queries that filter on a specific status value.

```sql
// Add a database index on customer_id for the FindByCustomer query
// migrations/003_add_order_indexes.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_id
    ON orders(customer_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_placed_at
    ON orders(status, placed_at)
    WHERE status = 'pending';  -- Partial index for the stale-order worker
```

### Connection Pooling

Go's `sql.DB` manages a connection pool internally. The default settings are conservative, so you should tune them for your expected concurrency. Setting `MaxOpenConns` prevents connection exhaustion under load, while `ConnMaxLifetime` forces connections to recycle and rebalance across database replicas.

```go
db.SetMaxOpenConns(25)        // Max total connections
db.SetMaxIdleConns(10)        // Max idle connections
db.SetConnMaxLifetime(5 * time.Minute) // Recycle connections
db.SetConnMaxIdleTime(1 * time.Minute) // Return idle connections
```

### Value Types, Pointer Receivers, and Allocation

DDD in Go leans on value types for immutability. This is essentially free for small value objects (`Money` is 24 bytes. Copying it is one or two register moves). It stops being free when a value object embeds slices, maps, or large strings - copying those still only copies the header, but accidentally mutating a shared backing array creates bugs. Rules:

- Small value objects (<= ~64 bytes, no reference types): pass by value everywhere. Methods use value receivers.
- Value objects with internal slices/maps: pass by value, but either deep-copy on construction or treat the internal data as append-only.
- Aggregates: always `*Order`, never `Order`. Mutation is expected. Pointer receivers are correct. A loaded aggregate is a unit of change - you want one instance, not copies scattered across goroutines.
- Domain services: stateless structs. Value or pointer receiver is mostly style. Prefer value if zero-value is usable, pointer otherwise.

Benchmark before optimizing. `go test -bench` on the aggregate load path will show you whether the value-copy overhead you are worried about is real or phantom. In 95% of cases it is phantom - the network round trip to Postgres dominates by four orders of magnitude.

### Avoid Premature Interface Boxing

Every time you accept an interface, Go allocates an interface header (`iface`) and may heap-allocate the concrete value. For hot paths inside the domain, this matters:

```go
// Avoid in a hot loop: accepts interface, allocates iface header per call
func (o *Order) recalculateWith(strategy PricingStrategy) { ... }

// Prefer: concrete type, inlineable, zero allocation
func (o *Order) recalculate() { ... }
```

Keep interfaces at layer boundaries where polymorphism is real. Inside the domain, concrete methods are faster and clearer.

---

### Junior → FAANG: Measuring Before You Optimize

The most dangerous performance optimization is the one you make without measuring. Developers new to Go often worry about value copies, allocations, and interface boxing in the domain layer. These concerns are almost always premature: the database round trip is 4 to 6 orders of magnitude more expensive than a struct copy, and the network call to an external service is another order of magnitude beyond that.

The habit to build now: add `go test -bench` benchmarks to any code you are tempted to optimize before touching it. A benchmark for aggregate loading looks like:

```go
func BenchmarkOrder_Total(b *testing.B) {
    o := buildOrderWith50Lines()
    b.ResetTimer()
    for b.Loop() {
        _ = o.Total()
    }
}
```

Run it with `go test -bench=. -benchmem ./internal/domain/...` and read the output: operations per second and allocations per operation. If the number is in the millions of operations per second and allocations are zero, the optimization is not needed. If you see unexpected allocations on a hot path, then use `go tool pprof` to trace where they come from.

For interview prep: know that `sql.DB`'s connection pool is tunable, and know the four key settings (`MaxOpenConns`, `MaxIdleConns`, `ConnMaxLifetime`, `ConnMaxIdleTime`). Be able to explain what happens when `MaxOpenConns` is reached: new requests wait until a connection becomes available. If they wait too long, the context deadline fires and you get a context timeout, not a connection error. This is a common production issue and interviewers ask about it.

### Senior @ FAANG: Performance Engineering as a Domain-Aware Activity

At the staff level, performance work in a DDD system is domain-aware: you cannot optimize without understanding which aggregates are read-heavy vs. write-heavy, which queries are latency-sensitive (checkout flow) vs. throughput-sensitive (background reconciliation), and which data is hot (current-week orders) vs. cold (archived orders from three years ago).

**Aggregate load performance as a service-level objective.** Every bounded context should have defined p50, p95, and p99 latency targets for its primary aggregate load operation. These targets drive indexing decisions, query design decisions (JSON aggregation vs. N+1), and caching strategy decisions. Without targets, performance work is reactive (fix the slowdown after the customer complains). With targets, it is proactive (the benchmark reports a regression before the next deploy). A Staff engineer sets these targets in the service's SLO document and implements automated benchmark regression detection in CI using `benchstat` to compare benchmark results across commits.

**Read replica routing as a domain-aware decision.** In a DDD application, read replicas are appropriate for query handlers but not for command handlers. A command handler that loads an aggregate must read from the primary to avoid reading stale data that would cause a false optimistic concurrency success. A query handler that loads an `OrderView` can tolerate replica lag because the view is for display only and a few hundred milliseconds of staleness is acceptable. The infrastructure layer implements this with a `ReadDB` / `WriteDB` distinction in the repository: write operations use the primary pool, read operations use the replica pool. This doubles read throughput without touching the domain or application layer.

**Caching and DDD: where it belongs.** Application-layer caching of domain aggregates is dangerous: you can serve stale business rules. The right caching layer is the read model (query results), not the write model (aggregates). A `OrderView` cached in Redis for 10 seconds is safe because it is display-only and stale data causes at worst a slightly outdated list page. A cached `Order` aggregate used to enforce the cancellation window rule is wrong because the cached version may not reflect a concurrent cancel that just committed. The Staff engineer establishes a platform rule: aggregates are never cached. Read models are cached with explicit TTLs and an invalidation mechanism triggered by domain events.

**Optimistic concurrency tuning.** The retry logic for optimistic concurrency conflicts is a performance tuning problem as much as a correctness problem. Naive exponential backoff with jitter is correct but may be too conservative for write-heavy aggregates. A Staff engineer profiles the actual conflict rate per aggregate type in production and tunes the retry parameters accordingly. For low-conflict aggregates (order cancel, which is a one-time operation), one retry is usually sufficient. For high-conflict aggregates (inventory reservation during a flash sale), the right answer is aggregate redesign (shard the stock across N bucket aggregates) rather than more retries. The performance analysis leads to a structural decision, not just a parameter tweak.

---
