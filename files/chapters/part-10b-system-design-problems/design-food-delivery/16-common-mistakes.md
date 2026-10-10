## Common Mistakes and How to Avoid Them

These are the pitfalls that interviewers see most often when candidates design food delivery systems. Understanding what NOT to do is just as valuable as knowing the right approach. Each mistake below represents a real gap in system thinking that can cost you a hire decision.

1. **Ignoring the state machine**: Candidates jump to DB schema without defining order states and valid transitions. The state machine IS the core of the system.

2. **Synchronous dispatch**: Calling dispatch synchronously in the order placement flow. Dispatch should be async, order is confirmed immediately, driver assignment happens in background.

3. **Polling for driver location**: Using HTTP polling instead of WebSocket/SSE for real-time tracking. At 250K concurrent tracking sessions polling every 4 seconds, that is 3.75M requests per minute of mostly-empty responses, versus near-zero idle traffic for push.

4. **Ignoring prep time in ETA**: Calculating ETA as just travel time. Prep time is often the dominant factor (15-30 min) and must be modeled.

5. **No surge pricing model**: Just saying "use dynamic pricing" without explaining the supply/demand mechanics. Interviewers want to see H3 cells, demand windows, and multiplier thresholds.

6. **Single Redis instance**: Not discussing Redis Cluster for 50K location writes/sec. A single Redis node maxes out at ~100K ops/sec, need to plan for growth.

7. **Missing idempotency**: Not making payment calls idempotent. Network retries can cause double-charges without idempotency keys.

8. **Over-engineering the restaurant side**: Spending too much time on menu management instead of the core challenges (dispatch, ETA, tracking).

---
