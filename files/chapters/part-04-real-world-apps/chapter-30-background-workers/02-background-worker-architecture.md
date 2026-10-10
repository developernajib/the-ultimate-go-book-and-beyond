## Background Worker Architecture

The following diagram shows how the pool manager distributes jobs across workers, how workers communicate completion through channels, and how the dead-letter queue captures failed jobs. This flow determines where bottlenecks appear and where failures surface in production.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                    BACKGROUND WORKER ARCHITECTURE                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         Job Producers                                   │     │
│  │                                                                         │     │
│  │   Web App          API Server        Scheduler        Other Workers     │     │
│  │      │                │                 │                  │            │     │
│  │      └────────────────┴────────┬────────┴──────────────────┘            │     │
│  │                                │                                        │     │
│  │                                ▼                                        │     │
│  │                    ┌────────────────────┐                               │     │
│  │                    │   Job Enqueue API  │                               │     │
│  │                    │                    │                               │     │
│  │                    │  - Validate job    │                               │     │
│  │                    │  - Set priority    │                               │     │
│  │                    │  - Schedule time   │                               │     │
│  │                    │  - Deduplication   │                               │     │
│  │                    └─────────┬──────────┘                               │     │
│  │                              │                                          │     │
│  └──────────────────────────────┼──────────────────────────────────────────┘     │
│                                 │                                                │
│                                 ▼                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         Job Storage                                     │     │
│  │                                                                         │     │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │     │
│  │  │  PostgreSQL     │  │  Redis          │  │  Cloud Queue    │          │     │
│  │  │  (Durable)      │  │  (Fast)         │  │  (Managed)      │          │     │
│  │  │                 │  │                 │  │                 │          │     │
│  │  │  - ACID         │  │  - In-memory    │  │  - AWS SQS      │          │     │
│  │  │  - Queryable    │  │  - Pub/sub      │  │  - Google Tasks │          │     │
│  │  │  - Reliable     │  │  - Sorted sets  │  │  - Azure Queue  │          │     │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │     │
│  │           │                    │                    │                   │     │
│  │           └────────────────────┼────────────────────┘                   │     │
│  │                                │                                        │     │
│  │           ┌────────────────────┼────────────────────┐                   │     │
│  │           │                    │                    │                   │     │
│  │           ▼                    ▼                    ▼                   │     │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │     │
│  │  │ Immediate Queue │  │  Delayed Queue  │  │ Dead Letter Q   │          │     │
│  │  │                 │  │                 │  │                 │          │     │
│  │  │ Ready to run    │  │ Scheduled jobs  │  │ Failed jobs     │          │     │
│  │  │ Priority sorted │  │ Time sorted     │  │ For inspection  │          │     │
│  │  └────────┬────────┘  └────────┬────────┘  └─────────────────┘          │     │
│  │           │                    │                                        │     │
│  │           │                    │ (when ready)                           │     │
│  │           │◄───────────────────┘                                        │     │
│  │           │                                                             │     │
│  └───────────┼─────────────────────────────────────────────────────────────┘     │
│              │                                                                   │
│              ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │                         Worker Pool                                     │     │
│  │                                                                         │     │
│  │  ┌────────────────────────────────────────────────────────────────┐     │     │
│  │  │                     Pool Manager                               │     │     │
│  │  │                                                                │     │     │
│  │  │  - Start/stop workers     - Graceful shutdown                  │     │     │
│  │  │  - Auto-scale workers     - Health monitoring                  │     │     │
│  │  │  - Load balancing         - Metrics collection                 │     │     │
│  │  │                                                                │     │     │
│  │  └────────────────────────────┬───────────────────────────────────┘     │     │
│  │                               │                                         │     │
│  │         ┌─────────────────────┼─────────────────────┐                   │     │
│  │         │                     │                     │                   │     │
│  │         ▼                     ▼                     ▼                   │     │
│  │  ┌────────────┐        ┌────────────┐        ┌────────────┐             │     │
│  │  │  Worker 1  │        │  Worker 2  │        │  Worker N  │             │     │
│  │  │            │        │            │        │            │             │     │
│  │  │ ┌────────┐ │        │ ┌────────┐ │        │ ┌────────┐ │             │     │
│  │  │ │  Job   │ │        │ │  Job   │ │        │ │  Job   │ │             │     │
│  │  │ │Process │ │        │ │Process │ │        │ │Process │ │             │     │
│  │  │ └────────┘ │        │ └────────┘ │        │ └────────┘ │             │     │
│  │  │            │        │            │        │            │             │     │
│  │  │ - Fetch    │        │ - Fetch    │        │ - Fetch    │             │     │
│  │  │ - Execute  │        │ - Execute  │        │ - Execute  │             │     │
│  │  │ - Ack/Nack │        │ - Ack/Nack │        │ - Ack/Nack │             │     │
│  │  │ - Retry    │        │ - Retry    │        │ - Retry    │             │     │
│  │  └────────────┘        └────────────┘        └────────────┘             │     │
│  │                                                                         │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│                                                                                  │
│                           JOB LIFECYCLE                                          │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                          │    │
│  │   ENQUEUED ──► PENDING ──► RUNNING ──► COMPLETED                         │    │
│  │       │           │           │                                          │    │
│  │       │           │           │ (failure)                                │    │
│  │       │           │           ▼                                          │    │
│  │       │           │       RETRYING ────┐                                 │    │
│  │       │           │           │        │ (max retries)                   │    │
│  │       │           │           ▼        ▼                                 │    │
│  │       │           └────► PENDING    FAILED ──► DEAD_LETTER               │    │
│  │       │                                                                  │    │
│  │       │ (scheduled)                                                      │    │
│  │       ▼                                                                  │    │
│  │   DELAYED ──────────────────────────────► PENDING (when time)            │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│                                                                                  │
│                       RETRY STRATEGY                                             │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                          │    │
│  │   Attempt 1: Immediate                                                   │    │
│  │   Attempt 2: +1 minute    (exponential backoff with jitter)              │    │
│  │   Attempt 3: +5 minutes                                                  │    │
│  │   Attempt 4: +30 minutes                                                 │    │
│  │   Attempt 5: +2 hours                                                    │    │
│  │   After max attempts → Dead Letter Queue                                 │    │
│  │                                                                          │    │
│  │   Retry calculation:                                                     │    │
│  │   delay = min(base * (2 ^ attempt) + jitter, maxDelay)                   │    │
│  │                                                                          │    │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Junior to FAANG: reading the diagram, not memorizing it

The diagram has four layers. Producers, storage, pool manager, workers. For your first job queue, ignore cloud queues and DLQ tooling. Focus on the enqueue path (producer writes to storage in the same transaction as the business write) and the ack path (worker marks job done only after the side effect is durable).

Walkthrough for a single job. A user signs up. The signup handler inserts a row into `users` and a row into `jobs` in the same DB transaction. The transaction commits. A worker polls `jobs` for a pending row using `FOR UPDATE SKIP LOCKED`, marks it `RUNNING`, runs the handler, and on success updates the row to `COMPLETED`. If the handler panics, a deferred recover marks it `RETRYING` with a computed `run_at` in the future. After five attempts, the row moves to `FAILED` and appears in the DLQ view.

Entry-point question for interviews. "Draw the architecture of a background job system." Draw these four layers, name at least two storage options, and specify at which boundary each failure mode occurs (producer-storage loss, storage-worker double delivery, worker side-effect leakage). Candidates who draw all four layers and name one failure per boundary clear the bar.

### Senior at FAANG: architectural decisions hidden inside the diagram

The diagram is a reference architecture. Every arrow is an ADR. A staff engineer reviewing this architecture would interrogate:

**Producer to storage.** Is the enqueue transactional with the business write. If no, you need the outbox pattern or CDC. If the storage is a separate service (Redis, SQS), you need a two-phase strategy. Write to outbox in the same tx, then a relay publishes to the external queue with at-least-once delivery. At Amazon retail, the relay is a dedicated service that has its own SLOs, because its availability becomes the floor availability of every async write in the system.

**Storage choice as a tenancy decision.** The diagram shows Postgres, Redis, and cloud queue as peers. In a real platform, they are tiers. Tier-0 critical work (payments, ledger) goes on Postgres or Kafka for durability and auditability. Tier-1 user-visible work (emails, notifications) goes on SQS or asynq for operational simplicity. Tier-2 analytics work goes on Kafka because it naturally fans out. The platform exposes a single API and routes internally based on job_type.

**Pool manager as a control plane.** The pool manager is drawn as a single box. In reality, at FAANG scale it is a control plane. It owns worker registration, capability advertisement (worker node X can run job_types A, B, C), fair scheduling across tenants, and lease renewal. This is where Temporal's task queue model and Kubernetes' scheduler model converge. At Uber, the Cadence matching service plays this role. A staff-level review would ask, where does the control plane persist its scheduling state, and what is the blast radius when it is unavailable.

**Retry strategy ownership.** The diagram shows a single retry strategy. A real platform has per-job-type retry policies, because a Stripe charge retry (idempotent, rare transient failures, expensive to retry) has different economics than a push notification retry (idempotent, common transient failures, cheap to retry). The retry policy should be declarative, versioned, and reviewable in code review, not hidden in handler code.

**Retry with jitter choice.** The formula `delay = min(base * 2^attempt + jitter, maxDelay)` is wrong at scale. Full jitter (AWS Architecture Blog formulation) is `delay = random(0, min(cap, base * 2^attempt))`. Decorrelated jitter is `delay = min(cap, random(base, prev * 3))`. The FAANG default is decorrelated jitter because it avoids the thundering herd that additive jitter produces when many jobs fail simultaneously, for example during a downstream outage.

**DLQ routing as a workflow.** The DLQ is drawn as a terminal state. A staff-level platform treats DLQ as a workflow with states (quarantined, triaged, replayable, archived) and owners. The lifecycle is, job lands in DLQ, on-call triages within 24 hours, writes a root cause, either replays with a fix or archives with justification. This is what Netflix's Conductor DLQ UI implements.

**Visibility timeout as a contract.** The diagram does not show visibility timeout, which is the single most common source of duplicate execution in production. A staff engineer would add an explicit "lease" box between storage and worker, with documented lease duration, heartbeat extension, and the exact behavior when a lease expires while the handler is still running (the platform default should be, lease expires, handler's context is canceled, second worker picks up, original handler discovers its lease is invalid on next heartbeat and aborts).

**Rolling deploy safety.** The diagram assumes workers can be stopped and started freely. In production, a rolling deploy is the most common source of dropped jobs. The platform contract must specify, on SIGTERM, worker stops accepting new jobs, finishes inflight jobs up to a grace deadline (typically 60s), heartbeats its leases to prevent takeover, and exits. Kubernetes preStop hooks plus a terminationGracePeriodSeconds tuned to grace + 10s is the standard pattern.

**Cross-region architecture omission.** The diagram is single-region. At FAANG scale, you must specify active-active versus active-passive, whether jobs can be processed in any region or must be region-pinned (data residency, GDPR), and how the DLQ is replicated. Stripe's queue infra pins job execution to the region of the owning account to respect data locality. Spelling this out is a staff-level architectural decision that junior engineers typically miss.

---
