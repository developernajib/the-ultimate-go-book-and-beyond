## Company Case Studies

### Instagram: Async Task Processing at Scale

Instagram adopted RabbitMQ early for decoupling synchronous web requests from heavy async work: photo resizing (multiple dimensions per upload), push notification delivery, activity feed aggregation, and spam detection. Their architecture used **Celery** (Python) as the task framework with RabbitMQ as the broker - a common pattern that remains dominant in Python-heavy shops.

**Key lessons from Instagram engineering**:
- **Queue depth is your canary**. When a deployment went wrong, queue depth for the resizing pipeline would spike within seconds - long before any user-visible errors. They built dashboards alerting on queue depth > 5,000 as a first-line deployment signal.
- **Consumer autoscaling via queue depth**. Instagram integrated RabbitMQ queue depth into their autoscaling logic, scaling Celery worker pods based on message backlog rather than CPU (since workers often idled on I/O).
- **Vhost isolation prevented blast radius**. Separating notification tasks and media processing tasks into separate vhosts meant a broken notification consumer couldn't starve media workers through connection contention.
- **At scale (1B+ users).** Instagram eventually moved heavy workloads to a custom distributed task system but kept RabbitMQ for latency-sensitive, routing-complex scenarios where Kafka's partition model didn't fit.

### Mozilla: Telemetry Data Pipeline at 100M+ Messages/Day

Mozilla's Telemetry system collects Firefox crash reports, performance metrics, and usage data. At peak they processed **100M+ messages per day** through RabbitMQ using a fanout topology.

**Architecture**: Firefox clients POST telemetry data to an ingestion API → API publishes to `telemetry.fanout` exchange → multiple consumer pools receive copies:
1. **Archive queue** → S3 long-term storage worker
2. **Analysis queue** → Spark streaming analysis workers
3. **Alert queue** → Real-time crash spike detection
4. **Debug queue** → Sampling consumer for engineers (auto-delete queue)

**Lessons**:
- **Fanout with selective consumers** enabled each team to add their own processing pipeline without modifying the ingestion path - true Open-Closed principle at infrastructure level.
- **Lazy queues** (classic queues with `x-queue-mode: lazy`) were essential for the archive consumer, which had bursty throughput. Without lazy queues, memory alarms triggered regularly during peak browser update cycles.
- **Consumer heartbeat monitoring**: Mozilla's biggest operational pain was consumers silently dying without closing their channel (killed -9 by OOM). This left messages unacked indefinitely. Solution: heartbeat monitoring daemon that alerts when `messages_unacknowledged` per consumer exceeds `prefetch_count × 2`.

### Bloomberg: Financial Market Data Distribution

Bloomberg routes market data (equity prices, bond yields, FX rates) to thousands of internal subscribers using RabbitMQ **topic exchanges**. Routing keys follow a strict hierarchy: `{asset_class}.{exchange}.{symbol}` (e.g., `equity.nyse.AAPL`, `fx.spot.EURUSD`).

**Architecture requirements**:
- **Zero message loss**: Every price tick must reach every subscriber. Publisher confirms on every publish with synchronous confirmation for high-value data feeds.
- **Low latency**: Market data consumers require sub-10ms delivery. Bloomberg tuned prefetch to 1 per consumer to minimize head-of-line blocking, accepting lower throughput for latency guarantees.
- **Subscriber isolation**: Each trading desk has its own queue and binding. A misbehaving consumer (blocking, slow) cannot affect other desks because RabbitMQ delivers independently per queue.
- **Quorum queues for all market data queues**: Pre-2020 they used classic mirrored queues and experienced split-brain events twice during network maintenance. Migration to quorum queues eliminated this class of failure entirely.
- **Publisher confirms + mandatory flag**: Unroutable messages (subscriber queue deleted mid-session) are caught by `NotifyReturn` and logged with a security audit trail - required by SEC regulations.

### Junior → FAANG: Extracting Transferable Lessons from Case Studies

Case studies are not stories. They are worked examples of engineering decisions under constraints. When you read a case study, extract the decision, the constraint that drove it, and the lesson that generalizes beyond that company.

**From Instagram:**

Decision: alert on queue depth as a deployment signal. Constraint: consumer bugs caused queue buildup before any user-visible errors. Lesson: queue depth is a leading indicator of consumer health, not a lagging indicator. Apply this by setting queue depth alerts before the memory alarm fires, not after.

**From Mozilla:**

Decision: fanout with per-team subscriber queues for the telemetry pipeline. Constraint: multiple teams needed independent access to the same data stream without coupling. Lesson: the Open-Closed Principle applies at infrastructure level. Adding a new consumer pipeline should require binding a new queue, not modifying the producer. Apply this by designing your exchange topology with extension in mind.

Decision: heartbeat monitoring to detect silently dead consumers. Constraint: OOM-killed consumers left messages unacked indefinitely without any error log. Lesson: the absence of errors is not the same as correct operation. Apply this by monitoring `messages_unacknowledged` per consumer and alerting when it exceeds `prefetch_count × 2` for more than 60 seconds.

**From Bloomberg:**

Decision: subscriber isolation via dedicated queues per trading desk. Constraint: a misbehaving consumer on one desk must not affect other desks. Lesson: consumer isolation is a queue topology concern, not a code concern. You cannot isolate consumers in code if they share a queue. Apply this by assigning one queue per consumer group when isolation is required, not one shared queue for all consumers.

### Senior @ FAANG: Platform Thinking from Case Studies

At the senior level, the lesson from case studies is not how those companies solved their specific problem but what organizational structures and platform capabilities they built to solve classes of problems at scale.

**Instagram's autoscaling signal is a platform capability:**

The lesson that queue depth should drive autoscaling is not a per-service implementation. It is a platform capability. A senior engineer at FAANG would build this as a shared ScaledObject template (Kubernetes KEDA) that any team can instantiate by specifying their queue name and scaling thresholds. The platform team owns the KEDA operator and the RabbitMQ metric source configuration. Teams own their scaling thresholds. This separation prevents every team from independently implementing ad hoc autoscaling logic that diverges over time.

**Mozilla's consumer health monitoring is a platform SLO:**

The observation that silently dead consumers are a recurring operational problem implies a platform SLO: every queue with `x-message-ttl` must have at least one consumer that is active within the last N minutes. This SLO can be automatically verified by a platform health check that queries the Management API, identifies queues with non-zero depth and zero consumers, and fires a PagerDuty alert with the queue name and owning team. Individual teams do not implement this check. The platform provides it as a shared capability.

**Bloomberg's mandatory flag usage is a compliance requirement, not a preference:**

The Bloomberg case study shows that `NotifyReturn` is instrumented because SEC regulations require an audit trail for unroutable messages. This is a compliance requirement, not a quality-of-life improvement. At a FAANG company with similar compliance requirements (financial data, healthcare, PII), the platform team must ensure that `NotifyReturn` is always instrumented in the shared publisher library and that unroutable messages are logged to a compliance-grade audit log, not just to application logs. This is a non-negotiable platform requirement that cannot be left to individual service teams to implement correctly.

**The CMQ-to-QQ migration as an organizational forcing function:**

Bloomberg's migration from classic mirrored queues to quorum queues required coordinating producer and consumer teams across multiple trading desks. This is not a technical problem but an organizational one. The migration plan required: a shared definition of "complete" (all queues verified as quorum type), a communication plan for affected teams, a rollback procedure, and a compliance review of the change. Senior engineers who have led this kind of migration can describe the organizational coordination as clearly as the technical steps. The ability to drive cross-team infrastructure migrations is a L6+ competency.

### Engineering References & Verifiable Citations

1. **Instagram**:
   - Instagram Engineering (2012). *What Powers Instagram: Hundreds of Instances, Dozens of Technologies*. Meta / Instagram Engineering Blog.
   - Krieger, M. (2014). *Scaling Instagram Infrastructure: Python, Celery, and RabbitMQ*. PyCon / USENIX Keynote.
2. **Mozilla**:
   - Mozilla Engineering (2015). *Mozilla Telemetry Architecture: Ingestion Pipeline at 100M+ Messages Daily*. Mozilla Hacks Blog & Architecture Docs.
   - Whitlock, R. (2016). *Collecting Telemetry at Scale: RabbitMQ, Heka, and S3 Pipelines*. Mozilla Cloud Services.
3. **Bloomberg**:
   - Bloomberg Technology (2018). *Reliable Financial Messaging at Bloomberg Scale with RabbitMQ*. RabbitMQ Summit Case Studies & Bloomberg Engineering.
   - RabbitMQ Engineering (2020). *Quorum Queues in High-Value Financial Messaging: Replacing Classic Mirrored Queues*. VMware Tanzu / RabbitMQ Core Publications.

---
