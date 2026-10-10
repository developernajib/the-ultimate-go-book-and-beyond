## Company Case Studies

### LinkedIn - Data Bus: CDC at Planet Scale
*(Reference: LinkedIn Engineering: "Building LinkedIn's Real-time Activity Data Pipeline" & "Databus: Change Data Capture System", ACM SIGMOD)*

LinkedIn pioneered CDC-driven architecture with their **Databus** system (2012), which became the foundation for Apache Kafka's design. Databus solved LinkedIn's core problem: 50+ services needed real-time access to member profile changes, but polling the primary database would kill it.

**Architecture**: Oracle → Databus → 50+ downstream consumers (search index, recommendations, ad targeting, InMail). Each consumer maintained its own cursor into the change stream.

**Scale**: 170K+ queries/second across LinkedIn's member graph. When a member updates their profile, within 500ms: search index is updated, recommendations engine recomputes connections, ad targeting refreshes segments.

**Go lessons**: LinkedIn's experience validated the outbox pattern for reliability. Direct DB→Kafka two-phase commits failed under network partitions. The outbox pattern (write event to DB table in same transaction, relay to Kafka) provided at-least-once durability with idempotent consumption even during broker outages.

**Operational insight**: Replication slot management is the primary operational burden in modern logical replication pipelines. An unmonitored Debezium connector that stops processing causes PostgreSQL WAL to accumulate, eventually filling disk. Modern production deployments enforce automated alerts: `pg_replication_slots` lag > 10GB triggers a P1 alert.

---

### Shopify - Real-Time Inventory Across 2M Merchants
*(Reference: Shopify Engineering: "Capturing Data Changes in MySQL with Debezium" & "Real-Time Inventory at Shopify Scale", shopify.engineering)*

Shopify's inventory system must reflect stock changes across 2M+ merchants' stores in real-time. When a product sells on Shopify's POS (point-of-sale), the online store must immediately show "sold out."

**The challenge**: Shopify's database is sharded by merchant (each merchant's data on a different shard). Inventory changes in any shard must propagate to: online storefront, Shopify admin, fulfillment partners, and analytics.

**CDC architecture**: Each shard runs its own Debezium connector, publishing to a shared Kafka cluster. Topic naming: `shopify.{shard_id}.inventory`. Downstream consumers use wildcard subscriptions (`shopify.*.inventory`) to process changes from all shards.

**Go consumer pattern**: Shopify's inventory sync service uses a Go consumer with per-tenant circuit breakers. If a fulfillment partner's API is down, only that tenant's sync fails - other tenants continue unaffected.

**Scale numbers**: 500K inventory changes/minute during peak (Black Friday), 99.9th percentile sync latency < 800ms from DB write to storefront update.

---

### Airbnb - Stream Processing for Fraud Detection
*(Reference: Airbnb Engineering & Data Science: "Zipline: Airbnb's Machine Learning Data Management Platform" & "Real-Time Fraud Detection at Airbnb", medium.com/airbnb-engineering)*

Airbnb processes 1M+ booking events/day through stream processing pipelines to detect fraudulent activity in real-time - credit card fraud, account takeovers, and fake listings.

**Architecture**: Booking events → Kafka → Go stream processor → ML feature computation → feature store → model serving → fraud decision.

**Stream processing challenge**: Fraud signals require aggregating across multiple time windows simultaneously:
- Last 1 minute: rapid successive bookings from same IP
- Last 1 hour: multiple accounts using same payment method
- Last 24 hours: user booking pattern vs historical baseline

Airbnb's Go services compute these features using tumbling window aggregators (as implemented in §52I.2), storing intermediate state in Redis. The ML model serving layer reads features from Redis for sub-50ms inference.

**CDC for feature freshness**: User account changes (phone number, email, payment method) propagate via CDC to invalidate stale features in the feature store. Without CDC, fraud models would use stale user data, reducing detection accuracy.

### Junior -> FAANG: What to Learn From Each Case Study

Case studies are not just stories. They are worked examples of the trade-offs described abstractly in the technical sections. Here is how to extract the interview-relevant lessons from each one.

The LinkedIn Databus case study teaches the outbox pattern lesson at production scale. LinkedIn learned through hard experience that direct DB-to-Kafka two-phase commits failed under network partitions. The outbox pattern was not invented in a whiteboard session. It was the solution that survived contact with a real distributed system under failure. When you explain the outbox pattern in an interview, you can anchor it to this history: "This is the pattern LinkedIn developed for Databus after finding that two-phase commits were unreliable in production."

The operational insight from LinkedIn (replication slot management as the number-one burden) is a direct signal to interviewers that you have thought about CDC operationally, not just architecturally. Mention replication slot lag monitoring, the `pg_replication_slots` view, and the alert threshold (10 GB in LinkedIn's case, typically 1-5 GB in practice). This is the detail that separates a candidate who has read about CDC from one who has operated it.

The Shopify case study teaches the multi-tenant CDC pattern. The key insight is that sharding by merchant (database-per-tenant) isolates blast radius: a noisy tenant or a connector failure for one merchant does not affect other merchants. The wildcard consumer subscription (`shopify.*.inventory`) is the pattern that makes this work at scale without requiring each consumer to know the full list of shard-specific topics.

The Airbnb fraud detection case study teaches the multi-window aggregation pattern. Fraud signals require looking at the same event through multiple time lenses simultaneously (last minute, last hour, last 24 hours). This is a direct application of the tumbling window aggregator in section 52I.2, run in parallel with different window sizes. The feature store pattern (computed features written to Redis, read by the ML model) is a common FAANG architecture that appears in system design interviews for recommendation, ranking, and fraud detection systems.

### Senior @ FAANG: Platform Lessons From Production CDC at Scale

Each case study reveals a different platform-level concern. Reading them at the senior level is about identifying what organizational and operational structures enabled these teams to build and maintain CDC at scale, not just what technical components they used.

**LinkedIn: CDC as organizational infrastructure.** Databus was not a one-team project. It was a platform team's responsibility, with explicit SLAs for slot lag, event delivery latency, and connector availability. The 50+ downstream consumer teams did not each manage their own CDC infrastructure. They consumed from a platform that owned the operational burden. The organizational question for a senior engineer is: who owns the CDC platform in your organization? If the answer is "each team owns its own Debezium connector," you have 50 teams reinventing slot lag monitoring, heartbeat configuration, and snapshot handling. Platform ownership is the leverage point.

**Shopify: dynamic connector provisioning at merchant scale.** Shopify's architecture (one Debezium connector per merchant shard) implies a system for provisioning and deprovisioning connectors programmatically. As new merchants are onboarded, new connectors are created. As merchants churn, connectors and their associated replication slots are cleaned up. The Kafka Connect REST API, Strimzi's operator model, and Confluent's managed connectors are the three standard mechanisms for this. A senior engineer designing multi-tenant CDC must design the connector lifecycle management system as a first-class concern, not as an operational afterthought.

**Airbnb: feature stores and the CDC freshness SLO.** The Airbnb case study highlights the intersection of CDC and machine learning infrastructure. The feature store pattern requires CDC freshness to be defined as an SLO: the ML model's accuracy degrades if features are more than N seconds stale. This SLO drives the CDC pipeline design. If the freshness SLO is 5 minutes, a polling relay with a 1-minute poll interval is sufficient. If the SLO is 10 seconds, a CDC relay with Debezium is required. The SLO, not engineering preference, determines the infrastructure choice. A senior engineer frames this trade-off explicitly when presenting a design.

**The common thread: instrumentation before scale.** All three companies instrumented their CDC pipelines for end-to-end latency before they scaled them. LinkedIn measured time from database commit to Elasticsearch index. Shopify measured time from POS sale to storefront "sold out" reflection. Airbnb measured time from user account change to model feature staleness correction. In each case, the SLO was defined in user-visible terms (search reflects the change within 500ms, storefront updates within 800ms), and the pipeline was instrumented to measure that user-visible metric, not just internal component metrics. A senior engineer defines the user-visible SLO first and instruments for it, because internal metrics that don't correlate to user experience are insufficient for SLO accountability.

---
