## Follow-up Questions, Advanced

These questions go beyond the core design and test your ability to handle real-world complexity. Interviewers ask these to see how you think about edge cases, fraud prevention, business incentives, and operational quality. Strong answers show you understand not just the technical implementation but also the business trade-offs behind each decision.

**Q: How do you handle multi-restaurant orders (one delivery from two restaurants)?**

Split into two sub-orders, each with its own restaurant flow. Dispatch assigns one driver for both pickups (route optimization). Driver picks up from Restaurant A, then B, then delivers. ETA = max(prep_time_A, prep_time_B) + travel(A to B) + travel(B to customer). Complexity: coordinating readiness times, food from A gets cold while waiting for B. Solution: stagger restaurant notifications based on estimated prep times.

**Q: How do you handle driver fraud (marking delivered without actually delivering)?**

GPS fence check: driver GPS must be within 200m of delivery address when marking delivered. Photo confirmation: driver takes photo of delivery (ML checks for valid food package). Customer confirmation: push notification asks customer to confirm receipt. Pattern detection: flag drivers with high "not delivered" complaint rate. Two-strike system: first offense = warning, second = deactivation pending review.

**Q: How would you design the driver incentive system?**

Goal: maximize driver availability during peak hours and in underserved areas. Mechanics: (1) Quest bonuses: "Complete 10 deliveries between 5-9 PM, earn $20 bonus." (2) Zone bonuses: "Deliveries in Zone X earn 1.5x base pay." (3) Surge bonus: automatic during high-demand periods. Implementation: real-time dashboard shows drivers where bonuses are active. Bonus zones computed from same demand/supply data as surge pricing. Cost optimization: ML model predicts minimum incentive needed to attract N drivers to a zone.

**Q: How do you ensure order accuracy (customer gets what they ordered)?**

Three checkpoints: (1) Restaurant confirms each item on their tablet before marking ready. (2) Driver verifies item count matches order at pickup (shown on driver app). (3) Sealed bags with tamper-evident stickers, customer sees if bag was opened. Tech: order receipt printed with itemized list attached to bag. Dispute resolution: photo evidence + restaurant/driver logs. Refund policy: instant credit for missing items, no questions asked (builds trust).

**Q: What metrics do you monitor and alert on?**

```
Business Metrics (real-time dashboard):
  - Orders/minute by city (alert if drops > 30% vs same hour last week)
  - Avg ETA accuracy (alert if off by > 10 min for 5% of orders)
  - Driver acceptance rate (alert if < 60%)
  - Order cancellation rate (alert if > 5%)
  - Customer rating trend (alert if 7-day avg drops below 4.5)

Technical Metrics:
  - Order service P99 latency (alert if > 500ms)
  - Dispatch assignment time (alert if > 3 minutes)
  - WebSocket connection count (alert if drops > 20%)
  - Kafka consumer lag (alert if > 10K messages behind)
  - Redis cluster health (alert on any master failover)
  - Payment failure rate (alert if > 2%)
  - Location update freshness (alert if > 30s stale for active drivers)
```


---
