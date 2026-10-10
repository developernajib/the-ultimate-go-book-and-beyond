## Interview Scoring Rubric

This rubric helps you calibrate the depth of your design against what interviewers at different levels expect. A junior candidate who covers the L4 points well will pass, a senior candidate must demonstrate awareness of the L5 concerns to be competitive.

### L4 (Junior/Mid)
- Basic RTB flow: publisher sends request, auction runs, winner returned within 100ms
- Technology choices: Kafka for event logging, Redis for budget tracking, second-price auction mechanics
- Simple impression and click tracking with deduplication
- **Missing at this level (expected):** budget pacing, multi-layer fraud detection, creative rendering pipeline, frequency capping

### L5 (Senior)
- Parallel DSP calls with strict timeout and circuit breakers for failing DSPs
- Budget pacing with time-proportional spend targets and bid modifiers
- Frequency capping using Redis counters with time-bucketed keys
- Multi-layer fraud detection: rule-based (under 1ms) + velocity-based (under 5ms) + ML model (under 50ms)
- ClickHouse for analytics separate from PostgreSQL for campaign management (OLAP vs OLTP split)
- Latency budget breakdown: 5ms fraud check + 80ms DSP bidding + 15ms winner selection and response
- **Missing at this level (expected):** geo-distributed budget consistency, CDN strategy for creative assets, billing reconciliation against processor statements

### L6 (Staff)
- First-price vs second-price auction trade-offs, including bid shading strategies
- Multi-region budget consistency across geographically distributed auction servers
- Viewability tracking (measuring whether an ad was actually visible to the user, not just loaded)
- VAST video ad serving with quartile completion tracking
- Offline fraud detection pipeline (Flink consuming from Kafka) with retroactive advertiser refunds
- Floor price optimization using historical auction data to maximize publisher revenue
- Privacy regulation compliance: GDPR consent management, CCPA opt-out, cookie deprecation strategies, contextual targeting as a privacy-safe alternative
- Attribution modeling: last-click vs multi-touch attribution and its impact on advertiser reporting

---
