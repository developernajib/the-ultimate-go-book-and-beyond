## Capacity Estimation

Before diving into architecture, you need to estimate the scale of the system to make informed decisions about storage, compute, and networking. These back-of-the-envelope numbers help you choose between different database technologies, determine how many servers you need, and identify which components will become bottlenecks first. Pay special attention to the operations-per-second figure, as it drives the choice of OT engine and operation log design.

```
Documents total:    1B docs
Active docs/day:    50M docs with at least one edit
Live at peak:       200K docs open for editing × 3 editors avg = 600K active editors
Operations/sec:     600K editors × 3 ops/sec (typing speed) = ~2M ops/sec peak
Storage:            1B docs × 100KB avg = 100TB
Operations log:     50M docs × ~500 ops/day = 25B ops × 50 bytes = ~1.25TB/day
WebSocket conns:    600K editors + ~2M viewers = ~2.5M concurrent
```

The operations-per-second number (2M peak) is the most important figure here because it determines whether the OT engine can keep up. Note the distinction that produces it: 50 million documents receive at least one edit per day, but only about 200K are being edited at any given moment. Each operation is small (typically 10-50 bytes representing a few characters of insert or delete), but at over a terabyte of log per day, periodic snapshotting (every 30 seconds or 1000 ops per document) is essential to bound recovery time and allow old log segments to be garbage collected.

The 2.5 million concurrent WebSocket connections is the second critical number. Each connection consumes memory for the socket buffer, the user session, and the document subscription. At roughly 10KB per connection, that is about 25GB of socket state across the WebSocket gateway tier, a dozen servers each holding a few hundred thousand connections handles it with failure headroom.

---
