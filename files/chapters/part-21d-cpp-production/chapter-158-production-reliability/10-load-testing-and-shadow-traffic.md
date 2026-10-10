## Load Testing and Shadow Traffic

Synthetic load tests answer "does the binary handle X QPS?" That is a useful question, but it is not the most useful question. The most useful question is "does the new version of this binary respond to real production traffic the same way as the old version?" The tool that answers that is shadow traffic, and it is the highest-signal pre-deploy test that exists.

### Synthetic Load: What It Catches

A synthetic load tester (wrk, hey, vegeta, or your own C++ harness) sends fabricated requests at a target rate and measures latency, throughput, and error rate. It catches:

- Throughput ceilings.
- Saturation behavior (does the server fall over gracefully?).
- Memory leaks under sustained load.
- File descriptor exhaustion.
- Connection-pool sizing errors.

What it does not catch:

- Bugs that depend on real input distributions.
- Regressions on rare query types.
- Correctness regressions (synthetic tests typically check status codes, not response bodies).
- Cache hit-rate changes (synthetic tests have unrealistic key distributions).

The fix is shadow traffic.

### Mirroring Live Production Traffic

Shadow traffic mirrors real requests from a production frontend to a candidate backend, without affecting the user-facing response. The user sees the production response. The candidate's response is captured for offline comparison.

Architecture:

```
client -> frontend -> [primary backend] -> response to client
                 \
                  --> [candidate backend] -> response captured, discarded
```

The frontend duplicates every request (or every Nth request to limit candidate load), sends it to both backends, returns the primary's response, and ships the candidate's response to a logging pipeline.

Implementation considerations:

- **Request duplication.** Request bodies must be cloned. For large bodies, this is non-trivial.
- **Idempotency.** Shadow requests must not have side effects. A POST that writes to a database cannot be shadowed without breaking. Solution: shadow only read requests, or run the candidate against a database snapshot.
- **Latency budget.** The frontend must not block on the candidate. Fire-and-forget the shadow call.
- **Rate limiting.** The candidate cluster has finite capacity. Shadow only K% of traffic.

A C++ frontend mirroring sketch:

```cpp
class MirroringFrontend {
public:
    void Handle(Request* req) {
        auto primary_future = primary_->SendAsync(req);

        // Fire shadow asynchronously, do not wait
        if (ShouldShadow(req)) {
            auto shadow_req = req->Clone();
            shadow_pool_.Submit([this, shadow_req = std::move(shadow_req)]() {
                auto resp = candidate_->Send(*shadow_req);
                shadow_logger_->Log(*shadow_req, resp);
            });
        }

        auto primary_resp = primary_future.Get();
        ReplyToClient(primary_resp);
    }
};
```

The shadow pool has bounded capacity. If it fills, shadow requests are dropped, never the primary path.

### DiffTester: Comparing Responses

The shadow logger captures (request, primary_response, candidate_response) tuples. A separate batch job (the DiffTester) compares them.

Naive diff: byte-for-byte. Useless in practice, because timestamps, sequence numbers, and floating-point rounding produce noise.

A real DiffTester has a tolerance specification:

```cpp
// Per-field comparison rules
DiffRule rules[] = {
    {".timestamp", IGNORE},
    {".trace_id", IGNORE},
    {".scores[*]", FLOAT_TOLERANCE(0.001)},
    {".results[*].id", EXACT},
    {".results[*].rank", EXACT},
    {".total_count", EXACT},
};
```

For each (request, primary, candidate) tuple, the DiffTester walks the response, applies rules, and emits a diff record if any rule fails.

The output is aggregated:

- 99.7% of responses match within tolerance: probably safe to deploy.
- 95% match: investigate the systematic drift.
- 50% match: do not deploy.

The headline number lies. Always look at the breakdown by request type. A 99.7% overall match rate that hides "99.99% on common queries, 0% on rare ones" is a deploy-blocker.

### Replay from Logs

Mirroring requires modifying the frontend. A simpler alternative: capture production requests in logs, replay them later against a candidate.

```bash
$ tail -F /var/log/myservice/access.log | grep -v __health__ \
  | replay --target candidate.internal:8080 --rate 100
```

Pros:

- No frontend modification.
- The candidate can run in a staging environment, decoupled from production.
- The same captured corpus can be replayed against many candidates.

Cons:

- Time-shifted, the candidate sees yesterday's traffic, not today's.
- Stateful operations (writes) can either be skipped or run against a snapshot.

The replay tool needs to:

- Replay at the original rate, faster, or slower (configurable).
- Optionally skip writes (filter by HTTP method or RPC name).
- Capture candidate responses for diff.

Most internal teams write their own replay tool against their RPC framework (gRPC, Thrift, internal protocol). The pattern is universal, the implementation is service-specific.

### Fuzzing via Load: Chaotic Load

A standard load test sends well-formed requests. A chaotic load test deliberately injects malformed or pathological inputs:

- Requests with malformed UTF-8.
- Requests with extreme sizes (1-byte and 1-MB).
- Requests with deeply-nested structures.
- Requests with hash collisions in known hash maps.
- Requests with edge-case numeric values (`INT_MIN`, `NaN`, `inf`).
- Connections that disconnect mid-request.
- Connections that send one byte per second (slow-loris).
- Concurrent identical requests (test caches and dedupe).

A chaotic load harness combines synthetic load with fuzzing patterns. Run it before every release. The bugs it finds are the ones that adversarial users would otherwise find for you.

### DiffTester in Practice

A real example: a search ranking service migrated from a hand-tuned scoring function to a learned model. Unit tests passed. Synthetic load tests passed. The team ran shadow traffic for 24 hours and ran DiffTester.

The headline match rate was 96%. Drilling down: queries with fewer than 10 candidate documents matched at 99.5%. Queries with 1000+ candidates matched at 81%. Investigating, the team found that the new model produced subtly different ordering for tied scores, and ties were common in long lists. Users would not have noticed (the products were equivalent), but the engineering team would have spent weeks chasing "ranking is different from yesterday" complaints from internal users.

The team adjusted the new model to break ties the same way as the old one. Match rate went to 99.4%. Deploy went smoothly.

The DiffTester saved them from an avoidable internal escalation.

### Shadow Latency Budget

The shadow pool's capacity determines the maximum shadow rate. A common setup:

- Primary handles 100K QPS.
- Shadow runs at 10K QPS (10% sampling).
- Candidate cluster sized for 12K QPS (20% headroom).

If the candidate cluster lags or fails, shadow logging drops, but the user-facing primary is unaffected. The shadow pool's queue depth and reject rate are themselves SLI signals: a candidate that cannot keep up with shadow traffic is also a candidate that cannot keep up with promotion.

### What Goes Wrong

- **Shadow with side effects.** A naive shadow of a POST request writes the same row twice. Solution: read-only shadow, or candidate writes to a separate database.
- **Shadow latency leaks into the primary.** If the frontend blocks on the shadow, the candidate's slow response slows the user. Solution: fire-and-forget, with a hard timeout.
- **Diff noise drowns the signal.** Without good tolerance rules, every response differs in some trivial way and the DiffTester is useless. Solution: invest in the tolerance specification.
- **Shadow corpus is not representative.** Sampling that biases toward small requests misses the big-request bugs. Solution: stratified sampling across request size and type.

### Senior at FAANG: The Pre-Deploy Bar

The senior bar is "we do not promote a release until shadow has matched at 99.5% on the request types we care about." That bar is enforced by the deploy pipeline, not by hope. Building the shadow infrastructure is a one-time cost. The savings (avoided rollbacks, avoided regressions, avoided customer-visible incidents) compound forever.

---
