## Performance Characteristics

A stock exchange's value proposition collapses without microsecond-level guarantees: arbitrage strategies become unprofitable if match latency is unpredictable, and high-frequency traders will route orders elsewhere. The numbers below reflect a contention-free, single-goroutine-per-symbol design, eliminating cross-symbol mutex contention is what pushes order-acceptance-to-match latency below 100 µs at P99. WAL writes dominate the budget at 30-50 µs, so NVMe SSDs with `O_DIRECT | O_SYNC` are non-negotiable for the durability path.

```
Matching Latency:
  - Order acceptance to first match: < 100 microseconds (P99)
  - WAL write (NVMe SSD with fsync): 30-50 microseconds
  - Heap push/pop: < 1 microsecond
  - Total end-to-end: < 500 microseconds

Throughput:
  - Per symbol: 10,000 orders/sec (single goroutine)
  - Per node: 1,000 symbols x 100 orders/sec avg = 100,000 orders/sec
  - Cluster: 10 nodes = 1,000,000 orders/sec

Memory:
  - Per order in heap: ~200 bytes
  - Per symbol: 10,000 resting orders x 200B = 2MB
  - Per node: 1,000 symbols x 2MB = 2GB
  - Total cluster: 20GB (fits in memory easily)

Market Data:
  - Updates generated: ~200,000 trades/sec + 1M orderbook updates/sec
  - Multicast bandwidth: 1.2M msgs/sec x ~50B binary = ~60MB/sec = ~500 Mbps
  - WebSocket fan-out: 50,000 subscribers x 100 updates/sec

Recovery:
  - Snapshot size: ~2GB per node (all open orders)
  - Snapshot interval: every 10 seconds
  - WAL replay rate: 500,000 entries/sec
  - WAL to replay: 10s x 1M orders/sec = 10M entries = ~20 seconds
  - Snapshot load: ~5 seconds
  - Time to recover from crash: ~25 seconds, budget < 30 seconds
  - Hot standby lag: < 100ms
```

The recovery numbers are the ones to be able to derive on a whiteboard, because they are a closed loop rather than a list. The 30-second target minus the 5 seconds to load a 2GB snapshot leaves 25 seconds of replay, and at 500,000 entries per second that is 12.5 million entries. A peak of 1M orders/sec fills that budget in 12.5 seconds, so snapshots go every 10 seconds and the recovery lands around 25. Change any one of those numbers and the interval moves with it. This is also why "we snapshot hourly" is a wrong answer rather than a tuning preference: 3.6 billion entries at 500K/sec is two hours of replay.


---
