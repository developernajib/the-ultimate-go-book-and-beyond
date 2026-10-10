## Common Mistakes and How to Avoid Them

These errors represent the most common gaps interviewers observe. The virtual queue is the most important one, failing to mention it often moves the evaluation from "hire" to "no hire."

1. **No virtual queue**: Without a queue, 5 million users hitting the booking service simultaneously will exhaust database connections, overflow connection pools, and cause cascading timeouts within seconds. The virtual queue IS the key design element of this system. Every other component depends on the queue reducing traffic to a manageable rate.

2. **DB locks held across a checkout**: Using `SELECT FOR UPDATE` to hold a seat for the duration of a checkout creates massive lock contention. Row locks are designed for transactions lasting milliseconds, not for a 10-minute flow that includes a call out to a payment processor. Redis holds keep that contention out of the database. Note the mistake is holding the lock *across the user's checkout*, not using the database at all: the short transaction that actually sells the seat still belongs in PostgreSQL, and it is still the thing preventing the oversell.

   The mirror-image mistake, and the more dangerous one, is concluding from this that the Redis hold is the protection. Then someone reasons that since Redis already guarantees it, the database check is redundant, removes it, and the system oversells the first time a Redis replica gets promoted mid-sale.

3. **Trusting client for availability**: When 50,000 users are viewing the seat map simultaneously, dozens of them see the same seats as "available." Client-side availability checks are meaningless, the server must perform an atomic check-and-hold in a single Redis Lua script. Any gap between the check and the hold creates a race condition window.

4. **No idempotency on payment**: Users click "Pay" and see a loading spinner. If the request times out, they click again. Without an idempotency key, the second click creates a second charge. Every payment call must carry a key derived from something that exists *before* the charge, such as the hold ID. Reaching for the booking ID is a common slip, because the booking does not exist yet at the moment of the charge. Note that reusing a key with different parameters is a 400 from Stripe rather than a silent success, which is the behavior you want: it surfaces the bug instead of hiding it.

   Idempotency at the payment processor is only half of it. The booking write needs its own guard, and it has to be a constraint: `UNIQUE(hold_id)`, so a retry collides. Checking "does a booking already exist for this hold?" and then inserting is a read-then-write race that two concurrent retries both pass.

5. **Hold expiration edge case**: If the 10-minute hold expires while the user is entering payment details, the seat can go to someone else. The tempting fix, and the wrong one, is "verify the hold is still valid immediately before charging." That is a time-of-check-to-time-of-use gap: the hold can lapse in the microseconds between the check and the charge, so checking first narrows the window without ever closing it.

   The real answer is that the hold is not what makes it safe. Charge, then attempt the conditional UPDATE, and if the seat is gone, refund. This is also why "charging a customer for a seat someone else got" is not an irrecoverable inconsistency: it is a refund. Two people holding tickets to seat A17 is the irrecoverable one, and that is the trade being made.

6. **Not discussing scale modes**: Normal browsing traffic (hundreds of QPS) and sale event traffic (millions of QPS) require completely different infrastructure configurations. Candidates who design only for one mode miss a fundamental aspect of the problem. Pre-scaling, queue activation, and CDN cache warming must all be part of the sale event preparation plan.

---
