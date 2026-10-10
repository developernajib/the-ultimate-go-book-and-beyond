## Summary

This table provides a quick reference for the technology choices behind each major component of the food delivery platform. Each technology was selected to match the specific access patterns and performance requirements of its domain. For example, Redis GEO handles the high-frequency spatial queries needed for driver matching, while PostgreSQL provides the transactional guarantees required for order and payment data.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Order management | PostgreSQL | Order lifecycle & history |
| Driver locations | Redis GEO | Real-time geospatial lookup |
| Dispatch | Redis + custom matching | Driver-order assignment |
| Real-time tracking | WebSocket + Redis Pub/Sub | Live location updates |
| State machine | Kafka events | Order status broadcast |
| ETA prediction | ML model + Maps API | Delivery time estimates |
| Surge pricing | H3 cells + demand/supply | Dynamic fee calculation |
| Payments | Stripe | Order payment processing |


---
