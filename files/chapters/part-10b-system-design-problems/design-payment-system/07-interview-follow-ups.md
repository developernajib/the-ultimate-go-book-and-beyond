## Interview Follow-Ups

These questions probe the failure modes that are unique to payment systems, situations where partial success is worse than complete failure because money is involved.

**Q: How do you handle distributed transactions, what if charge succeeds but DB write fails?**

This is the most dangerous failure mode in a payment system because the customer's card has been charged but your system has no record of it. The three-phase approach prevents this:

1. Write the transaction to PostgreSQL as "pending" BEFORE calling the processor. This is the "point of no return", if this write fails, no external call is made, and the customer is not charged.
2. Call the processor's charge API. The processor uses our transaction ID as its own idempotency key, so re-calling this endpoint returns the same result instead of charging again.
3. Update the transaction status to "captured" or "failed" based on the response.

If the system crashes between steps 2 and 3, a background reconciliation job runs every 5 minutes. It queries all "pending" transactions older than 5 minutes, checks each one against the processor's API (using the transaction ID), and updates the status accordingly. This achieves "effectively exactly-once" without distributed two-phase commit (2PC), which would add unacceptable latency and require all participants to support the protocol.

**Q: How do you prevent race conditions in balance updates?**

Start by noticing which race you actually have. The losing pattern is read-modify-write in application code: `SELECT available`, add the amount in Go, `UPDATE ... SET available = $new`. Two workers read the same starting value and the second write erases the first, so a payment vanishes. Optimistic locking with a version column fixes that by making the second write fail so you can retry it.

But the balance update in the Ledger Service never has this race, because it never reads the value into the application at all: `UPDATE merchant_balances SET pending = pending + $1 WHERE ...` computes the new value from the row's own current value, inside the database, under the row lock the `UPDATE` already takes. Concurrent increments serialize and both land. No version column, no retry loop, no lost update. This is worth saying out loud in an interview, because reaching for optimistic locking here signals that you did not notice the operation is a commutative increment rather than a read-then-write.

What remains is not correctness but contention. Every payment for a given merchant and currency wants the same row, so a large merchant serializes on one row lock. The standard answer is to shard the counter: split the balance into N sub-rows, have each writer increment one at random, and sum the N rows to read the balance. That trades a cheap read for a fast write, which is the right trade when writes vastly outnumber balance reads. The other direction is to drop the materialized balance entirely and sum the ledger on demand, which is always correct and has no hot row, but costs a scan over millions of entries per read. Most systems keep the materialized balance and treat it as a cache that reconciliation re-derives from the ledger.

**Q: How do you handle currency conversion?**

Exchange rates come from a commercial market data feed, refreshed on the order of once a minute and cached in Redis with a short TTL, with a second provider to cross-check so that one source returning a stale or garbled rate does not silently reprice every transaction. Be careful which source you name here: the ECB's euro reference rates are a common wrong answer, because they are published once per working day at around 16:00 CET and the ECB explicitly says they are for information rather than transactions. They are a reasonable sanity bound and a poor pricing source.

The payment request specifies both the charge currency (what the customer pays) and the settlement currency (what the merchant receives). An FX markup is applied at conversion to cover the rate moving between charge and settlement, since you quote a rate now and settle days later and you are carrying that risk in between.

The ledger rule is the part worth being rigid about. Every entry records an amount in a single, stated currency, and a conversion is never a rate silently applied to an existing entry. It is its own pair of entries, out of the source currency and into the target, recording the rate and markup used. This keeps each currency's entries summing to zero on their own terms, and it means any converted amount can be traced back to the exact rate at the exact time it was applied. Mixing currencies inside one balance, or reconverting historical entries at today's rate, destroys that and is unrecoverable after the fact.

---
