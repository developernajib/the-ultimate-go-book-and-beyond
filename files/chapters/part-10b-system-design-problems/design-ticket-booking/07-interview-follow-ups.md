## Interview Follow-Ups

**Q: How do you handle the Ticketmaster "Taylor Swift" scenario, 3.5B requests across the onsale?**

1. Virtual queue gates admission: only 10K users/minute (about 167/sec) enter the booking flow
2. CDN serves all static content (seat maps, event info), never hits origin
3. Queue position page is static HTML plus polling, extremely cheap to serve
4. Booking service scales horizontally (stateless behind load balancer)
5. Rate limit: 1 request/sec per IP for queue join
The queue transforms a spike of billions of requests into an orderly 167/sec stream. The number is set by the payment processor, not by the database: everything upstream exists to protect that one narrow pipe.

**Q: What if the hold expires while user is entering payment?**

After the 10-minute hold lapses, the reaper returns the seats to inventory and the user sees "Your hold expired, please select seats again." Warn at 2 minutes remaining so the deadline is never a surprise.

The interesting part is the race, and it is worth being exact because "check the hold before charging" is the answer that sounds right and is not. Checking the hold and then charging is a time-of-check-to-time-of-use gap: the hold can lapse in the milliseconds between the check and the charge, and the reaper can hand the seat to someone else while the payment call is still in flight. No amount of checking first closes that window.

The honest answer is that the hold is not what makes the sale safe. The conditional UPDATE is. So the flow charges, then attempts the compare-and-set, and if the seat is gone it refunds the exact amount charged and reports the failure. A brief authorization on a card that loses the race is recoverable. Two people holding tickets to the same seat is not.

Resist the temptation to extend holds for users who are "actively typing." It sounds user-friendly, it is unbounded in the worst case, and it hands the most patient bot the best seats in the arena.

**Q: How do you handle ticket resale/transfers?**

Transfer: original ticket invalidated, new ticket issued to recipient with new QR code. Resale marketplace: list ticket at no more than 120% of face value (anti-scalping). Resale creates a new booking record, old ticket marked transferred. Dynamic keys: ticket QR code regenerated periodically so screenshots are invalid (Ticketmaster SafeTix).

**Q: How do you prevent bot abuse in the virtual queue?**

Multi-layer bot mitigation strategy:
1. **CAPTCHA at queue entry**: Invisible reCAPTCHA v3 for behavioral analysis, hard CAPTCHA on suspicion.
2. **Device fingerprinting**: Browser fingerprint + IP + user-agent hashed into a session token. Multiple queue entries from same fingerprint deduplicated.
3. **Rate limiting**: 1 queue join per device per 60 seconds, 429 response for excess attempts.
4. **Proof-of-work**: Client solves a lightweight SHA256 puzzle before the queue token is issued. Negligible for one human, a linear tax on a high-rate script, and close to irrelevant against a scalper who can rent CPU. A speed bump, not a wall.
5. **Behavioral analysis**: Mouse movement entropy, keyboard timing, scroll patterns. Bots show unnatural uniformity.
6. **Queue token binding**: Token bound to device fingerprint, so it cannot be shared or sold. The venue check validates the same device.
Real-world: Ticketmaster's Verified Fan program requires fans to register in advance. Queue token only issued to verified accounts, dramatically reducing bot success rate.

**Q: How does seat map consistency work at high concurrency? If 5,000 users see the same seat as "available" and all click it, what happens?**

The seat map displayed to users is a **read-optimized snapshot**, stale by up to 1 second. Actual availability is enforced at hold time, not display time:

1. **Display layer**: CDN-cached seat map on a 1-second TTL. Users see approximate availability.
2. **Hold layer**: a Redis Lua script checks the seat's field in the event's seat hash and claims it in the same atomic unit. 4,999 of the 5,000 get an error, and none of them touch PostgreSQL.
3. **Conflict UX**: Users who lose the race get "Seat just taken, here are similar seats." The system suggests next-best seats automatically using a priority queue ordered by (section, row, seat_number).
4. **Optimistic UI**: Frontend marks the seat "pending" on click. The hold response settles it within ~200ms, over the same HTTP request that asked for the hold, so no WebSocket is involved.

This is optimistic concurrency: show approximate availability, enforce correctness at the transaction boundary. The one thing to be precise about is where that boundary actually sits. The Lua script decides who gets to *try*. The conditional UPDATE in PostgreSQL decides who gets the seat. If the interviewer pushes on "what if Redis fails over and loses every hold," the answer is that bookings get slower and users see more collisions, but nothing oversells, because the hold was never the thing preventing it.

**Q: How do you handle partial failures, where payment succeeds but ticket delivery (QR generation) fails?**

Use a transactional outbox pattern:
1. Booking service writes booking record AND a pending `ticket_delivery` job to the same PostgreSQL transaction (atomically).
2. A background worker polls the `ticket_delivery` table and processes jobs.
3. If QR generation or email fails, the job retries with exponential backoff (max 5 attempts, 1/2/4/8/16 minutes).
4. After max retries, alert on-call for human intervention.
5. S3 PutObject is idempotent (same key, same content) so retries are safe.
6. User receives email "Your tickets are being prepared" immediately after booking. QR codes arrive within minutes even on retry.

This guarantees at-least-once delivery without blocking the booking transaction on external service calls.

**Q: How do you scale the virtual queue position updates to 5 million concurrent users?**

Naively sending WebSocket messages to 5M concurrent connections would require ~50 WebSocket servers. Instead:

1. **Polling over WebSocket for position**: Queue position updates are sent via long-polling (30-second timeout). Client polls every 10 seconds. No persistent connections needed.
2. **Batch position calculation**: Instead of individual Redis queries per user, a background job every 5 seconds scans the queue sorted set and writes position buckets (e.g., "positions 0-1000", "1001-5000") to a single Redis key. Clients in that bucket see the same cached response.
3. **CDN-cacheable responses**: Queue position page is static HTML. Position updates are a small JSON endpoint (position, estimated_wait_minutes). These can be edge-cached with 5-second TTL.
4. **Progressive admission**: Release 10K users/minute into the booking flow. Queue length decreases predictably. Remaining users' wait time estimate stays accurate.

Result: 5M users polled every 10s = 500K req/sec, distributed across CDN edge nodes, and most requests never hit origin.

---
