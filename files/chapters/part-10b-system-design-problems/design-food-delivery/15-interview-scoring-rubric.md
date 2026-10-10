## Interview Scoring Rubric

This rubric shows what interviewers expect at different engineering levels. Use it to gauge which topics to prioritize in your preparation. L4 candidates should focus on getting the core order flow and basic dispatch right. L5 candidates need to demonstrate depth in real-time systems, state machines, and event-driven architecture. L6 candidates must show they can design for failure, optimize with ML, and reason about operational concerns at scale.

### L4 (Junior/Mid), Expected

- Identifies the three-party system (customer, restaurant, driver)
- Proposes basic order lifecycle with status tracking
- Mentions need for real-time location tracking
- Basic dispatch: find nearest driver
- Single database design (no sharding discussion)
- Handles the happy path well

### L5 (Senior), Strong Hire

- Designs order state machine with valid transitions
- Two-phase dispatch: find, offer, accept/decline, assign
- ETA prediction with prep time + travel time overlap
- Surge pricing with supply/demand model
- WebSocket for real-time tracking
- Redis GEO for driver location indexing
- Discusses edge cases: restaurant cancellation, driver no-show
- Database sharding strategy (by city or order_id)
- Kafka for event-driven architecture

### L6 (Staff+), Exceptional

- All L5 items plus:
- H3 hexagonal cells for geofenced surge pricing
- ML-based ETA prediction with feature engineering
- Circuit breaker pattern for external service failures
- Graceful degradation strategies per failure mode
- Geographic sharding with regional failover
- Idempotency for payment processing
- Driver scoring algorithm with weighted factors
- Data pipeline for ML feature extraction
- Discusses operational concerns: alerting, monitoring, on-call
- Capacity planning with back-of-envelope calculations

---
