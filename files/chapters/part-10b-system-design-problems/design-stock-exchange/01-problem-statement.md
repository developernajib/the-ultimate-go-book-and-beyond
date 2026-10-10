## Problem Statement

A stock exchange is unique among system design problems because it combines the hardest aspects of real-time systems (sub-millisecond latency), financial systems (zero tolerance for data loss), and distributed systems (hot-standby failover without split-brain). Unlike most web services where you can retry failed requests, a lost or duplicated order on an exchange can cause real financial harm to participants.

Design a stock exchange (NYSE/NASDAQ-like):
- Process 1 million orders per second
- Match buy/sell orders with < 1ms latency
- Support order types: market, limit, stop, stop-limit
- Maintain order book per security (AAPL, GOOGL, etc.)
- Price/time priority (FIFO at same price level)
- Broadcast trades and order book updates
- Support 10,000 listed securities
- Fault tolerance: no order loss, replay capability
- Regulatory compliance: complete audit trail

The sub-millisecond matching constraint means the entire critical path, receiving the order, validating it, writing to the WAL, and executing the matching algorithm, must complete without any network round-trips or disk I/O on the hot path (except the WAL write, which uses O_DIRECT to bypass the OS page cache). The matching engine must be deterministic: given the same sequence of orders, it must always produce the same sequence of trades, because the hot standby must be able to reconstruct identical state from the WAL.

---
