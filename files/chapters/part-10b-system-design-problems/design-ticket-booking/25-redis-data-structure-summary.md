## Redis Data Structure Summary

Redis is the backbone of the real-time layer in this system, and the data type chosen for each key follows from how it is read. Sorted sets carry anything with an ordering or a deadline (the queue, live admissions, hold expiries), hashes carry the seat inventory for field-level reads and writes, and strings carry cached blobs and counters.

Two choices here are load-bearing rather than cosmetic. **Admission is a sorted set scored by deadline, not a set plus a per-user token.** One structure answers both "is this user admitted?" and "how many are in the flow right now?", and entries age out on their own, so an abandoned checkout frees its slot without anyone reporting it. **Every hold is registered in an expiry index**, because a TTL on a hold key deletes the hold without touching the seat hash. The index is what the reaper reads to put those seats back.

```
# Seat inventory (per event)
seats:{eventID}          HASH  (seatID -> "available"|"held:{holdID}"|"sold:{bookingID}")

# Virtual queue (per event)
queue:{eventID}          ZSET  (member=userID, score=join_timestamp)

# Live admissions: membership AND concurrency count in one structure.
# Score is the deadline, so ZREMRANGEBYSCORE retires abandoned checkouts.
admitted:active:{eventID} ZSET (member=userID, score=admission_deadline_unix)

# Admission throughput, bucketed per wall-clock minute so it yields a RATE.
# A single cumulative key whose TTL is refreshed on every write never expires
# and measures nothing.
queue:throughput:{eventID}:{minute} STRING (integer, TTL=5min)

# Holds. Keyed by holdID (not userID: one user may hold twice), and the value
# is the hold's own seat list, so confirming never scans the seat hash.
hold:{eventID}:{holdID}  STRING (comma-separated seatIDs, TTL=hold+grace=900s)

# Hold expiry index: what the reaper sweeps to return lapsed seats to
# inventory, and the authority on whether a hold is still live. The hold key
# outlives this deadline by a grace window so the seat list survives to be read.
holds:expiry:{eventID}   ZSET  (member=holdID, score=expires_at_unix)

# Presale codes (EXPIREAT valid_until + 1 day, so they do not accumulate)
presale:{eventID}:{code} HASH  (max_uses, used_count, valid_from, valid_until, max_tickets)
presale:users:{eventID}:{code} SET (userIDs who used this code)

# Seat map cache (rebuilds collapsed by singleflight on expiry)
seatmap:snapshot:{eventID} STRING (JSON, TTL=1-30s depending on sale status)
```

None of these keys is a source of truth. Every one of them is either a cache of PostgreSQL, or coordination state whose loss costs throughput and user experience rather than correctness. If this entire keyspace were flushed mid-sale, holds would vanish and users would collide on seats far more often, but no seat would sell twice, because the sale is decided by a conditional UPDATE in PostgreSQL and reconciliation would rebuild the seat map from it.


---
