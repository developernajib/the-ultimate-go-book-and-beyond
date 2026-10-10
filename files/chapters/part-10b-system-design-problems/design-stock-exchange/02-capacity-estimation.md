## Capacity Estimation

Before diving into the architecture, you need to understand the scale of the system you are building. Capacity estimation helps you choose the right data structures, decide how many servers you need, and identify which components will become bottlenecks first. The numbers below represent peak load for a major exchange like NYSE or NASDAQ, where even small miscalculations can lead to outages during high-volatility trading sessions.

```
Orders/sec:         1M peak
Securities:         10,000 listed
Order book size:    10,000 × (200 bid levels + 200 ask levels) = 4M price levels
Order size:         ~200 bytes
Storage/day:        1M × 86400 × 200B = 17TB/day orders
Trades/sec:         ~200K/sec (20% fill rate)
Market data:        10K securities × 100 updates/sec = 1M updates/sec
Participants:       50K brokers + 5M retail investors
```

The 20% fill rate means that only 1 in 5 orders results in an immediate trade execution. The remaining 80% are limit orders that rest on the book waiting for a matching counterpart, or cancellations. This ratio is typical for a modern exchange, high-frequency traders submit and cancel orders rapidly, which is why cancel-to-trade ratios above 10:1 are common and why the matching engine must handle cancellations as efficiently as new orders.

The 17TB/day storage figure assumes continuous peak load, which is conservative. Real exchanges see most volume during the first and last 30 minutes of the trading day. However, the system must be provisioned for peak because failing to accept orders during a volatility spike is unacceptable. Each order record (200 bytes) includes the order ID, symbol, trader ID, type, side, price, quantity, filled amount, status, timestamp, and sequence number, all needed for the regulatory audit trail.

Market data bandwidth is driven by the 10,000 securities each generating approximately 100 updates per second (trade executions plus order book changes), so roughly 1.2M messages per second once the 200K trades are included. Encoding matters more than it looks here. The 200-byte figure above is the *stored* order record, and a feed built out of records that size would push 240MB/sec, close to 2 Gbps. Real multicast feeds use a compact binary encoding of about 50 bytes per message, which brings the same 1.2M messages/sec down to roughly 60MB/sec, or about 500 Mbps, and that is what the performance targets later in the chapter assume.

---
