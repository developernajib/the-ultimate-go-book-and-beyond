## 22B.14 Common Mistakes

These mistakes appear repeatedly in production postmortems. Each one seems minor in isolation, but under real failure conditions any single mistake can turn a contained incident into a full outage.

1. **Same timeout for all calls.** Match each timeout to the expected latency of that operation.
2. **Retrying non-idempotent operations without idempotency keys.** Always generate and pass a key, and never fail over to a different provider on an ambiguous error.
3. **Bulkhead too large.** It provides no isolation at all. Use the sizing formula.
4. **Fallback calls the same failing service.** Fallbacks must be genuinely independent.
5. **Fault tolerance untested.** Use fault injection in staging, because untested fallback paths rot.
6. **No metrics on fault tolerance activation.** You cannot improve what you cannot observe.
7. **Retrying 4xx errors.** Only retry transient errors: 429, 503, 504, and network failures.
8. **No jitter on retry.** This causes thundering herd. Default to full jitter.
9. **No retry deadline.** Retries consume the request budget, so cap total retry time including the pending delay.
10. **Degraded mode too aggressive.** If degraded mode breaks core workflows, users churn. Design the tiers deliberately.

### Staff Lens: Mistakes Catalog Drives Review

Maintain the team's catalog of past mistakes. Reference during review. Over time, the catalog captures institutional knowledge and prevents recurrence.

---
