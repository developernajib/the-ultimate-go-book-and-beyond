## Performance Optimization Notes

Every millisecond matters in an ad auction because exceeding the 100ms budget means the publisher shows a blank slot and you lose revenue. This section breaks down exactly how the latency budget is allocated across each step of the auction pipeline, from request parsing (2ms) through DSP bid collection (70ms) to response serialization (1ms). The Go-specific optimizations are particularly important: sync.Pool reduces garbage collection pressure by reusing bid request objects, and pipelining multiple Redis commands into a single network roundtrip saves critical milliseconds. These techniques are what separate a production ad system from a prototype.

```
Latency Budget Breakdown (100ms total):
  - Request parsing + validation:     2ms
  - Targeting index lookup (Redis):   3ms
  - Frequency cap check (Redis):      2ms
  - Budget pre-check (Redis):         2ms
  - Parallel DSP bid requests:       70ms (80ms timeout)
  - Auction winner selection:          1ms
  - Budget atomic deduction (Lua):     3ms
  - Fraud quick-check:                2ms
  - Response serialization:            1ms
  - Network overhead:                  5ms
  - Buffer:                            9ms
  Total:                             ~100ms

Optimization Techniques:
  - HTTP/2 connection pooling to DSPs (no TCP handshake per request)
  - DSP response caching: cache no-bid responses for 30 seconds
  - Circuit breaker: skip DSPs with > 20% timeout rate
  - Pre-computed targeting matches: campaign index refreshed every 5 minutes
  - Batch Redis operations: pipeline frequency + budget + targeting in single roundtrip
  - Protobuf serialization for internal services (several times faster than encoding/json)

Go-Specific Optimizations:
  - sync.Pool for bid request/response objects and per-request temporaries (reduce GC pressure)
  - fasthttp instead of net/http for ad serving endpoint
  - Low-allocation JSON serialization (jsoniter or easyjson)
  - GOMAXPROCS matched to the container CPU limit (automaxprocs) to avoid CFS throttling
```


---
