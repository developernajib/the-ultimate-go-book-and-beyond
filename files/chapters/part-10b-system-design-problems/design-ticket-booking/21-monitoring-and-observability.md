## Monitoring and Observability

A sale lasts about twelve minutes, which means an incident detected in five is an incident you watched happen. The dashboards below cover the queue, seat inventory, payment processing, ticket delivery, and infrastructure health.

Two of these deserve more attention than they usually get, because they are how the design's known failure modes announce themselves. **Stranded seats**, meaning seats reading `held` in Redis with no live hold behind them, is the direct measure of the inventory leak: if the reaper stalls, this climbs, and the arena sells out with empty seats in it. **Refunds issued because the seat CAS lost** is the running cost of charging before committing. A low rate is the expected price of never overselling. A spike means holds are being lost somewhere upstream, and the money is being moved to tell you about it.

```
Key Dashboards:

1. Sale Event Dashboard (real-time during sales):
   - Queue depth and admission rate
   - Seats available / held / sold (per section)
   - Hold-to-confirmation conversion rate
   - Hold expiration rate
   - Payment success/failure rate
   - Pages/sec served (CDN + origin)
   - Error rate by endpoint

2. Queue Dashboard:
   - Users in queue
   - Average wait time
   - Admission throughput (users/min)
   - Queue position accuracy (predicted vs actual)
   - Bot detection events
   - CAPTCHA challenge rate

3. Inventory Dashboard:
   - Redis vs PostgreSQL seat state comparison
   - Reconciliation mismatches (and repair direction: always cache <- DB)
   - Stranded seats: held in Redis, available in DB, no live hold
   - Hold reaper lag (oldest unswept entry in the expiry index)
   - Refunds issued because the seat CAS lost the race
   - Sold count by tier/section
   - Revenue by price tier
   - Resale marketplace activity

4. Ticket Delivery:
   - Outbox depth and oldest undelivered row (committed but not delivered)
   - QR generation success rate
   - Email delivery rate
   - QR scan success rate (at venue)
   - Invalid scan attempts (fraud detection)
   - Duplicate scan attempts rejected by the one-time-scan check
   - SafeTix rotation working correctly

5. Infrastructure:
   - Auto-scaling events (pre-sale warmup)
   - Redis ops/sec and memory
   - PostgreSQL connection pool utilization
   - CDN cache hit rate
   - Payment gateway latency

Alerting:
  Critical: two confirmed bookings for one seat (should be impossible: the
            unique/CAS path failed, or someone bypassed it), payment failure
            >5%, Redis master down, admission rate 0 while queue non-empty
  Warning: hold expiration rate >20%, queue wait >30min, bot activity spike,
           stranded seats climbing, outbox rows older than 20 minutes
  Pre-sale: auto-scale trigger 1 hour before (predictive)
```

---
