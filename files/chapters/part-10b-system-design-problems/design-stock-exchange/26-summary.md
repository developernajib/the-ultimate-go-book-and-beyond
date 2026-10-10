## Summary

The table below summarizes the major components of the stock exchange system, the technology choices behind each one, and what role they play. When discussing this design in an interview, use this table as a quick reference to show that you understand how all the pieces fit together. Each component was chosen to optimize for a specific concern: the in-memory heap for latency, the WAL for durability, and WebSockets for real-time distribution.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Order book | In-memory heap (per symbol) | < 1ms matching |
| Order routing | One goroutine per symbol | Zero-contention, single-writer matching |
| Fairness | Price-time priority, self-trade prevention | The product the exchange actually sells |
| Money | Integer cents everywhere, never float64 | Exact prices, balanced ledger |
| Determinism | Per-book sequencing, no clocks or UUIDs in matching | Standby replays to identical state |
| Persistence | Write-Ahead Log (WAL) with CRC | No-loss guarantee, detects torn writes |
| Trade storage | PostgreSQL partitioned | Regulatory audit trail |
| Market data | WebSocket broadcast (lossy) | Real-time price feeds |
| Recovery | WAL replay + 10s snapshots | < 30s recovery |
| Failover | Distributed lock + fencing token | Split-brain prevention |
| Clearing | Post-trade settlement service | Idempotent T+1 DVP settlement |
| Risk | Pre-trade margin checks, fail closed | Prevent over-leverage |


---
