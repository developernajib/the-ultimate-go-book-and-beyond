## Extended Scenarios: Demand Surges

### Handling a Major Event (Concert, Sports Game)

When 50,000 people leave a venue simultaneously:

1. **Pre-event surge scheduling**: Increase surge cap for the venue geofence 30 minutes before event end
2. **Driver incentive zone**: Offer $5 bonus for drivers who are online within 2km of the venue
3. **Staging areas**: Designate pickup zones with clear signage (coordination with venue)
4. **Queue system**: Virtual queue for riders, "Your estimated wait: 12 minutes, position: 342"
5. **Overflow routing**: Route excess demand to public transit alternatives with in-app directions
6. **Real-time supply dashboard**: Ops team monitors driver supply vs demand in real-time

### Handling a Payment Provider Outage

When Stripe is down:

1. **Trip completion continues**: Driver completes trip normally. The charge is a consumer of trip completion, not a step inside it, which is exactly why a payment outage cannot block the ride from ending.
2. **Payment deferred**: Record payment as "pending" in local DB
3. **Rider notified**: "Payment will be processed shortly"
4. **Retry queue**: Background job retries with exponential backoff and full jitter, up to 24 hours. Not a fixed 5-minute interval: every deferred charge in the fleet accumulated during the outage, and a fixed interval fires them all on the same tick, so the first thing a recovering provider receives is a synchronized stampede that knocks it back down.
5. **Driver earnings unaffected**: Driver's earnings are recorded immediately regardless of rider payment status. They did the work, and collection risk is the platform's.

**On failing over to a backup processor**, the obvious step 5 in the original plan, be careful: this is not the free win it looks like. During the outage you have charges whose outcome you do not know. Stripe may have processed a payment and failed to tell you. Replaying those through a second provider double-charges riders for real, and the two providers share no idempotency namespace, so nothing at either end will catch it. If you failover, failover only new trips, never the pending queue, and reconcile the ambiguous ones against Stripe once it returns. A payment system that can charge through two providers has strictly more ways to charge twice, and that trade-off has to be worth the availability it buys.


---
