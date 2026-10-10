## Capacity Estimation

Before designing any component, you need to understand the traffic patterns that drive architectural decisions. Ticket booking systems have two radically different operating modes: normal browsing (low traffic) and sale events (extreme bursts). The numbers below show why a standard web architecture would collapse during a high-demand sale, and why features like virtual queuing and aggressive caching are non-negotiable.

```
Normal traffic:     10K concurrent users, 100 bookings/sec
Sale event peak:    5M concurrent users, 50K booking attempts/sec
Queue depth:        5M users waiting × ~100B sorted-set entry = ~500MB queue state
Ticket inventory:   100K seats, each assigned to 1 of 10 price tiers = 100K seat records
Seat map:           Stadium: 70K seats, arena: 20K, theater: 3K
QR codes:           100M tickets × 2KB = 200GB
Pre-sale window:    First N fans with presale codes
```

The 500x difference between normal booking traffic (100/sec) and sale-event demand (50K attempts/sec) is the single most important number in this design. It means you cannot size infrastructure for average load, the system must pre-scale before each sale event. The virtual queue reduces the actual booking service load from 50K attempts per second to roughly 167 bookings per second, the 10,000 users per minute the admission controller lets through. The binding constraint is the payment processor: per-merchant throughput caps sit in the low hundreds of charges per second unless negotiated higher, which is why 167 per second needs charges spread across two merchant accounts rather than one.

The seat map is the most frequently accessed read: during a sale, 5M users refresh the map continuously to see which seats are still available. At 1 refresh per second per user, that is 5M seat map requests per second, far beyond what any origin server can handle. CDN caching with a 1-second TTL collapses that into roughly one origin request per second per edge location, serving all 5M users from the edge. The trade-off is that the seat map is up to 1 second stale, so some users will see seats as available that have already been held. That is acceptable because the map is only a hint: the atomic hold rejects the losers at request time, and the database uniqueness constraint is the final authority on who owns the seat.

---
