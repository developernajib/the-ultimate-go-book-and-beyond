## Interview Follow-Ups

These are the most frequently asked follow-up questions in food delivery system design interviews. They test whether you can reason about failure recovery, ML-driven optimization, and economic mechanics.

**Q: How do you handle restaurant cancellations after the order is accepted?**

This is a cascade failure: the customer has already been charged, and a driver may already be en route. The response sequence is: (1) Immediately notify the customer via push notification with a full refund initiated. (2) If the restaurant is part of a ghost kitchen or multi-brand operation, attempt to re-route the order to an equivalent kitchen. (3) If the restaurant is unique, offer the customer a list of nearby alternatives with a compensation credit (typically $5-10) applied automatically to their next order. (4) If a driver was already assigned, send them a cancellation notification and compensate them with a partial delivery fee for the wasted trip. (5) Log the cancellation reason for restaurant quality tracking, restaurants with high cancellation rates face review or suspension.

**Q: How do you estimate prep time accurately?**

An ML model predicts prep time using five features: the restaurant's historical average (overall and by time-of-day), the current order queue depth at the restaurant (how many orders are ahead), the day of week (weekends are typically slower due to higher volume), order complexity (item count and number of custom modifications), and whether the restaurant has flagged any items as temporarily delayed. The model is retrained weekly per restaurant. As a fallback, restaurants can manually update estimated wait times via their tablet app, which overrides the ML prediction. Historical accuracy data feeds back into the ETA buffer calculation: restaurants that consistently under-predict get a larger buffer added to their estimates.

**Q: How does surge pricing work?**

The map is divided into hexagonal cells using the H3 geospatial indexing library at resolution 9, where each cell has an edge length of roughly 175 meters. Within each cell, the system tracks two counters in Redis: demand (orders placed in the last 5-minute window) and supply (unique available driver IDs in the last 2 minutes). The surge multiplier is computed from the demand-to-supply ratio: ratio at or below 1.0 means no surge (1.0x), up to 1.5 triggers 1.2x, up to 2.0 triggers 1.5x, up to 3.0 triggers 1.8x, and anything beyond hits the 2.5x cap. The multiplier is applied only to the delivery fee, not to food prices (the restaurant's menu prices are never altered by surge). The surge info is cached for 5 minutes per cell to avoid computation on every request.

---
