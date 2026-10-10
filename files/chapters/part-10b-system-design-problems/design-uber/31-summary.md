## Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| Driver location storage | Redis GEO Cluster | Sub-5ms spatial queries, 1.25M writes/sec |
| Location updates | WebSocket | Persistent, low-overhead bidirectional |
| Driver matching | Multi-factor scorer | ETA + rating + reliability, weights tuned per market |
| Driver assignment | Unique index on active trips | Only a write can exclude a concurrent write |
| ETA prediction | OSRM + traffic cache | Accurate pickup time crucial for rider UX |
| Surge pricing | Redis counters + H3 | Per-cell demand/supply ratio, real-time |
| Trip state machine | PostgreSQL + Kafka | Durable state, event-driven consumers |
| Payment processing | Stripe + idempotency | Safe retries, no double charges |
| Money representation | int64 minor units | float64 loses a cent per fare, at 10M fares/day |
| Driver settlement | Weekly batch transfer | Claim earnings before paying, batched for efficiency |
| Geospatial grid | H3 resolution 9 | ~0.105 km² hexagons, uniform neighbors, open-source |
| Notifications | Firebase (Android) / APNs (iOS) | Push to driver: trip offer, rider: ETA updates |

**Scale numbers to remember:**
- 1.25M driver location writes/sec → Redis in-memory, not disk
- 5,787 nearby-driver queries/sec → Redis `GEOSEARCH` <5ms, and it is O(N+log M), so shard by region to keep N small
- 115 trips/sec average, ~350/sec peak → matches in <1s end-to-end
- 8M WebSocket connections → ~200 gateway servers at 40K each
- ~$220M/month in card fees → the largest line item by far, and not an infrastructure problem

**The idea worth carrying out of this chapter:** every hard bug here is the same bug. Two riders claim one driver, a driver accepts as the offer times out, a retry charges a card twice, a settlement job pays a week twice. In each case the code checks a condition, then acts on it, and something else changed in between. Reads do not exclude concurrent writers. Exclusivity comes from an atomic operation or a uniqueness constraint at the moment of the write, and the check that matters is not "is this allowed" but "did my write win". Get that reflex and the specific fixes stop needing to be memorized.


---
