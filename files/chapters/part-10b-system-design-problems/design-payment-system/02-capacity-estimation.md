## Capacity Estimation

Before diving into architecture, you need to understand the scale your system must handle. Capacity estimation helps you choose the right storage engines, decide when to partition data, and plan for peak traffic. The numbers below are based on a mid-to-large payment platform processing roughly 100 million transactions per day, which translates to modest average throughput but significant peak bursts during events like flash sales or holiday shopping.

```
Transactions/day:   100M → 1,160/sec avg, 5K/sec peak
Transaction size:   500 bytes
Storage/day:        100M × 500B = 50GB
Transaction DB:     PostgreSQL with partitioning
Fraud signals:      500 features evaluated per txn
Ledger entries:     2 per transaction (debit + credit) = 200M/day
Settlement:         Batch process nightly per acquirer
```

The peak of 5K/sec (roughly 4x the average) reflects holiday shopping periods and flash sales, where transaction volume spikes dramatically for short periods. The system must sustain this rate without degradation, which means all components, database writes, fraud evaluation, and processor API calls, must be provisioned for peak, not average.

Each transaction record (500 bytes) includes the transaction ID, idempotency key, merchant ID, amount, currency, status, fraud score, processor reference, failure details, and timestamps. The 50GB/day growth rate means monthly partitioning of the transactions table is essential to keep queries against recent data fast. After 12 months, the table holds 18TB of data, manageable with partition pruning but impractical without it.

The ledger grows at twice the transaction rate (200M entries/day) because every payment creates both a debit and a credit entry. This is the fundamental trade-off of double-entry bookkeeping: you use 2x the storage in exchange for the ability to detect data corruption by verifying that all entries sum to zero. At 100GB/day for the ledger alone, this table becomes the largest in the system and must also be partitioned by time.

Fraud evaluation at 500 features per transaction seems expensive, but most features are pre-computed velocity counters stored in Redis (sorted sets with TTL-based expiration). The actual per-transaction work is mostly Redis lookups and a single ML model inference, which completes in under 50ms on a GPU-backed inference service.

---
