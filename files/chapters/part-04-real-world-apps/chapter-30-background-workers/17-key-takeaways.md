## Key Points

1. **At-least-once delivery** is achievable. Exactly-once requires idempotent handlers
2. **Use FOR UPDATE SKIP LOCKED** for efficient concurrent dequeue from PostgreSQL
3. **Implement heartbeats** for long-running jobs to prevent lock expiry
4. **Apply backpressure** when queues are full - return 429 to producers
5. **Use distributed locks** for cron jobs across multiple worker instances
6. **Monitor queue depth** and auto-scale workers based on demand
7. **Track poison messages** and move them to dead letter queues after max retries

### Junior to FAANG: internalize these points until they are reflexive

These seven are the interview short-list. Memorize them, practice explaining them, and be ready to code any of them on demand.

- "At-least-once with idempotent handlers" is the single most important sentence in this chapter. Say it aloud. It rules out exactly-once semantics at the transport layer and forces the work into handler design, where it belongs.
- `FOR UPDATE SKIP LOCKED` is the Postgres queue primitive. Know the exact SQL. Practice writing it on a whiteboard.
- Heartbeats must renew at `visibility_timeout / 3`. Know the math.
- Backpressure returns 429 with `Retry-After`. Not 500. Not silent drop.
- Distributed locks for cron. Know that the correct technology is etcd for correctness, Redis SET NX for opportunistic dedup.
- Autoscale on oldest-message-age, not CPU, not queue depth alone.
- DLQ with rate-of-change alerting, not absolute-depth.

Extensions worth learning beyond the seven.

- Outbox pattern for transactional enqueue across stores.
- Temporal for durable execution of multi-step workflows.
- Fencing tokens for correctness locks.
- Fair scheduling for multi-tenant.
- Decorrelated jitter (AWS Architecture Blog).

### Senior at FAANG: these points as platform principles

At staff level, these seven become platform principles, not individual practices. A principle is a rule that applies to every handler written at the company without exception, enforced by the SDK.

**Principle 1, at-least-once plus idempotency.** SDK enforces that handlers declare an idempotency key source. Middleware stores `(key, result)` in a shared idempotency store. Replay is a no-op. Teams cannot opt out. Exactly-once semantics emerge from this middleware even though the transport is at-least-once.

**Principle 2, transactional enqueue.** SDK provides `EnqueueInTx(tx, job)`. Teams cannot dual-write. If they need to enqueue from a non-Postgres store, the SDK uses outbox. This eliminates the most common cause of lost jobs.

**Principle 3, heartbeats by default.** SDK spawns lease-renewal goroutine per job. Handlers never manage visibility timeout. Lease loss cancels handler ctx. Handlers must respect cancellation within a documented grace period.

**Principle 4, backpressure at every boundary.** Enqueue returns 429 on quota-exceeded. Dispatcher rate-limits during recovery. Downstream rate-limit coordinated across workers via shared token bucket. No team can produce a thundering herd.

**Principle 5, coordination via consensus for correctness.** Platform provides lease service (etcd-backed). Teams use the lease service, not Redis locks. Redis locks are allowed only for opportunistic dedup with idempotent handlers. Lint rules catch misuse.

**Principle 6, SLO-driven autoscaling.** Platform exposes oldest-message-age metric. KEDA scales on that signal with per-tier thresholds. Teams declare tier. Autoscaling just works.

**Principle 7, DLQ as product.** Platform DLQ with RBAC, triage SLA, rate alerting, archiving. Teams do not run their own DLQ. Replay is a platform operation with audit log.

**Meta-principle, the platform enforces these practices.** The difference between a junior ticking boxes and a staff engineer architecting prevention is that the junior applies these practices in their code, and the staff engineer makes it impossible for anyone to write code that does not apply them.

**Platform maturity arc.** In year 1, write these principles down as a manifesto. In year 2, implement SDK and migrate early adopters. In year 3, enforce org-wide and deprecate non-conformant code. In year 4, publish SLO-backed internal product and onboard acquired teams. In year 5, contribute back to open source (like river did with its transactional-enqueue model, or asynq with its web UI). This is the staff-to-principal arc for anyone owning async work at a FAANG.

**Closing thought for the staff reader.** Background workers are not a feature. They are infrastructure. Infrastructure only matters when it fails, and when it fails it takes down the product. Invest ahead of growth, consolidate team-owned systems, enforce principles in code, and publish SLOs. Everything else is noise.

