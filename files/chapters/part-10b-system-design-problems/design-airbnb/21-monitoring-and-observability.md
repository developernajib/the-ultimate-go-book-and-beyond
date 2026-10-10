## Monitoring and Observability

Operating a booking platform at scale requires visibility into every layer of the system. The dashboards below are organized around the four areas that matter most: search performance (is the guest experience fast?), booking funnel (are guests converting?), host metrics (are hosts responsive and reliable?), and trust and safety (is the platform healthy?). The alerting thresholds are calibrated to catch real problems without causing alert fatigue, for example, a double-booking detection alert is critical because it should never happen, while a search latency warning gives the team time to investigate before it affects users.

```
Key Dashboards:

1. Search Performance:
   - Search QPS (by region)
   - P50/P95/P99 search latency
   - Elasticsearch cluster health
   - Availability check latency
   - Cache hit rates (listing, availability)
   - Search-to-detail view rate

2. Booking Funnel:
   - Search -> listing view -> checkout start -> booking complete
   - Drop-off rate at each step
   - Hold timeout rate (abandoned checkouts)
   - Payment authorization failure rate
   - Double-booking incident count (should be 0)

3. Host Metrics:
   - Response rate (target: >90%)
   - Average response time
   - Cancellation rate by host
   - Payout processing latency
   - Superhost qualification rate

4. Trust & Safety:
   - Review submission rate
   - Content moderation queue depth
   - Fraud detection alerts
   - Dispute rate
   - Identity verification completion rate

Alerting:
  Critical: booking failure rate >2%, payment failure >5%, double-booking detected
  Warning: search P99 >500ms, ES cluster yellow, payout processing backlog >100
```


---
