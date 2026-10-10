## Performance Benchmarks

Benchmark data grounds your design in reality rather than theory. The point-operation latencies confirm that Redis is nowhere near the bottleneck: the booking confirmation is dominated by the external Stripe call at roughly 800ms, three orders of magnitude above any single Redis command.

The one number that deserves a second look is the full seat map read. Fetching 70K hash fields is not a point operation, it is tens of milliseconds and a couple of megabytes on the wire, and it is easy to file it mentally next to the sub-millisecond operations above it because it is a Redis command too. It is not in the same class. That single measurement is the entire justification for the snapshot cache and for collapsing concurrent rebuilds: a thousand goroutines each doing a 37ms, 2MB read against one node, once a second, is a self-inflicted outage.

```
Benchmark results for ticket booking system:

Virtual Queue Operations:
  JoinQueue (ZADD NX):     ~0.3ms
  GetPosition (ZRANK):     ~0.2ms
  AdmitNext (ZPOPMIN):     ~0.5ms for 100 users

Seat Hold Operations:
  Lua script (check + hold 4 seats): ~1ms
  Release hold (Lua CAS):  ~0.3ms
  HGETALL of full seat map: ~37ms for 70K fields, ~2MB transferred
    (measured on loopback: real networks are worse. Never on the hot
     path. This is what the snapshot cache exists to avoid, and what
     singleflight exists to stop from running a thousand times at once.)

Booking Confirmation:
  PostgreSQL transaction:  ~5ms (insert booking + conditional seat update)
  Stripe payment:          ~800ms (external, dominates)
  User-visible total:      ~810ms
  QR generation + email:   ~50ms, off the request path via the outbox

Scale test results (simulated Taylor Swift sale):
  5M queue joins:          completed in 30 seconds (~167K joins/sec)
  10K admits/min:          sustained for the ~12 minutes to sell out
  167 seat holds/sec:      actual load at the admission rate (Redis
                           benchmarks far above this: holds are not the
                           constraint, the payment processor is)
  167 booking confirms/sec: ~500 DB writes/sec, PostgreSQL at ~20% CPU
  Zero oversold tickets:   guaranteed by the conditional UPDATE,
                           independently verified by reconciliation

CDN performance during sale:
  Queue page requests:     200K req/sec (2M users polling every 10s)
  Origin requests:         2K req/sec (cache miss rate: 1%)
  CDN edge cache TTL:      1 second for seat map
  CDN cost for sale event: ~$500 (see the capacity planning section:
                           request fees, not compute, are the bill)
```

---
