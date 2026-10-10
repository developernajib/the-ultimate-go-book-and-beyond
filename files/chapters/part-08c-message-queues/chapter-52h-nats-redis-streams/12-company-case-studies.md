## Company Case Studies

### Synadia - Edge Computing with NATS Leaf Nodes
*(Reference: Synadia Architecture Guide: "Distributed Edge Computing with NATS Leaf Nodes and JetStream", docs.nats.io)*

Synadia, the company behind NATS, uses its own technology for managing distributed edge infrastructure. The key pattern is NATS **leaf nodes**: lightweight NATS servers that connect edge devices (factory floors, retail stores, IoT gateways) to a central JetStream cluster. When the WAN link to the central cluster drops, the leaf node continues operating locally - subscriptions keep receiving messages, publishers keep writing. JetStream's interest-based retention ensures messages are stored until they are consumed. When connectivity resumes, the leaf node reconnects and JetStream automatically replays any messages the consumer missed while offline. This offline-first design requires zero application-level retry logic - it is inherent to the JetStream protocol.

The subject hierarchy follows `region.device-type.device-id.metric`, enabling wildcard consumers at every level: `us-west.*.>` routes all US-West traffic to a regional aggregator, while `*.*.sensor-abc.temperature` routes all temperature readings from a specific sensor globally.

### Global Edge CDN Platform (Composite Pattern) - Edge-to-Core Redis Streams Pipeline
*(Pattern Note: While global edge networks like Cloudflare utilize Kafka and ClickHouse for centralized analytical data lakes, edge POP proxies commonly utilize Redis/Valkey Streams with approximate trimming (`MAXLEN ~ N`) and object storage sink consumers for local buffer decoupling.)*

In a distributed CDN architecture processing logs across 200+ Points of Presence (PoPs), each PoP ships structured log entries (HTTP requests, DDoS events, Workers invocations) to a Redis Streams pipeline. Consumer groups partition work: the `billing-processor` group feeds the billing engine, `security-analyzer` feeds the WAF rule engine, and `analytics-aggregator` feeds their real-time dashboard.

The critical challenge at 100TB+ daily ingestion is MAXLEN management. The architecture uses approximate trimming (`MAXLEN ~ N`) rather than exact trimming to avoid blocking Redis during compaction. Streams maintain depth at roughly 1 hour of data per PoP - enough for any consumer to catch up after a brief outage - and archive older entries to object storage (such as Cloudflare R2 or S3) via a dedicated archival consumer group. This design keeps Redis memory bounded while preserving full auditability.

XPENDING monitoring is automated: a separate process queries each consumer group every 30 seconds and pages on-call if any consumer accumulates >10,000 pending messages.

### Connected Vehicle Telemetry Architecture (Anchored on Tesla Fleet Telemetry)
*(Reference: Tesla Motors Fleet Telemetry Service Architecture & Go Reference Pipeline, github.com/teslamotors/fleet-telemetry)*

In large-scale automotive fleets such as Tesla's connected vehicle network, vehicles publish sensor telemetry (GPS, battery state, thermal data, ADAS events) over lightweight messaging protocols. The subject hierarchy is `vehicle.<vin>.<subsystem>.<metric>`. When a vehicle is inside a cellular coverage area, telemetry flows in real time. JetStream's at-least-once semantics with the `DeliverLastPerSubject` policy means backend services always receive the most recent state for each sensor even after brief connectivity gaps.

Three distinct consumer types run on the same stream: safety systems (pull consumer with `DeliverAllPolicy` - must not miss a single event), analytics pipelines (push consumer with `DeliverNewPolicy` - interested only in live data), and OTA update orchestration (queue group consumer that load-balances update requests across a fleet of update workers). JetStream's subject filtering allows each consumer to subscribe to only its relevant subset without duplicating data.

### High-Volume E-Commerce Platform (Composite Architecture) - Redis Streams Co-Located Event Processing
*(Pattern Note: While Alibaba's primary transaction tier is historically anchored on Apache RocketMQ, Alibaba Cloud's enterprise architecture blueprints and merchant microservices highlight co-locating event streams inside Redis/Tair clusters to eliminate cross-tier network hops.)*

In high-volume e-commerce architectures handling hundreds of millions of events daily, Redis Streams offers a compelling alternative to separate broker tiers for the order microservices layer because of co-location: order state is already stored in Redis, so adding Streams-based event processing eliminates a cross-service network hop per order transition.

Consumer groups map to microservices: `inventory-service`, `payment-ledger`, `fulfillment-router`, and `notification-dispatcher` each have their own group on the `orders:events` stream. XAUTOCLAIM runs every 60 seconds in each consumer, reclaiming any message idle more than 5 minutes - this handles the case where a consumer pod crashes mid-processing without manual operator intervention.

The key advantage over maintaining a separate message broker cluster for this use case was the simplified operational model: Redis Cluster was already a tier-0 service with dedicated SRE ownership, whereas an additional broker required a separate operational silo. Eliminating one stateful system tier reduced P99 latency by 8ms per order event.

### Junior -> FAANG: Extracting Engineering Lessons from Case Studies

Case studies are most valuable when you extract the general principle behind the specific implementation. Each case study above contains a transferable lesson.

From Synadia: the lesson is offline-first design via the broker, not the application. JetStream's leaf-node architecture handles the reconnect-and-replay scenario without any application code. When evaluating messaging systems, ask "what does my application need to implement to handle a 5-minute broker disconnection?" The answer that requires the least application code is often the right choice.

From Cloudflare: the lesson is that operational automation is as important as system design. The XPENDING monitoring process that pages on-call when any consumer exceeds 10,000 pending messages is not glamorous engineering, but it is what prevents silent data loss from becoming a customer incident. Build the monitoring before the workload grows, not after.

From Tesla: the lesson is that multiple delivery policies on the same stream allow different consumers to have fundamentally different semantics without duplicating data. One stream, three consumer types, three different delivery guarantees. This is only possible because JetStream tracks consumer state independently per consumer.

From Alibaba: the lesson is that operational leverage (one system your team already owns and knows) often beats technical optimality. RocketMQ may be theoretically better for some aspects of their workload, but Redis Streams won on total cost of ownership including team expertise.

### Senior @ FAANG: Case Study Analysis for System Design Interviews

FAANG system design interviews frequently start with a case study framing: "Design a notification system at Cloudflare scale" or "Design Tesla's vehicle telemetry pipeline." The case studies above give you concrete reference points to anchor your design.

For the Synadia leaf-node pattern: at FAANG, the equivalent is a multi-region service with satellite edge locations (CDN PoPs, mobile edge compute, retail kiosks) that need local processing when the WAN link is degraded. The question to ask in the interview is "what is the acceptable data loss window and what is the acceptable latency for catching up after reconnection?" Those two parameters determine whether NATS leaf nodes, a store-and-forward queue, or a full regional deployment is the right architecture. NATS leaf nodes are correct when the answer is "zero data loss, catch up immediately on reconnection," which they enable without application-layer retry logic.

For the Cloudflare case: the MAXLEN-based bounded stream with a dedicated archival consumer group is a pattern worth memorizing. At FAANG, the same pattern appears whenever you need both hot-path processing (fast, bounded Redis stream) and cold-path durability (S3, GCS, BigQuery). The archival consumer runs ahead of all other consumers (it processes every message), writes to object storage in time-partitioned batches, and then other consumers process from Redis. When the Redis stream trims old entries, the archival copy in object storage serves as the source of truth for replay. Design the archival consumer to be the last dependency removed when decommissioning the Redis stream.

For the Alibaba case: the "eliminate one stateful system tier" principle deserves emphasis in any system design discussion. Each additional stateful system in a request path adds latency, increases failure surface area, and requires dedicated operational expertise. When proposing a new messaging system in a design interview, always account for the operational cost alongside the technical benefit. The strongest candidates quantify this: "adding Redis Streams to our existing Redis tier costs approximately 0 additional on-call shifts per month because the team already responds to Redis incidents, while adding Kafka costs approximately 2 additional on-call shifts per month for a team of 6 with no prior Kafka experience."

---
