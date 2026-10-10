## Performance Testing Checklist

Before launching any ride-sharing platform feature, you must verify it meets the performance targets under realistic load. This checklist defines the key benchmarks and the methods to validate them. Each test simulates production conditions, for example, testing `GEOSEARCH` with 5 million synthetic driver locations, not just a few hundred. Scale matters specifically here: `GEOSEARCH` is O(N+log M), so a benchmark against a few hundred drivers measures nothing that predicts production.

| Test | Target | Method |
|------|--------|--------|
| Location write throughput | > 1.5M/sec | Redis GEO benchmark |
| `GEOSEARCH` query latency | < 5ms for 5M drivers | Load test with synthetic locations |
| Match-to-dispatch latency | < 1 second end-to-end | End-to-end trip request benchmark |
| Trip state transition | < 100ms | Benchmark PostgreSQL + Kafka publish |
| Payment processing | < 3 seconds | Stripe API latency test |
| Surge calculation | < 500ms | Benchmark Redis counter aggregation |
| ETA prediction accuracy | Within 2 minutes | Compare predicted vs actual trip duration |
| WebSocket reconnect time | < 2 seconds | Kill connection, measure reconnect |
| Settlement batch processing | < 1 hour for 1M drivers | Weekly settlement benchmark |
| Fraud detection latency | < 5 seconds post-trip | Benchmark ML model + rule engine |

### Correctness Under Concurrency

Latency targets are the easy half. Every serious bug in this chapter is a correctness bug that a load test reports as a pass, because the system was fast and wrong. These belong in CI, not in a one-off pre-launch exercise.

| Test | Target | Method |
|------|--------|--------|
| Driver double-booking | 0 across 10K concurrent claims | N riders race for one driver, assert exactly one active trip |
| Accept vs offer-timeout race | Exactly one outcome per offer | Fire Accept within microseconds of the 15s expiry, thousands of trials, under `-race` |
| Concurrent WebSocket writers | No corrupted frames | Location ticker plus keepalive pinger on one conn, under `-race` |
| Rating lost update | No rating discarded | Concurrent ratings for one driver, assert the EWMA reflects every score |
| Settlement re-run | 0 double payouts | Run the weekly job three times, assert total paid equals total owed |
| Payment retry storm | 1 charge per trip | Concurrent retries with the same key, assert one succeeded payment row |
| Fraud detector can alert | Alert fires | Feed known-fraudulent input, assert an alert is raised |

That last row looks trivial and is the one most worth having. A fraud detector's healthy state and its broken state are both silence, so nothing about normal operation distinguishes a working detector from two stubbed rules that always return false. Any component whose success looks like nothing happening needs a test proving it can still say something.

Run the concurrency tests with `-race` and with enough trials to hit the window. A race that reproduces once in three thousand attempts is not rare in production, it is roughly hourly at 350 trips per second.

---
