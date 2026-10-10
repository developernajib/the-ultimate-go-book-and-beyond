## Interview Scoring Rubric

A stock exchange interview is one of the hardest system design questions because it combines real-time performance requirements with financial correctness constraints. This rubric helps you calibrate your preparation.

### L4 (Junior/Mid)
- Order book basics: separate bid and ask sides, matching when prices cross
- Limit order matching: highest bid matches lowest ask when prices overlap
- Database storage for trade records and audit trail
- **Missing at this level (expected):** write-ahead log, hot-standby failover, settlement and clearing

### L5 (Senior)
- Heap-based order book with price/time priority (max-heap for bids, min-heap for asks)
- One goroutine per symbol to eliminate cross-symbol lock contention
- Write-ahead log (WAL) for durability: every order persisted before matching begins
- Market data fan-out via WebSocket with non-blocking sends (drop messages for slow consumers)
- Pre-trade risk checks: margin validation, position limits, rate limiting per trader
- Integer prices in cents/ticks to avoid floating-point non-determinism
- Self-trade prevention so a participant never crosses against their own resting order
- **Missing at this level (expected):** LULD circuit breakers, T+1 DVP settlement mechanics, regulatory compliance details

### L6 (Staff)
- Hot standby with WAL replay: backup matching engine replays same WAL stream, promotes on primary failure
- Split-brain prevention using distributed locks (etcd/ZooKeeper) with fencing tokens (monotonic epoch numbers)
- LULD (Limit Up/Limit Down) circuit breakers: price bands around a rolling reference price that stop trades printing outside them, with a pause only after the security holds a limit state
- T+1 DVP (Delivery versus Payment) settlement: clearing house nets positions, facilitates delivery of securities against payment, and settlement runs are idempotent so a retry cannot pay twice
- FIX protocol implementation for institutional traders (tag=value messages over TCP, with binary encodings such as SBE where latency demands it)
- Deterministic replay: same input sequence always produces same output, enabling hot standby synchronization
- Kernel bypass networking (DPDK/RDMA) for microsecond-level latency reduction on the ingest path

---
