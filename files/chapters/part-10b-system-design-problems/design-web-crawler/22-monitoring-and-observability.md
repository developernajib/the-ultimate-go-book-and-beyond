## Monitoring and Observability

Running a crawler at 10,000 pages per second without proper observability is like driving blindfolded. You need dashboards that show real-time throughput, error rates per domain, content quality trends, and infrastructure health. The monitoring setup below covers five key dashboard categories and defines alert thresholds that help operators catch problems before they snowball into full crawl failures. In production, these metrics would be exported in Prometheus format and visualized in Grafana.

```
Key Dashboards:

1. Crawl Progress:
   - Pages/sec (current vs target)
   - Total URLs crawled, queued, errored
   - Bytes downloaded/sec
   - Frontier queue depth
   - Bloom filter false positive rate

2. Domain Health:
   - Top 20 domains by crawl volume
   - Error rate by domain
   - Avg fetch time by domain
   - Rate limit violations (429s)
   - Blocked domains count

2b. Politeness and Compliance:
   - Fetches per domain per second (p99 must stay <= 1.0)
   - robots.txt fetch failures (5xx => we must crawl nothing there)
   - URLs skipped as disallowed
   - Requests to a domain from >1 worker (must be 0 outside rebalance)

3. Content Quality:
   - Content dedup rate (SimHash duplicates)
   - Average page quality score
   - Language distribution
   - Empty page rate
   - JavaScript-required page rate

4. Worker Health:
   - Active worker count
   - Dead worker count (last hour)
   - Worker utilization (busy vs idle)
   - Goroutine count per worker
   - Memory usage per worker

5. Infrastructure:
   - Kafka consumer lag (frontier topic)
   - Redis memory usage (seen-set + crawl-delay cache)
   - Bloom filter fill ratio (in worker memory, not Redis)
   - S3 upload rate and errors
   - PostgreSQL query latency
   - DNS cache hit rate

Alerting:
  Critical: throughput <50% target for 10min, all workers dead,
            frontier empty, per-domain rate >1/sec
  Warning: error rate >10%, DNS cache miss >5%, disk >80% on workers
```

Two notes on where these numbers come from. The Bloom filter lives in each worker's own memory, not in Redis, so watch it as process heap and not as a Redis key. Redis holds the exact seen-set and the crawl-delay cache. And the filter's false positive rate is not something you observe by catching mistakes, since a false positive is precisely the case where the crawler never learns it was wrong. You infer it from the fill ratio: for a filter with a fraction `f` of its bits set and `k` hash functions, the false positive probability is about `f^k`. That is your early warning that the filter is saturating and quietly dropping more new URLs than the design budgeted for, which is the signal to resize.

The politeness metrics deserve their own panel because they are the ones with consequences outside your infrastructure. Everything else on these dashboards costs you money when it goes wrong. Exceeding 1 request per second to a domain costs somebody else their uptime, and it is the metric that gets your crawler banned.

---
