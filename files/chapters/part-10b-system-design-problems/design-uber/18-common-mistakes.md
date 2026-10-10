## Common Mistakes and How to Avoid Them

These are the most frequent errors candidates make during Uber system design interviews. Each mistake reveals a misunderstanding of the scale or real-time requirements of the system. For example, choosing PostGIS over Redis GEO shows a failure to account for the 1.25 million writes per second that driver location updates generate, a volume that disk-based databases simply cannot sustain.

1. **PostGIS instead of Redis GEO**, at 1.25M writes/sec, disk-based PostGIS cannot keep up. Redis GEO handles this in-memory with O(log N) writes.
2. **Nearest-driver-first**, ignores rating and acceptance rate. A nearby driver with a 70% acceptance rate wastes match attempts.
3. **Global surge pricing**, a single multiplier for the whole city misses hyper-local supply shortages. Use per-H3-cell demand/supply ratios.
4. **Synchronous payment**, charging the rider in the trip-completion path adds seconds of latency and creates a failure dependency. Process payments asynchronously.
5. **No trip state machine**, without explicit states and validated transitions, invalid state changes (e.g., jumping from "requested" to "completed") go undetected.
6. **Ignoring driver rejection**, assuming the first matched driver always accepts. Use a dispatch queue with cascading offers and 15-second timeouts.
7. **HTTP polling for location**, a 64-byte GPS fix carries several hundred bytes of headers plus a handshake per request, so framing costs more than the data. Poll on the rider side and most requests return nothing at all. Use persistent WebSocket connections.
8. **No payment idempotency**, network retries without idempotency keys can double-charge riders. Key on the trip, and know the limit: the same key with different parameters is a 400 from Stripe, not a replay, so retries must send back the stored amount rather than recompute it.
9. **Single-region architecture**, 100ms+ cross-continent latency makes real-time matching impossible. Use geographic partitioning with local Redis clusters.
10. **No driver fairness**, without an idle-time component in the match score, drivers near busy areas monopolize trips while others idle and eventually log off.
11. **Trusting a read to prevent a double booking**, checking that a driver is "available" in Redis and then writing the assignment is a race, not a check, because both riders read available before either writes. Exclusivity comes from an atomic operation or a uniqueness constraint at the write. This is the single most common correctness miss in this problem.
12. **float64 for money**, `int64(fare * 100)` bills 19.99 as 19.98, because 19.99 has no exact binary representation and truncation rounds it down. Use integer minor units everywhere, and round once, at the end.

---
