## Monitoring and Observability

Operating an autocomplete system at scale requires visibility into both performance and quality metrics. Latency dashboards tell you if the system is fast enough, but suggestion quality metrics like click-through rate and zero-result rate tell you if the system is actually useful. Freshness metrics ensure trending topics surface quickly, and content quality metrics guard against offensive suggestions slipping through.

```
Key Dashboards:

1. Suggestion Quality:
   - Suggestion click-through rate (CTR)
   - Average position of clicked suggestion
   - Time from first keystroke to search submission
   - Abandonment rate (typed but didn't search)
   - Zero-result rate (prefix with no suggestions)

2. Performance:
   - P50/P95/P99 suggestion latency
   - Trie lookup time distribution
   - Redis cache hit rate by prefix length
   - CDN cache hit rate
   - QPS by domain (web, product, user)

3. Freshness:
   - Trie age (time since last rebuild)
   - Trending detection latency
   - Kafka consumer lag on search-events
   - Frequency data staleness

4. Content Quality:
   - Blocked suggestions served (should be 0)
   - Moderation queue depth
   - False positive rate (legitimate terms blocked)
   - Trending term velocity

5. Infrastructure:
   - Server fleet size and utilization
   - Redis cluster memory usage
   - Kafka topic health
   - Flink job throughput

Alerting:
  Critical: P99 >100ms, trie rebuild failed 2x, blocked content served
  Warning: CTR drops >10%, zero-result rate >5%, trending stale >1 hour
```

---
