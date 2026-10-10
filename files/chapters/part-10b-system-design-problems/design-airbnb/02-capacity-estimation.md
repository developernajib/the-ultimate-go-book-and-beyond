## Capacity Estimation

Before diving into architecture, you need to understand the scale you are designing for. These back-of-the-envelope numbers drive every technology choice that follows, for example, 8,680 search queries per second tells you that a single relational database will not suffice for search, while 11.5 bookings per second is manageable with a well-indexed PostgreSQL instance. Pay attention to the read-to-write ratio: search is overwhelmingly read-heavy, which makes caching and read replicas highly effective.

```
Listings:           7M active listings
Searches/day:       150M MAU → ~30M daily actives × 25 searches = 750M = 8,680/sec
Bookings/day:       1M bookings/day = 11.5/sec
Calendar updates:   7M listings × 10 updates/day = ~810/sec writes
Availability reads: 8,680 search QPS × 20 listings/page = ~173K availability checks/sec
Reviews:            2M reviews/day
Messages:           10M messages/day
```

The search QPS (8,680/sec) is the dominant read workload and dictates the need for Elasticsearch rather than querying PostgreSQL directly. A single PostgreSQL instance with proper indexes can handle approximately 5K simple read queries per second, but search involves geo-distance calculations, multi-field filtering, and availability joins that push individual query times above 50ms, unacceptable for the 200ms target. Elasticsearch sharded across 10 or more nodes handles this comfortably.

The booking rate (11.5/sec) is modest enough that a single PostgreSQL master can process all writes, but the availability check rate requires Redis caching. Each search result page shows 20 listings, and each listing needs an availability check against the requested date range. Without caching, that is 173K PostgreSQL queries per second just for availability, a non-starter. Redis-cached availability sets with a 60-second TTL reduce the database load to a manageable level.

---
