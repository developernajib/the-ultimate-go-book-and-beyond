## Summary: Performance Optimization Checklist

### Quick Wins
- ✅ Enable pprof endpoints in production
- ✅ Pre-allocate slices with known capacity
- ✅ Use `strings.Builder` for concatenation
- ✅ Configure database connection pools
- ✅ Enable HTTP keep-alive
- ✅ Use `sync.Pool` for frequent allocations
- ✅ Write benchmarks with `-benchmem`

### Profiling
- ✅ Profile before optimizing
- ✅ Use `go tool pprof` with web UI
- ✅ Check both CPU and memory profiles
- ✅ Enable mutex/block profiling for concurrency issues
- ✅ Use execution tracer for goroutine issues

### Memory
- ✅ Reduce allocations (stack > heap)
- ✅ Check escape analysis (`go build -gcflags='-m'`)
- ✅ Use value receivers for small types
- ✅ Avoid `interface{}` in hot paths
- ✅ Pre-size maps and slices
- ✅ Close response bodies for connection reuse

### Concurrency
- ✅ Use atomic operations for counters
- ✅ Shard locks to reduce contention
- ✅ Avoid false sharing with padding
- ✅ Use worker pools instead of unbounded goroutines
- ✅ Profile mutex contention

### I/O
- ✅ Buffer reads and writes
- ✅ Batch database operations
- ✅ Use prepared statements
- ✅ Configure connection pools appropriately
- ✅ Use context for timeouts

### Network
- ✅ Enable HTTP/2
- ✅ Configure keep-alive timeouts
- ✅ Reuse HTTP clients
- ✅ Use connection pooling
- ✅ Compress responses

### Database
- ✅ Avoid N+1 queries
- ✅ Use JOINs or IN clauses
- ✅ Tune connection pool size
- ✅ Use batch inserts for bulk data
- ✅ Use prepared statements

### Benchmarking
- ✅ Use `go test -bench` with `-benchmem`
- ✅ Run multiple iterations (`-count=10`)
- ✅ Compare with `benchstat`
- ✅ Reset timer after setup
- ✅ Prevent compiler optimizations (use results)

### GC Tuning
- ✅ Set `GOMEMLIMIT` in containers
- ✅ Adjust `GOGC` for workload
- ✅ Monitor GC metrics
- ✅ Reduce allocations first
- ✅ Consider off-heap for large datasets

---
