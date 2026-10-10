## Common Mistakes and How to Avoid Them

These mistakes are the most frequent reasons candidates fail ad system design interviews. Each one reflects a gap in understanding of how the system behaves at scale.

1. **Ignoring the 100ms latency budget.** Candidates design sequential flows (call DSP 1, then DSP 2, then DSP 3) instead of parallel fan-out with a strict timeout. At 80ms per DSP call, sequential calls to 10 DSPs would take 800ms, 8x the entire budget. The fix is goroutines with a shared context deadline.

2. **Using floating-point for money.** IEEE 754 floating-point cannot represent 0.10 exactly. At 1 trillion impressions per day, even a $0.0001 rounding error per impression accumulates to $100 million per day in billing discrepancies. All monetary values must be integer cents or microdollars.

3. **No impression idempotency.** Without unique auction IDs, a page refresh or network retry causes double-counted impressions, which means advertisers are billed twice for the same view. Each impression must be logged with a unique auction ID, and the tracking system must deduplicate on that ID.

4. **No budget pacing.** Without time-proportional spend targets, a high-budget campaign wins every auction in the morning, exhausts its budget by 8 AM, and shows no ads for the remaining 16 hours. Pacing ensures the budget is spread evenly across the day, with bid modifiers adjusting the aggressiveness based on current spend versus target.

5. **Single-layer fraud detection.** Rule-based fraud detection alone catches only obvious bots. Sophisticated click farms use real browsers, residential IPs, and human-like click patterns. You need velocity-based anomaly detection (too many clicks from the same IP or user in a short window) and ML-based scoring (trained on historical fraud patterns) to catch them.

6. **Same database for OLTP and OLAP.** Campaign management (CRUD operations, low volume) and impression analytics (1T rows/day, aggregate queries) have fundamentally different access patterns. Using PostgreSQL for both means either analytics queries slow down campaign management, or you under-provision for analytics. The correct split is PostgreSQL for campaigns and ClickHouse for event logs.

7. **Ignoring privacy regulations.** GDPR, CCPA, and the fragmented third-party cookie landscape are not optional considerations. The system must support contextual targeting (based on page content) alongside user-based targeting, provide consent management, and honor opt-out requests. Failing to address privacy is a disqualifying omission in a modern ad system interview.

---
