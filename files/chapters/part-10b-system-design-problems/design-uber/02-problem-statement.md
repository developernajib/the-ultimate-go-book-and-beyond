## Problem Statement

Design a ride-sharing platform like Uber/Lyft supporting:
- 100M daily active users across 70+ countries
- 10M trips per day
- Real-time driver location updates (every 4 seconds)
- Trip matching in < 1 second
- Surge pricing based on supply/demand per geographic cell
- Driver earnings, rider billing, and payment processing

**Clarifying Questions to Ask in Interviews:**

1. Do we support pooled (shared) rides? Start with single-rider, mention pooling as an extension.
2. How precise does ETA need to be? Within 1 minute accuracy for pickup.
3. Do we need driver earnings and settlement? Yes, weekly payouts.
4. What is the cancellation SLA? Driver can cancel pre-pickup, rider is penalized after driver arrival.
5. Do we design the maps and routing layer? No, assume a routing provider such as Google Maps or OSRM.

---
