## Problem Statement

Design a food delivery platform like DoorDash or Uber Eats that coordinates three parties, customers, restaurants, and drivers, in real time. The system must handle everything from restaurant search and ordering to driver dispatch, live tracking, and payment settlement. The requirements below define the scale and feature scope across all three user types.

- **25M daily active users, 500K restaurant partners**: The customer-facing search and browsing traffic dominates total request volume. Restaurant and driver APIs operate at much lower QPS but with stricter latency and reliability requirements.
- **1M orders per day (12/sec average, 50/sec peak)**: Peak load occurs during dinner hours (6-9 PM local time) and is highly concentrated by geography. A city like San Francisco might see 5x the orders per capita compared to a smaller market.
- **Real-time order tracking**: Customers expect live driver location on a map. This requires WebSocket connections for the roughly 120K orders in flight at peak (about 250K connections counting both customer and driver), with GPS updates pushed to the client every 4 seconds.
- **Smart dispatch**: Matching orders to drivers is a multi-variable optimization problem. The system must consider proximity, driver rating, acceptance history, and vehicle type. A bad match (sending a far-away driver while a closer one is idle) wastes time and degrades ETAs.
- **Restaurant order management**: Restaurants accept or reject orders via a tablet app and provide prep time estimates. The system must handle restaurants that consistently under-estimate prep times by learning from historical data.
- **Dynamic pricing and delivery fee calculation**: Surge pricing adjusts delivery fees based on the supply/demand ratio of drivers to orders in each geographic zone, incentivizing more drivers to come online during peak demand.
- **ETA prediction**: The most visible number in the customer experience. Must combine ML-predicted restaurant prep time with real-time traffic routing. Accuracy within 5 minutes is the target, errors beyond 10 minutes significantly increase cancellation rates.
- **99.9% availability for order placement**: Allowing approximately 1.4 minutes of downtime per day. This requires graceful degradation strategies where individual service failures do not prevent customers from placing orders.

---
