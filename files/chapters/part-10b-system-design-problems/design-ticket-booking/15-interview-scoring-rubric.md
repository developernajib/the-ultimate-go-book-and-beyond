## Interview Scoring Rubric

This rubric maps what interviewers expect at each level. The virtual queue is the single most important architectural element, mentioning it unprompted is often the line between L4 and L5. L6 candidates must demonstrate understanding of security threats (bots, ticket fraud) and operational concerns (reconciliation, pre-scaling).

### L4, Expected
- Basic seat inventory with status tracking (available, held, sold)
- Simple booking flow: select seat, pay, confirm
- Mentions overselling prevention (at least at the database level)
- Understands the problem is about concurrent access to limited inventory

### L5, Strong Hire
- Virtual queue for high-demand sales (the thundering herd solution)
- Redis Lua script for atomic seat holds (check and claim in one atomic unit)
- Two-layer oversell protection, and can say which layer is the guarantee: Redis is the fast path that sheds load, the PostgreSQL conditional UPDATE is what actually prevents the oversell
- QR code with HMAC signing for ticket forgery prevention
- Hold expiration, and knows that the TTL alone does not return seats to inventory: a sweeper over an expiry index is what does
- Articulates the Taylor Swift scenario: 5M users chasing 100K tickets, demand arriving in the first 60 seconds, admission metered at 10K/min so the sale itself takes ~12 minutes
- Discusses the two operating modes (normal browsing vs. sale events)

### L6, Exceptional
- All L5 plus:
- Best-available seat algorithm (contiguous seats, center-of-row preference, scored by section)
- Resale marketplace with anti-scalping price caps (120% of face value) and atomic ownership transfer
- Inventory reconciliation between Redis and PostgreSQL to detect and fix drift
- Transactional outbox pattern for reliable event publishing
- Pre-warming and auto-scaling strategy for sale events (scale up before, scale down after)
- Bot mitigation: multi-signal scoring, CAPTCHA challenges, device fingerprinting, proof-of-work
- Seat map caching with CDN and short TTLs during active sales
- Dynamic rotating QR codes (SafeTix) that invalidate screenshots within 30 seconds

---
