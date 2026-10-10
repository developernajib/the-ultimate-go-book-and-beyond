## Redis Data Structures

Redis serves as the real-time data layer for multiple components in the Uber architecture. Understanding the exact Redis commands used helps you explain your design concretely in an interview. Below are the key data structures: GEO sets for driver locations, hashes for driver metadata, simple counters for surge pricing demand/supply tracking, and rate-limiting counters to prevent abuse. Each key includes a TTL to automatically clean up stale data.

```
# Driver location (Redis GEO)
GEOADD drivers:geo {longitude} {latitude} "driver_123"

# GEOSEARCH, not GEORADIUS: Redis has deprecated GEORADIUS since 6.2.
# Cost is O(N+log M), N = members in the search area, M = set size. It is fast
# because the region-sharded key keeps N small, not because it is logarithmic.
GEOSEARCH drivers:geo FROMLONLAT {lng} {lat} BYRADIUS 5 km ASC COUNT 20 WITHCOORD WITHDIST

# Driver status metadata
HSET driver:status:{driver_id} status "available" lat 40.7128 lng -74.0060
                                  heading 180 speed 25.5 updated_at 1711234567
EXPIRE driver:status:{driver_id} 300  # 5 min TTL (stale driver removal)

# Surge pricing counters
INCR demand:{h3_cell}:{minute}
EXPIRE demand:{h3_cell}:{minute} 600  # 10 minutes

# Supply: TTL must be several times the refresh interval. Refreshed every 30s,
# expires after 120s. Setting the TTL equal to the refresh period means the key
# expires exactly as it is rewritten, and any hiccup leaves supply reading 0.
# Since 0 supply is the input that produces maximum surge, a late refresh job
# would triple the fare for the cell. Give the TTL room to absorb a missed tick.
SET supply:{h3_cell} 15 EX 120

# Trip state
HSET trip:{trip_id} status "on_trip" driver_id "d_123" rider_id "r_456"
                      pickup_lat 40.7128 pickup_lng -74.0060
                      started_at 1711234567

# Driver earnings accumulator (a display cache, NOT the ledger)
# INCRBY, not INCR: INCR takes no argument and always increments by one.
# `INCR key 1750` is not "add 1750", it is an error at runtime:
#   ERR wrong number of arguments for 'incr' command
INCRBY driver_earnings:{driver_id}:{week} 1750

# Rate limiting per rider (max 10 ride requests per hour)
# INCR and EXPIRE must be atomic. Run as separate commands, a crash between them
# leaves a key with no TTL that counts forever and locks the rider out.
# Use a Lua script, a MULTI/EXEC transaction, or set the TTL only on first use.
INCR ride_rate:{rider_id}:{hour}
EXPIRE ride_rate:{rider_id}:{hour} 3600
```

Two notes on what Redis is doing here and what it is not.

The earnings accumulator is a counter for showing a driver their week-to-date total, not the record of what they are owed. Redis can lose writes on failover, and "we lost your earnings" is not a recoverable conversation. The `driver_earnings` table in PostgreSQL is authoritative, and this key is a fast read that can be rebuilt from it.

The demand counters go the other way. They are allowed to be lossy, because surge is an estimate of the last five minutes and a dropped increment moves the multiplier imperceptibly. Deciding which of your counters can lose a write, and being able to say why, is most of what separates using Redis well from using it everywhere.

---
