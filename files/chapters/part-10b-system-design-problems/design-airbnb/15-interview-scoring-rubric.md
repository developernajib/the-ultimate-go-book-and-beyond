## Interview Scoring Rubric

This rubric shows what interviewers at different levels expect to hear in an Airbnb system design discussion. It helps you calibrate the depth of your answer to the role you are targeting. A junior candidate is expected to cover the basic search-and-book flow, while a staff-level candidate should discuss edge cases like dynamic pricing, failure recovery, and trust-and-safety mechanisms. Use this rubric to self-assess your answer after practicing.

### L4 (Junior/Mid), Expected

- Search + booking as two main flows
- Elasticsearch for listing search
- Basic availability check
- Simple booking flow: check -> charge -> confirm

### L5 (Senior), Strong Hire

- Redis hold pattern for double-booking prevention
- Two-phase payment (authorize then capture)
- Elasticsearch geo_distance queries
- Availability batch checking
- Discusses search vs booking consistency trade-offs
- Instant-book vs request-to-book flows

### L6 (Staff+), Exceptional

- All L5 plus:
- Dynamic pricing engine with multiple factors
- Bayesian averaging for review scores
- Bidirectional blind review system
- CDC pipeline for ES indexing
- Database-level backstop (exclusion constraint or serializable isolation)
- Booking recovery service for partial failures
- Messaging with PII detection
- Superhost program, cancellation policies
- Multi-currency international booking

---
