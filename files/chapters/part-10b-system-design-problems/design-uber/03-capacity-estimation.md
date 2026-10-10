## Capacity Estimation

Before diving into architecture, you need to understand the scale of the system you are building. Capacity estimation helps you choose the right technologies, for example, 1.25 million location writes per second rules out disk-based databases and points toward in-memory stores like Redis. These numbers also determine how many servers you need and how much data you will store over time.

```
Trips/day:            10M → 115/sec average, ~350/sec peak
Drivers online:       5M concurrent drivers globally
Location updates:     5M × (1/4 per sec) = 1.25M writes/sec
Location store:       Each driver: {lat, lng, timestamp, status} = 64 bytes
                      5M × 64B = 320MB active in Redis
Nearby queries:       100M riders × 5 searches/day = 500M/day = 5,787/sec
Trip records:         10M trips × 1KB each = 10GB/day, ~3.65TB/year
Payment events:       10M/day × 256 bytes = 2.56GB/day

WebSocket connections: 5M drivers + 3M active riders = 8M persistent connections
                       → 8M / 200 servers = 40K connections per server
```

The 1.25 million location writes per second is the number that drives the entire technology stack. This write rate eliminates PostgreSQL with PostGIS (which would need hundreds of replicas at this rate) and points directly to Redis GEO, where in-memory sorted set operations handle this volume with sub-millisecond latency. The 320MB active dataset for driver locations fits comfortably in a single Redis node's memory, though you would still shard by geographic region for fault isolation. The 8 million WebSocket connections require 200 gateway servers, these are the most operationally sensitive component because each server holds stateful connections that must be gracefully drained during deployments.

---
