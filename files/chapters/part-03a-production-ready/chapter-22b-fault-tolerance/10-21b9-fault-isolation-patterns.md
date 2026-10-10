## 22B.9 Fault Isolation Patterns

### Per-Tenant Bulkhead (Noisy Neighbor Prevention)

In multi-tenant systems a single high-traffic tenant can exhaust the shared concurrency budget and degrade every other tenant, the noisy neighbor problem. A per-tenant bulkhead map lazily creates an independent semaphore per tenant ID, ensuring that one tenant hitting capacity does not affect others. A double-checked lock prevents duplicate creation under concurrent initialization.

Lazy creation keyed on a request value has a sharp edge that is easy to miss. Every new key allocates a bulkhead **and** a set of Prometheus series that live for the life of the process. If the key comes straight off an untrusted header, anyone can mint unlimited tenants by sending a random `X-Tenant-ID` on each request, and the map, the metric registry, and eventually the heap grow without bound. That is a denial of service delivered through the very mechanism meant to provide isolation. Two rules follow: resolve the tenant from the authenticated principal rather than a client-supplied header, and cap the number of distinct tenants you are willing to track.

```go
// ErrTooManyTenants is returned when the tenant cap is reached. Failing
// closed here is deliberate: silently sharing a bulkhead would reintroduce
// the noisy neighbor problem this type exists to prevent.
var ErrTooManyTenants = errors.New("tenant bulkhead: tenant limit reached")

type TenantBulkheadMap struct {
    mu         sync.RWMutex
    heads      map[string]*BulkheadWithMetrics
    defaultN   int
    maxTenants int
    reg        prometheus.Registerer
}

func NewTenantBulkheadMap(defaultN, maxTenants int, reg prometheus.Registerer) *TenantBulkheadMap {
    return &TenantBulkheadMap{
        heads:      make(map[string]*BulkheadWithMetrics), // A nil map panics on write.
        defaultN:   defaultN,
        maxTenants: maxTenants,
        reg:        reg,
    }
}

func (m *TenantBulkheadMap) Get(tenantID string) (*BulkheadWithMetrics, error) {
    m.mu.RLock()
    b, ok := m.heads[tenantID]
    m.mu.RUnlock()
    if ok {
        return b, nil
    }

    m.mu.Lock()
    defer m.mu.Unlock()

    // Re-check under the write lock: another goroutine may have created it
    // between the RUnlock and the Lock.
    if b, ok = m.heads[tenantID]; ok {
        return b, nil
    }

    if len(m.heads) >= m.maxTenants {
        return nil, fmt.Errorf("%w: %d tenants", ErrTooManyTenants, len(m.heads))
    }

    b, err := NewBulkhead(BulkheadConfig{
        Name:          "tenant_" + tenantID,
        MaxConcurrent: m.defaultN,
    }, m.reg)
    if err != nil {
        return nil, err
    }
    m.heads[tenantID] = b
    return b, nil
}

func TenantIsolationMiddleware(bm *TenantBulkheadMap) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Derive the tenant from the authenticated principal. Trusting
            // X-Tenant-ID lets any caller pick their own isolation bucket,
            // impersonate another tenant's quota, or mint tenants forever.
            tenantID, ok := tenantFromContext(r.Context())
            if !ok {
                http.Error(w, "unauthenticated", http.StatusUnauthorized)
                return
            }

            b, err := bm.Get(tenantID)
            if err != nil {
                http.Error(w, "tenant capacity unavailable", http.StatusServiceUnavailable)
                return
            }

            err = b.Execute(r.Context(), func(ctx context.Context) error {
                next.ServeHTTP(w, r.WithContext(ctx))
                return nil
            })

            switch {
            case err == nil:
                return
            case errors.Is(err, ErrBulkheadFull):
                w.Header().Set("Retry-After", "1")
                http.Error(w, "tenant capacity exceeded", http.StatusTooManyRequests)
            case errors.Is(err, context.Canceled):
                // The client hung up. Nothing to write.
            default:
                // Do not fall through silently. An unhandled error here
                // returns 200 with an empty body, which reads as success.
                http.Error(w, "internal error", http.StatusInternalServerError)
            }
        })
    }
}
```

### Async Isolation for Slow Operations

Slow operations such as analytics event emission or non-critical notifications can block the HTTP handler goroutine and inflate response latency for the caller. An `AsyncIsolator` decouples these side effects from the request path by dispatching them to a bounded worker pool. If the queue is full, the operation is dropped rather than blocking the caller.

Be exact about what that trade actually costs. Dropping a full queue is **data loss**, not eventual consistency: eventual consistency means the write lands late, whereas this write never lands at all. That distinction decides what may legitimately go through this path. Analytics samples, cache warming, and best-effort notifications are fine to drop. **Audit logs are not.** If a regulator or a security investigation expects an audit record to exist, silently discarding it under load is the failure mode that turns a busy afternoon into a compliance incident, and it will happen precisely during the traffic spike you most want a record of. Anything that must not be lost belongs in a durable queue, where backpressure or a rejected request is the honest answer.

```go
// Protect the synchronous request path by offloading slow operations.
type AsyncIsolator struct {
    queue   chan func(context.Context)
    dropped atomic.Int64
    timeout time.Duration
    wg      sync.WaitGroup
}

func NewAsyncIsolator(workers, queueSize int, timeout time.Duration) *AsyncIsolator {
    a := &AsyncIsolator{
        queue:   make(chan func(context.Context), queueSize),
        timeout: timeout,
    }
    for i := 0; i < workers; i++ {
        a.wg.Add(1)
        go func() {
            defer a.wg.Done()
            for fn := range a.queue {
                // Every task gets its own deadline. context.Background() with
                // no timeout means one wedged task holds a worker forever,
                // and enough of them silently starve the pool to zero.
                ctx, cancel := context.WithTimeout(context.Background(), a.timeout)
                fn(ctx)
                cancel()
            }
        }()
    }
    return a
}

// Submit queues fn, returning false if it was dropped. Callers should treat
// false as a data-loss event and count it.
func (a *AsyncIsolator) Submit(fn func(context.Context)) bool {
    select {
    case a.queue <- fn:
        return true
    default:
        // Queue full, so drop. This is a metric worth alerting on: a
        // steadily rising Dropped() is silent data loss.
        a.dropped.Add(1)
        return false
    }
}

func (a *AsyncIsolator) Dropped() int64 { return a.dropped.Load() }

// Shutdown drains the queue and waits for workers to finish. Without this,
// process exit discards whatever is still queued.
func (a *AsyncIsolator) Shutdown() {
    close(a.queue)
    a.wg.Wait()
}
```

### Staff Lens: Isolation Enables Continued Operation

Fault isolation is the discipline that keeps one failure from becoming all failures. Every shared resource (goroutine pool, connection pool, cache) is a potential cascade vector. Isolate by criticality so critical paths have dedicated capacity.

---
