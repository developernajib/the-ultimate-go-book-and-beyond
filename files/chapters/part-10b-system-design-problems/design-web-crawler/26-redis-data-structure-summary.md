## Redis Data Structure Summary

Redis serves as the shared state layer across all crawler workers. It stores the exact URL seen-set, per-domain crawl-delay settings, worker registration and heartbeat data, and rolling metrics counters. The key naming conventions below show how data is organized in the Redis keyspace. Understanding these structures matters because Redis memory is one of the most expensive infrastructure costs (roughly 1TB across 20 nodes, dominated entirely by `seen:`), so every key must justify its existence with an appropriate TTL.

```
# URL dedup (seen URLs) -- this is ~99% of the cluster's memory
seen:{url_hash}         STRING ("1", TTL=14 days)

# Domain crawl delay (from robots.txt, milliseconds)
robots:delay:{domain}   STRING (integer ms, TTL=24 hours)

# Worker registration
worker:{workerID}       HASH  (host, status, pages_per_sec, error_rate,
                               last_heartbeat; TTL=90 seconds)

# Crawl metrics (per minute)
metrics:pages:{minute}  STRING (integer, TTL=1 hour)
metrics:errors:{minute} STRING (integer, TTL=1 hour)
metrics:bytes:{minute}  STRING (integer, TTL=1 hour)

# Domain stats (rolling)
domain:crawled:{domain}  STRING (integer, TTL=30 days)
domain:errors:{domain}   STRING (integer, TTL=30 days)
domain:last:{domain}     STRING (timestamp, TTL=30 days)
```

Every key above carries a TTL, and that is deliberate. The `domain:*` counters are the ones that quietly break this rule in most implementations: they look small, but the crawler meets an unbounded supply of new hostnames, so a counter with no expiry is a slow leak that ends in an eviction storm on the cluster that also holds your seen-set. `worker:{id}` expires after 90 seconds because its absence *is* the signal that a worker is gone, and `robots:delay:{domain}` is stored in milliseconds to match `domain_metadata.crawl_delay_ms`, since a site publishing `Crawl-delay: 0.5` rounds to zero in integer seconds and zero means no politeness at all.

The Bloom filter is deliberately absent from this list. It lives in each worker's own heap, all 12GB of it, and is never written to Redis. What Redis holds is the exact set the filter is an approximation of.


---
