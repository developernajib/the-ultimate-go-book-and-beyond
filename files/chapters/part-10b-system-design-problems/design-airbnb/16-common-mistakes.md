## Common Mistakes and How to Avoid Them

These are the pitfalls that interviewers see most frequently, and avoiding them is often the difference between a "hire" and a "no hire" decision. Each mistake reflects a gap in understanding a fundamental aspect of the system, whether it is data consistency, performance trade-offs, or product awareness. Review this list before your interview to make sure none of these blind spots appear in your answer.

1. **Ignoring double-booking**: The number one differentiator. Just "check availability" is not enough, need Redis hold + DB transaction layered approach.

2. **Synchronous availability in search**: Blocking search on individual availability checks. Batch check asynchronously or accept slightly stale data.

3. **Confusing guest charging with host payout**: Many candidates either skip the authorization step and charge immediately, or claim the card is charged at check-in. The correct flow is authorize at checkout, capture at booking confirmation (card authorizations expire in about 7 days, so waiting for check-in is not an option), and pay the host 24 hours after check-in. The gap between capture and payout is the platform's dispute window.

4. **Elasticsearch as source of truth**: ES is eventually consistent. PostgreSQL is source of truth. ES is a read-optimized index.

5. **No cancellation policy discussion**: Flexible/moderate/strict policies affect refund calculations. Mentioning this shows product awareness.

6. **No trust/safety discussion**: Reviews, identity verification, host guarantees, core to marketplace design.

---
