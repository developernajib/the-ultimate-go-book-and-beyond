# Chapter 30: Background Workers and Job Queues

*"Never do in a request what you can do in a background job. Your users will thank you."* - Anonymous

Every production application eventually accumulates work that cannot or should not happen in the synchronous request path. Sending emails, generating reports, processing uploaded files, calling slow third-party APIs, resizing images, and aggregating analytics are all tasks that would make request latency unacceptable if done inline. The answer is background processing: decouple the triggering event from the actual work, place the job in a queue, and let a dedicated worker process it asynchronously. This pattern is not an optimization - at any meaningful scale, it is a requirement.

Go's concurrency model makes it one of the best languages for background worker systems. Goroutines are cheap enough to run a worker pool of thousands without breaking a sweat. Channels provide natural backpressure. The `context` package wires cancellation signals all the way from a graceful shutdown handler down into individual job processors. Combined with PostgreSQL's `FOR UPDATE SKIP LOCKED` clause or Redis sorted sets, Go workers can achieve reliable, at-least-once job processing without expensive distributed coordination protocols.

This chapter builds a complete background job processing system: configurable worker pools with backpressure, persistent database-backed and Redis-backed queues, retry logic with exponential backoff, dead-letter queues, distributed cron scheduling with lock-based deduplication, and full observability via metrics and health endpoints. The architecture mirrors what Uber's Cadence, Stripe's job infrastructure, and Netflix's Conductor use to process hundreds of millions of async tasks daily.

**The 2026 Go job-queue landscape.** You rarely need to write all of this from scratch. Production Go teams today reach for one of four well-known options, each solving a different shape of problem:

- **`riverqueue/river`**, a Postgres-backed job queue that uses `LISTEN`/`NOTIFY` and `FOR UPDATE SKIP LOCKED` for low-latency pickup. It is the default choice when you already run Postgres and want transactional enqueue (insert the job in the same transaction as the business write, no outbox needed).
- **`hibiken/asynq`**, a Redis-backed task queue with priorities, retries, scheduled jobs, unique jobs, and a web UI (Asynqmon). The default choice when you run Redis and want high-throughput, simple operational semantics.
- **`robfig/cron/v3`** for cron-style scheduling inside a single process, with time-zone support and second-precision schedules.
- **`temporal.io`** (plus the `go.temporal.io/sdk` client) when your "job" is actually a long-running business process with compensation, human-in-the-loop steps, or timers that span days. Temporal is not a queue. It is a durable-execution engine that replays workflow code deterministically from a history log.

Building the pieces yourself, as this chapter does, remains the best way to understand what these libraries do for you and to debug them when they misbehave in production.

**What you'll learn in this chapter:**
- Designing configurable worker pools with concurrency limits, graceful shutdown, and channel-based backpressure
- Building persistent job queues backed by PostgreSQL (`SKIP LOCKED`) and Redis sorted sets with priority support
- Implementing reliable job processing with retry policies, exponential backoff, and dead-letter queue routing
- Scheduling recurring jobs with a distributed cron system that uses advisory locks to prevent duplicate execution
- Collecting worker observability: processing time histograms, queue depth gauges, error rate counters, and health endpoints
- Coordinating workers across multiple instances using distributed locks for singleton job execution
- Handling job visibility timeouts and zombie worker recovery for at-least-once delivery guarantees
- Structuring worker code for testability with dependency injection, mock queues, and deterministic test execution

**Why this matters at scale:**
Uber processes over 100 million background jobs daily through their Cadence workflow engine, built on Go worker pools using the same backpressure and retry patterns covered here. Stripe's payment processing pipeline relies on background workers for webhook delivery, fraud analysis, and ledger reconciliation - each job processed with exactly-once guarantees on infrastructure structurally identical to what you'll build in this chapter.

**Prerequisites:** Chapter 11 (Goroutines & Channels), Chapter 14 (Context & Cancellation), Chapter 32 (Database Patterns), Chapter 27 (Idempotency)

### Junior to FAANG: the mental model you need before your first on-call week

If you have never owned a job queue, the mental leap is realizing that a "background job" is not a function call. It is a message that must survive process crashes, network partitions, deploys, and the occasional rack failure. The first time you forget this, you will ship a worker that loses 0.1% of jobs during rolling deploys, and the billing team will find it before you do.

Concrete prerequisites to pick up in order:

1. Read one chapter on at-least-once delivery before writing any producer. If your handler is not idempotent, at-least-once becomes at-least-twice-charged.
2. Understand the difference between enqueue and commit. Enqueue inside the same database transaction as the business write, or use the outbox pattern. Never enqueue to Redis then commit the DB row, because the reverse ordering drops jobs on DB rollback and the forward ordering drops jobs on Redis downtime.
3. Walk through this sequence by hand on paper. User submits form, HTTP handler writes row, HTTP handler enqueues job, worker picks up job, worker fails halfway, worker crashes, visibility timeout expires, another worker picks up job, job succeeds. Can you explain which step is non-idempotent, and why it matters. If not, re-read Chapter 27.
4. Know what "visibility timeout" means in SQS language, what "lease duration" means in Temporal language, and what "ack deadline" means in Pub/Sub language. They are the same concept under different names.

Worked example of a first-job bug you will personally ship. You write `SendWelcomeEmail(userID)`, enqueue it on signup, worker picks it up, sends the email, then crashes before ack. Visibility timeout expires, a second worker picks it up, second welcome email sent. Fix is not "retry fewer times". Fix is an idempotency key keyed on `(user_id, template_version)` stored in a `sent_emails` table with a unique constraint. The worker inserts that row inside the same transaction that records the send. Re-delivery becomes a no-op because the unique constraint fires.

Interview entry points for new-grads and L3/L4 candidates. Expect at least one of these in a systems round at any FAANG.

- "Design a system to send 10 million password reset emails per day." They want you to say producer, queue, worker, retries, DLQ, rate limiting by provider, and idempotency key.
- "Why might a job run twice." They want at-least-once semantics, visibility timeout, worker crash after side effect but before ack.
- "How do you schedule a job for 7 days from now." They want delayed queues, Redis ZSET with score as unix timestamp, or SQS delay seconds, or a scheduled_at column polled every second.

### Senior at FAANG: platform thinking for job infrastructure across an org

Staff and principal engineers who own job platforms are not writing handlers. They are writing the contract that lets every team at the company run async work without filing a ticket, and the contract must survive for a decade.

**Platform contract (the document you will be judged on).** A platform worker contract at FAANG scale typically specifies, as versioned guarantees:

- Delivery semantics (at-least-once is the default, exactly-once via idempotency keys at the handler layer, never via the transport).
- Latency SLO per priority tier (e.g. P50 enqueue-to-start under 200ms for tier-0, under 5s for tier-1, best-effort for tier-2).
- Throughput quotas per tenant (jobs per second, concurrent inflight, max payload bytes).
- Retry policy (max attempts, base delay, jitter strategy, dead-letter after N).
- Payload schema contract (protobuf with backwards-compat rules, no JSON blobs without a registered schema).
- Observability guarantees (every job emits start, end, retry, failure spans tagged with tenant, job_type, and version).
- Graceful drain SLA during deploys (under 60s with zero message loss).

**Technology selection ADR, abbreviated.** When Google-scale teams pick between SQS, Kafka, NATS JetStream, Temporal, asynq, and river, the decision matrix collapses to four axes.

1. Workload shape. Short tasks (under 1 minute) with simple retry go on SQS or asynq or river. Long-running workflows with compensation go on Temporal or Cadence. Fan-out event streams with multiple consumer groups go on Kafka. Ephemeral low-latency RPC-ish work goes on NATS.
2. Durability class. Kafka and Temporal persist to disk with replication before ack. SQS persists to three AZs. Redis-backed queues (asynq) are durable only if AOF fsync is tuned aggressively, which costs throughput. river is durable because Postgres is durable.
3. Throughput ceiling. Kafka scales to millions of messages per second per broker. SQS scales elastically with per-queue quotas. Redis single-shard tops out around 100k ops/sec. Postgres-backed (river) tops out around 10k jobs/sec per partition before you need sharding.
4. Operational surface. Temporal is a cluster you run (or pay for). SQS is managed. Kafka is a lifestyle. Redis is trivial until it is not. Postgres-backed is trivial if you already run Postgres, which at a FAANG you always do.

**Outbox versus CDC.** The transactional-enqueue problem is solved two ways at scale. Outbox pattern writes the job into an `outbox` table in the same transaction as the business write, then a relay polls or tails the table and publishes to the queue. CDC (Debezium, Maxwell, or AWS DMS) tails the write-ahead log directly. Outbox is simpler and sufficient for under 10k writes/sec per service. CDC is required when outbox polling becomes the hot path. Meta and Uber have both published on migrating from outbox to CDC after crossing roughly 50k writes/sec per service. Staff-level trade-off is that CDC couples your queue semantics to your DB schema migrations, which means schema changes become cross-team coordination events.

**DLQ operations as a product.** At FAANG, the DLQ is not a table. It is a product. You need a replay tool with filtering (by job_type, by tenant, by failure_reason, by time window), a quarantine tool for poison pills, a diff tool for comparing original and replayed outputs, and an RBAC layer because replaying a billing job into prod is a privileged action. Netflix and Stripe both run DLQ admin UIs that require two-person approval for replays over a threshold.

**Fair scheduling and noisy neighbors.** A single tenant submitting 10 million jobs must not starve the other 9999 tenants. The industry pattern is weighted fair queueing with per-tenant token buckets and a scheduler that pulls from tenant queues in round-robin order weighted by quota. Amazon SQS FIFO with message group IDs is a coarse version of this. Temporal task queues with activity-level rate limits are a finer version. In-house implementations typically use a two-level queue (per-tenant queue, then a global dispatcher) with credit-based admission control.

**Distributed cron at scale.** Single-leader cron (one node runs, others standby) is fine up to a few hundred schedules. Past that, you want a sharded scheduler where schedules are hashed to shards and each shard elects a leader via etcd or ZooKeeper. Redlock is controversial for this because of the Kleppmann-Antirez debate on clock assumptions. The FAANG consensus is to use a consensus-backed lock (etcd, ZooKeeper, Spanner TrueTime locks at Google) for anything where a duplicate execution is a correctness bug, and Redis SET NX PX only for opportunistic deduplication where the handler is idempotent.

**Visibility timeout tuning.** The most common SEV-2 on worker platforms is a visibility timeout tuned to P99 job latency. When P99.9 doubles during a bad deploy, every long job double-runs. The principled approach is a handler-reported heartbeat that extends the lease, combined with a hard cap that routes to DLQ. SQS supports ChangeMessageVisibility. Temporal supports activity heartbeats. Your in-house framework needs the same.

**Autoscaling signal.** Autoscaling workers on CPU is wrong. Autoscale on queue depth or, better, on lag seconds (oldest-message-age). Lag seconds is the correct signal because it directly ties to SLO. Kubernetes KEDA supports both SQS and Kafka lag-based autoscaling natively. At FAANG scale you typically write your own scaler that factors in job_type priority and predicted burn-down rate.

**Multi-year roadmap archetype.** A staff engineer owning job infra at a FAANG will typically run a 3-year plan. Year 1, consolidate fragmented team-owned queues onto a single platform with the contract above. Year 2, migrate long-running workflows to Temporal and deprecate hand-rolled state machines. Year 3, offer exactly-once semantics via handler-side idempotency-key infrastructure (Stripe's `idempotency_key` model) and publish the platform as an internal product with SLA-backed tiers. The roadmap is judged on reduction of team-owned queue incidents, reduction of duplicate-execution bugs, and adoption rate measured as percentage of new services using the platform in their first month.

**Incident command pattern for queue outages.** When the queue is down, every async write in the company is degraded. The staff-level move is to precompute a degradation matrix before the incident: which job types can be dropped, which must be buffered to local disk, which must fail closed (block the upstream write), and which must fail open. Publish it, drill it quarterly, and wire it into runbooks. At Amazon, this is called a "graceful degradation playbook" and is a required artifact for any tier-0 service.

---
