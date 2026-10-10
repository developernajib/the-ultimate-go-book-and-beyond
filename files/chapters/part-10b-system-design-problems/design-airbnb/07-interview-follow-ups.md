## Interview Follow-Ups

These are the most commonly asked follow-up questions in Airbnb system design interviews. Interviewers use them to probe the depth of your understanding beyond the initial design. Having concise, well-reasoned answers ready for these questions demonstrates that you have thought through edge cases and real-world operational concerns.

**Q: How do you prevent double booking?**

Three-layer protection working in sequence. Layer 1: when a guest begins checkout, a Redis `SETNX` command atomically places a hold on the requested dates with a 10-minute TTL. This is the fast-path guard, if another guest tries to book the same dates, the SETNX fails immediately. It is not sufficient on its own because overlapping but different date ranges produce different hold keys. Layer 2: when the payment is authorized, the booking service runs a PostgreSQL transaction that takes a per-listing advisory lock (`pg_advisory_xact_lock`), re-checks `blocked_dates` for overlap, and only then inserts the new range. A plain `SELECT ... FOR UPDATE` overlap check is not enough here, row locks cannot lock rows that do not exist yet, so two concurrent transactions could each see no overlap and both insert. Layer 3: a gist exclusion constraint on `(listing_id, daterange)` makes the database itself reject overlapping ranges, so even a buggy code path cannot commit a double-booking. All three layers must pass for a booking to complete.

**Q: How does Airbnb handle instant book vs. host approval?**

Two distinct flows share the same calendar hold mechanism. For Instant Book listings, the checkout flow skips host approval entirely: the guest selects dates, the system places a Redis hold, authorizes payment, confirms the booking, and captures payment, all in one session. For Request-to-Book listings, the flow pauses after creating a `pending_request` record and notifying the host. The host has 24 hours to accept or decline via the app. A calendar hold is still placed during this pending state to prevent another guest from double-booking while the host decides. If the host declines, the payment authorization is voided and the calendar hold is released. If the host does not respond within 24 hours, the request expires automatically and the guest is notified.

**Q: How do you scale search to 8,680 QPS?**

Search is overwhelmingly read-heavy (the read-to-write ratio exceeds 750:1), which makes horizontal scaling straightforward. The Elasticsearch cluster uses 10 or more shards distributed across multiple nodes, with each node handling a subset of the listing index. Since listings change infrequently (hosts update their listing details far less often than guests search for them), geo-based search results can be cached aggressively in Redis with a 5-minute TTL. The expensive part of search is the availability check: after Elasticsearch returns candidate listings based on location and filters, the service must verify that each listing is actually available for the requested dates. This is done with a batched SQL query against the `blocked_dates` table using an indexed date range overlap check, which processes 50 listings in a single round trip rather than one query per listing.

---
