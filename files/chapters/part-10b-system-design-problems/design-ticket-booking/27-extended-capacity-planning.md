## Extended Capacity Planning

This section walks through a concrete capacity planning exercise for the most extreme scenario: a Taylor Swift-level sale with millions of fans competing for limited tickets. The numbers show that the virtual queue reduces the actual booking load to something a single PostgreSQL primary handles without noticing, and that the infrastructure bill for the whole event is small enough to be a rounding error against the revenue.

The part worth internalizing is where the money goes. Compute is nearly free here: fifty pre-warmed API servers for an hour cost less than dinner. The bill is dominated by the CDN, because 2M users polling every 10 seconds for the length of the sale is hundreds of millions of billable requests. That inverts the intuition most candidates bring, which is that the expensive part must be the database.

```
Taylor Swift sale scenario (100K seats, demand arriving in the first 60s,
metered by the queue so the sale itself runs ~12 minutes):

Pre-sale:
  - 5M users registered for Verified Fan
  - 2M qualified (ML scoring)
  - Queue opens 30 min before sale

During sale:
  - 2M users in queue
  - Admission rate: 10K users/minute
  - Booking conversion: 80% (of admitted users)
  - Time to sell out: ~12 minutes

Infrastructure requirements:
  CDN: 2M users polling every 10s = 200K req/sec
    CloudFront handles this easily (edge-cached queue page)

  Queue service: 2M entries in Redis sorted set
    Memory: 2M x ~100 bytes = 200MB (trivial)
    Ops: 200K position queries/sec (GET + ZRANK)
    Solution: 6-node Redis cluster handles this easily

  Booking service: 10K users/min = 167 users/sec
    Each booking: hold + payment + confirm = 3 DB operations
    Total: 500 DB writes/sec (manageable for PostgreSQL)
    Seat holds: 167 Lua scripts/sec in Redis (trivial)

  Payment: 167 charges/sec
    Stripe rate limit: ~100 write ops/sec per account (default)
    Solution: 2 Stripe accounts (primary + overflow)
    Note: this, not the database, is what sets the 167/sec admission rate

  Total API servers needed: 50 (pre-warmed)

Cost for the sale event (~1 hour of scaled infra):
  CDN requests:  2M users / 10s poll x ~42 min = ~500M requests
                 @ ~$0.01 per 10K            = ~$500   <- the whole bill
  50 API servers @ ~$0.34/hr                  = ~$17
  6-node Redis   @ ~$0.20/hr                  = ~$1
  PostgreSQL primary + 2 replicas             = ~$2
  Total: ~$520, of which ~96% is CDN request fees
```


---
