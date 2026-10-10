## Summary

The table below provides a quick-reference map of every major component in the system, the technology that powers it, and its role in the overall architecture. Use this as a mental checklist during an interview to make sure you have covered all the key pieces. If you can explain the purpose of each row and how the components interact, you have a solid grasp of the full Airbnb design.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Listing search | Elasticsearch (geo + filters) | Location-based search |
| Availability | PostgreSQL + Redis cache | Calendar management |
| Booking hold | Redis SETNX (10-min TTL) | Fast-path double-booking guard |
| Calendar integrity | Advisory lock + exclusion constraint | Double-booking guarantee |
| Bookings | PostgreSQL | Reservation records |
| Payments | Stripe (authorize + capture) | Two-phase payment |
| Notifications | Email/push via Kafka | Booking events |
| Reviews | PostgreSQL | Post-stay ratings |
| Dynamic pricing | ML model + calendar data | Price optimization |


---
