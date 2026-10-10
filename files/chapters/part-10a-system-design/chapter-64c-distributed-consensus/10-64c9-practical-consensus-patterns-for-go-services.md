## 64C.9 Practical Consensus Patterns for Go Services

### When You Do NOT Need Consensus

The most important lesson: **the vast majority of application-level services do not need consensus**. Consensus algorithms are expensive (multiple network round trips, persistent writes to quorum) and complex. Before reaching for etcd or implementing Raft, ask:

```
Decision tree for consensus:

Do you need strict ordering of all operations?
  YES → Do you need to coordinate across multiple processes?
    YES → Is eventual consistency acceptable?
      YES → Use a message queue + idempotent consumers
      NO  → Use consensus (etcd / Raft-based DB)
    NO  → Use a single-node DB with WAL (SQLite, PostgreSQL)
  NO  → Eventual consistency is likely fine (Cassandra, DynamoDB)

Use cases that genuinely need consensus:
  - Leader election
  - Distributed locks (when fencing is required)
  - Configuration that must be consistent across all nodes
  - Sequence/ID generation that must be globally unique and ordered
  - Cluster membership
```

### Singleton Worker Pattern

The most common use of leader election in Go services: ensuring exactly one goroutine across a cluster performs a task.

```go
// patterns/singleton_worker.go
package patterns

import (
	"context"
	"log"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// SingletonWorker runs a function on exactly one node in the cluster at a time.
// When the leader changes, the function is stopped on the old leader and
// started on the new leader.
type SingletonWorker struct {
	elector *LeaderElector
	work    func(ctx context.Context)
}

func NewSingletonWorker(client *clientv3.Client, workName, nodeID string,
	work func(ctx context.Context)) *SingletonWorker {

	var workCtx context.Context
	var workCancel context.CancelFunc

	elector := NewLeaderElector(client, Config{
		ElectionName: workName,
		NodeID:       nodeID,
		TTLSeconds:   15,
		OnBecomeLeader: func() {
			workCtx, workCancel = context.WithCancel(context.Background())
			go work(workCtx)
			log.Printf("[%s] started singleton work", nodeID)
		},
		OnBecomeFollower: func() {
			if workCancel != nil {
				workCancel()
				workCancel = nil
			}
			log.Printf("[%s] stopped singleton work", nodeID)
		},
	})

	return &SingletonWorker{elector: elector, work: work}
}

func (sw *SingletonWorker) Run(ctx context.Context) error {
	return sw.elector.Run(ctx)
}
```

### Distributed Cron - Exactly-Once Job Execution

Without coordination, every node in a cluster will fire the same cron job simultaneously, causing duplicate processing, conflicting writes, and wasted resources. This pattern uses an etcd compare-and-swap (CAS) transaction to atomically "claim" each scheduled tick: a node writes a key scoped to the job name and time bucket only if that key does not yet exist. Because etcd guarantees linearizable writes, exactly one node wins the race across the entire cluster, and the key's TTL-backed lease ensures the lock expires automatically if the winner crashes before the job completes.

```go
// patterns/distributed_cron.go
package patterns

import (
	"context"
	"fmt"
	"log"
	"time"

	clientv3 "go.etcd.io/etcd/client/v3"
)

// DistributedCron runs a job at most once per schedule interval across the cluster.
// Uses etcd transactions to ensure exactly-once execution semantics.
type DistributedCron struct {
	client   *clientv3.Client
	jobName  string
	interval time.Duration
	job      func(ctx context.Context) error
}

func NewDistributedCron(client *clientv3.Client, jobName string,
	interval time.Duration, job func(ctx context.Context) error) *DistributedCron {

	return &DistributedCron{
		client:   client,
		jobName:  jobName,
		interval: interval,
		job:      job,
	}
}

func (dc *DistributedCron) Run(ctx context.Context) {
	ticker := time.NewTicker(dc.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case t := <-ticker.C:
			// Try to "claim" this tick using a CAS transaction
			tickKey := fmt.Sprintf("/cron/%s/%d", dc.jobName, t.Unix()/int64(dc.interval.Seconds()))

			txnCtx, cancel := context.WithTimeout(ctx, 5*time.Second)

			// Grant the lease once, up front. Inlining mustCreateLease
			// in the Then() clause would grant a fresh lease on EVERY
			// node every tick (the argument is evaluated before
			// Commit), so every loser of the CAS would leak a lease
			// until its TTL. Grant here, revoke below if we lose.
			lease, lerr := dc.client.Grant(txnCtx, 2*int64(dc.interval.Seconds()))
			if lerr != nil {
				cancel()
				log.Printf("[cron:%s] lease grant error: %v", dc.jobName, lerr)
				continue
			}

			resp, err := dc.client.Txn(txnCtx).
				// Only execute if the tick key does not exist
				If(clientv3.Compare(clientv3.Version(tickKey), "=", 0)).
				Then(clientv3.OpPut(tickKey, "running", clientv3.WithLease(lease.ID))).
				Commit()

			if err != nil || !resp.Succeeded {
				// We lost the race (or errored): release our lease so
				// it does not linger for the full TTL.
				dc.client.Revoke(txnCtx, lease.ID)
				cancel()
				continue // Another node claimed this tick
			}
			cancel()

			// We claimed the tick - execute the job
			log.Printf("[cron:%s] executing", dc.jobName)
			jobCtx, jobCancel := context.WithTimeout(ctx, dc.interval)
			if err := dc.job(jobCtx); err != nil {
				log.Printf("[cron:%s] error: %v", dc.jobName, err)
			}
			jobCancel()
		}
	}
}

```

---

### Junior → FAANG: Applying Consensus Patterns in Real Codebases

The singleton worker and distributed cron patterns in this section represent the two most common uses of leader election in production Go services. Build intuition for when each is appropriate.

**Singleton worker: when exactly one instance must own a resource.** The use cases are narrow but important: sending digest emails (one sender per time bucket), running database migrations (one migrator per deployment), acting as a shard coordinator (one coordinator per shard group). The key property is that running two instances simultaneously is incorrect, not just wasteful. If two instances running simultaneously would produce duplicate events, incorrect totals, or conflicting writes, use a singleton worker.

**Distributed cron: when jobs must run exactly once per schedule interval.** The CAS-based tick claiming in `DistributedCron` is correct but not perfectly exactly-once: if the job runner crashes after claiming the tick but before completing the job, the tick's lease expires and no other instance claims it (because the key exists for the lease duration). The job is missed. For truly exactly-once semantics, the job must record its completion in the same transaction that marks the tick as done, and the job's logic must be idempotent with a rollback path if the transaction fails. The pattern in this section gives you at-most-once semantics per tick, which is correct for many scheduled tasks but not for all.

**Decision tree for interview use.** When asked "how do you ensure a scheduled job runs exactly once across a cluster," walk through the decision tree: (1) does the job need to run on a schedule or on demand? (2) is at-most-once acceptable or must you guarantee at-least-once? (3) is the job idempotent? The answers determine whether you need a distributed cron (schedule), a task queue with a deduplication key (at-least-once idempotent), or a singleton worker with crash recovery (exactly-once with state machine).

### Senior @ FAANG: Patterns as Platform Primitives

**ADR: distributed cron vs. workflow engine.** At a certain complexity level, a workflow engine (Temporal, Cadence, AWS Step Functions) replaces the distributed cron pattern. The threshold is: when your scheduled job has conditional logic, retries with backoff, parallel steps, or human-approval gates, a workflow engine provides these primitives without requiring you to implement them on top of etcd. The ADR should evaluate: what is the complexity of the job's control flow? How important is visibility into job execution state? What is the operational cost of running a workflow engine cluster vs. implementing the pattern with etcd? At FAANG scale, workflow engines are almost always worth the operational cost for complex multi-step jobs.

**Governance: singleton worker failure documentation.** Every singleton worker must have documented behavior for the period when the singleton role is vacant: between the leader crashing and the next candidate winning the election (up to `ttlSeconds`). Acceptable behaviors include: enqueue work for later processing (durable queue), serve cached state from the last known leader, return a degraded response code to clients, or silently skip the work (acceptable for best-effort jobs). Unacceptable behavior: crash the entire service, fail loudly in a way that causes cascading failures in dependent services. Staff engineers review this documentation for every singleton worker their team owns.

**Platform thinking: the etcd dependency graph.** Every service that uses etcd for leader election or distributed locking is directly dependent on etcd availability. Mapping this dependency graph is essential for understanding the blast radius of an etcd outage. If five critical services all use etcd for singleton election, an etcd outage causes all five to lose their singleton workers simultaneously. Platform engineers who own etcd must communicate its SLA to every dependent team, and dependent teams must design their fallback behavior assuming etcd is unavailable for the SLA's stated maximum outage window.

**L6/L7 concern: the cost of consensus in a hot path.** The distributed cron pattern in this section runs a CAS transaction against etcd for every cron tick. For a cron job that runs every 10 seconds, this is six CAS operations per minute, which is negligible. For a pattern that runs a CAS for every incoming request (e.g., "check if a feature flag is enabled using etcd"), the etcd write latency (1-10ms) becomes a per-request overhead that can double your service's p99 latency. Staff engineers identify these patterns in code review and propose alternatives: cache the etcd value locally with a TTL-based refresh, use a watch to maintain an in-memory copy, or redesign the flag system to not require per-request consensus. The rule: consensus is a background coordination primitive, not a per-request operation.

---
