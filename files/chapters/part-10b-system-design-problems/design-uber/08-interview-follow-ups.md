## Interview Follow-Ups

**Q: How do you handle the case where no drivers are available?**

Expand the search radius in concentric circles: 3km → 7km → 15km. If still no drivers, queue the request and send a push notification when a driver appears within 5km (using Redis keyspace notifications or a polling job). Cap wait time at 5 minutes, show the rider a live supply map so they understand the situation.

---

**Q: How do you prevent surge pricing abuse (drivers going offline to create artificial surge)?**

Three mitigations: (1) The surge calculation uses a 5-minute rolling window, so a sudden coordinated drop in supply bleeds into the average rather than instantly spiking the multiplier, (2) anomaly detection flags accounts that repeatedly toggle offline and online in high-demand areas, particularly when the toggling correlates across nearby drivers, (3) geofenced event zones (concerts, airports) carry pre-programmed surge caps plus incentives that reward supply rather than scarcity.

The deeper point is that surge is an incentive mechanism, so it can be gamed by the people it is meant to incentivize. Any control you add is adversarial, and the multiplier cap matters as much for abuse resistance as it does for rider fairness: it bounds the payoff of a successful manipulation.

---

**Q: How do you match drivers and riders at 100x current scale?**

At 100x, 10M trips/day becomes 1B trips/day, which is roughly 11,600 trips/sec average and perhaps 35,000/sec at peak.

Partition by market rather than by a uniform global grid. Tiling the planet with equal-area H3 cells sounds elegant and wastes almost all of it: resolution 4 cells average 1,770 km² each and it takes hundreds of thousands to cover the land, most of which is ocean, desert, or empty. Demand is not uniformly distributed, so shards should not be either. Shard by city or metro, and split the dense ones further by H3 cell when a single market outgrows one instance.

Trips within a shard are fully local and need no cross-shard coordination, which is what makes this scale at all. For riders near a shard boundary the gateway queries both adjacent shards and takes the best result. Note this is exactly where the driver-assignment constraint needs care: a driver visible to two shards must still be claimed in exactly one place, so the shard that owns the driver owns the write.

---

**Q: How do pooled (shared) rides change the matching problem?**

Pooled trips require matching multiple riders going in roughly the same direction, which changes the problem's shape rather than just its size. Single-rider matching optimizes one variable (which driver) against a fixed route. Pooling optimizes over the set of riders, the pickup order, and the route simultaneously, and each new rider degrades service for the riders already on board.

The core constraints: a candidate rider must share enough of the route to be worth combining, and the detour must stay inside a promised bound for everyone already committed (a few minutes, enforced as a hard constraint rather than a preference, since a rider who was promised a 20 minute trip will not accept 35). Matching cost rises from O(D) over nearby drivers to roughly O(D × R) with R active pool rides in the area, which is why pooling is typically its own service with its own index rather than a flag on the normal matcher.

The honest interview answer is that this is a vehicle-routing problem, which is NP-hard in general, so production systems use heuristics over a short time horizon and accept good-enough pairings.

---

**Q: How do you handle a payment failure after trip completion?**

First, separate the two cases, because they need opposite responses. A transient failure (network timeout, Stripe 5xx) means the charge may or may not have happened, so retry with exponential backoff behind the trip's idempotency key, which makes a duplicate attempt safe. A hard decline (insufficient funds, card expired) will not fix itself, so retrying it is pure waste.

For hard declines: mark the rider's account as payment_due and settle the balance on their next payment attempt, after prompting them to update their card. Blocking future rides outright is a business decision with real cost, since a rider who cannot ride cannot generate the revenue to clear the balance, so platforms typically allow the ride and collect the outstanding amount alongside it rather than locking the account at the first failure.

A detail worth stating: the driver is paid regardless. They completed the trip, and collection risk belongs to the platform, not to them. Coupling driver earnings to rider collection would make a driver's income depend on a stranger's card, which is why the earnings ledger is written off trip completion rather than off payment success.

---

**Q: How do you implement driver-side fairness in dispatch?**

Without fairness controls, drivers positioned near busy areas monopolize trips, and drivers who idle in quieter areas eventually log off, which shrinks supply exactly where coverage is thinnest.

The standard approach adds an idle-time component to the match score, so a driver who has waited longer without an offer gets a boost that grows with the wait. This distributes trips across idle drivers in the same area without abandoning the ETA objective, since the boost adjusts the ranking rather than overriding it.

Note the tension: fairness and efficiency genuinely trade off here. Every trip you route to a fairness-boosted driver instead of the closest one costs the rider some wait time. The weighting is a business decision about how much rider latency you will spend to keep drivers on the platform, and the answer differs by market. State the trade-off explicitly in an interview rather than presenting fairness as free.

---
