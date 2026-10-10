## Performance Testing Checklist

Before deploying a collaborative editor to production, you must verify that every component meets its latency and throughput targets under realistic load. The checklist below covers the most critical performance dimensions, from OT correctness (which must be 100% or users will see corrupted documents) to cross-region latency (which directly affects the editing experience for distributed teams). Use these targets as acceptance criteria for your load tests.

| Test | Target | Method |
|------|--------|--------|
| OT transform correctness | 100% convergence | Fuzz test with random concurrent operations |
| Op apply latency (in-engine) | < 1ms for 50 concurrent users | Benchmark with simulated editing sessions |
| WebSocket message throughput | 10K messages/sec per server | Load test with synthetic edit streams |
| Document load time (cold) | < 2 seconds | Measure snapshot load + op replay |
| Document recovery time | < 5 seconds | Kill doc server, measure time to serve again |
| Snapshot save latency | < 500ms for 1MB document | Benchmark S3 upload |
| Permission check latency | < 5ms (cache hit), < 50ms (miss) | Load test Redis + PostgreSQL fallback |
| Export to PDF | < 10 seconds for 100-page document | Benchmark headless Chrome rendering |
| Concurrent editors limit | 200 users per document | Stress test with simulated typing |
| Cross-region op latency | < 200ms | Measure with editors in different AWS regions |

---
