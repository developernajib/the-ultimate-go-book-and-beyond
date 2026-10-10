## Summary

The table below maps each system component to its technology choice and explains why that technology was selected. This serves as a quick reference during interviews when you need to justify your design decisions.

The division to keep straight is this: Redis absorbs load, PostgreSQL decides outcomes. Every Redis structure here is a cache or a coordination hint whose loss costs throughput and user experience. The one thing that makes a seat someone's is a conditional UPDATE that exactly one transaction can win. Candidates who invert that, and describe the Redis hold as the oversell protection, have designed a system that works in every demo and fails during the one sale that matters.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Virtual queue | Redis sorted set | Fair FIFO ordering |
| Seat inventory | PostgreSQL (truth) + Redis hash (cache) | Real-time availability |
| Seat holds | Redis Lua + expiry index + reaper | Fast-path guard, sheds the losing 99% |
| Hold expiry | Sweeper over a sorted set of deadlines | Returns abandoned seats (a TTL alone does not) |
| Booking | PostgreSQL conditional UPDATE (compare-and-set) | The oversell guarantee |
| Booking idempotency | UNIQUE(hold_id) | Retries collide instead of duplicating |
| Money | Integer cents, end to end | No float drift, no invented value |
| QR codes | Go + S3 | Digital ticket delivery |
| Barcode signing | HMAC-SHA256, constant-time compare | Anti-forgery |
| Gate admission | UPDATE ... WHERE is_used = false | One scan per ticket |
| Queue admission | Deadline-scored active set, Lua-metered | Traffic shaping, self-healing on abandonment |
| Payments | Stripe, idempotency keyed on the hold | Secure card processing |


---
