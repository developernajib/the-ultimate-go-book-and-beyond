## Interview Questions

**Q1: Explain CAP theorem and give examples of when you'd choose CP vs AP.**

**What FAANG expects:** The real choice is "during a partition, sacrifice consistency or availability". Partition tolerance is not optional. Give concrete system examples for each side. Bonus for knowing PACELC (covered in Q2) because CAP alone misses the normal-operation latency trade-off.

**Answer:** CAP theorem states a distributed system can guarantee only two of: Consistency (every read returns the latest write), Availability (every request gets a response), and Partition Tolerance (system works despite network partitions). Since partitions always happen, the real choice is: during a partition, sacrifice consistency (AP) or availability (CP)?

Choose CP when incorrect answers are dangerous: bank account balances (double-spend), distributed lock/leader election (split-brain), inventory management for last-available items. Systems: etcd, CockroachDB, ZooKeeper.

Choose AP when availability matters more than perfect consistency: social media like counts, view counters, user activity metrics, product catalog. Systems: Cassandra, DynamoDB (default), CouchDB.

---

**Q2: What is PACELC and why is it more useful than CAP in practice?**

A: PACELC extends CAP: "if Partition → choose Availability or Consistency. Else (normal operation) → choose Latency or Consistency." CAP only describes partition behavior but most of the time systems aren't partitioned. PACELC captures the more common trade-off: a quorum read gives stronger consistency but adds latency even when the cluster is fully healthy. DynamoDB is PA/EL (available during partition, low latency normally). CockroachDB is PC/EC (consistent during partition, higher latency normally). This forces architects to think about normal operation trade-offs, not just failure scenarios.

---

**Q3: How do you debug a distributed system failure? What tools and techniques do you use?**

A: Four-phase approach:
1. **Identify scope**: which services are affected? Use distributed tracing (Jaeger/Tempo) to find failure trace IDs. Look for: elevated error rates, increased latency, specific endpoints affected.
2. **Reconstruct timeline**: query all logs for affected trace IDs across services. Sort by HLC or logical timestamp (not wall clock). Build a service dependency graph for the failed transaction.
3. **Find root cause**: look for the first service in the chain with errors. Was it timeouts, errors, or slow responses? Check resource metrics (CPU, memory, DB connection pool, goroutine count) at the time of failure.
4. **Verify hypothesis**: can you reproduce in staging? Does a fix resolve the issue without side effects?

Go-specific tools: pprof for CPU/memory/goroutine analysis, OpenTelemetry for distributed tracing, structured logs with correlation IDs, `go tool trace` for goroutine scheduling visualization.

---

**Q4: Why is time.Now() dangerous in distributed systems? What should you use instead?**

**What FAANG expects:** NTP sync is not tight enough for causal ordering (seconds of drift, backward jumps during corrections). Use HLC (CockroachDB, YugabyteDB) or Spanner's TrueTime (±4-7ms uncertainty + commit wait). Bonus for naming the exact failure mode: two nodes disagree on "who wrote last" for concurrent events, causing lost updates under LWW.

**Answer:** `time.Now()` reads the local system clock, which can: (1) differ across nodes by up to seconds even with NTP, (2) jump backward during NTP corrections, (3) drift at different rates. Using wall clock for event ordering means: Event A (node1, clock 10:00:05) appears to happen AFTER Event B (node2, clock 10:00:04) even if B causally followed A.

Use Hybrid Logical Clocks (HLC): combines physical time (human-readable, approximately correct) with a logical counter (for events at the same physical time). HLC guarantees: if A happened before B, then HLC(A) < HLC(B). This provides causal ordering without requiring perfectly synchronized clocks. Used by CockroachDB, YugabyteDB. In Go: implement HLC with `sync.Mutex`, `max(physical_now, prev_wall)`, and an incrementing logical counter.

---

**Q5: What is a distributed monolith and how do you fix it?**

A: A distributed monolith looks like microservices (separate deployable units) but is functionally monolithic: services can only be deployed together, share databases, have tight synchronous coupling where one service's downtime causes cascading failures across others.

Signs: "We must deploy A, B, C together for any change." All services share a single DB schema. Failure of one service causes 100% error rate in callers. No service can operate independently.

Fix: (1) identify which synchronous calls can be made async - replace with event publishing. (2) define API contracts (OpenAPI + AsyncAPI) that allow independent deployment. (3) apply the strangler fig pattern - add async event layer alongside synchronous calls, migrate consumers gradually. (4) introduce DB per service with eventual consistency for non-critical cross-service reads.

---

**Q6: How do cascading failures happen and how do you prevent them?**

A: Cascading failure mechanism: Service A gets slow → Service B's goroutines pile up waiting for A → B's memory grows → B OOMs or exhausts connection pool → Service C's calls to B all fail → C error rate hits 100%.

Prevention:
1. **Timeout budgets**: each call has a decreasing timeout: user allows 10s, so auth gets 2s, order service gets 7s, payment gets 5s. Never give downstream MORE time than your caller gave you.
2. **Circuit breakers**: after N% failure rate, stop calling the downstream and fail fast. This prevents goroutine accumulation waiting for a broken service.
3. **Bulkheads**: separate thread/goroutine pools per downstream dependency. If payment processing is slow, it doesn't exhaust the pool for auth calls.
4. **Load shedding**: when queue depth exceeds threshold, drop new requests rather than accepting work you can't process.

---

**Q7: How would you implement a distributed lock in Go?**

A: Use etcd or Redis with a TTL-based lease:

```go
package interviews

import (
	"context"

	clientv3 "go.etcd.io/etcd/client/v3"
	"go.etcd.io/etcd/client/v3/concurrency"
)

// AcquireEtcdLock acquires a distributed lock via etcd with a 30-second lease.
func AcquireEtcdLock(ctx context.Context, client *clientv3.Client) error {
	session, err := concurrency.NewSession(client, concurrency.WithTTL(30))
	if err != nil {
		return err
	}
	defer session.Close()

	mutex := concurrency.NewMutex(session, "/locks/payment-processor")
	if err := mutex.Lock(ctx); err != nil {
		return err // Can't acquire lock - either taken or etcd unavailable
	}
	defer mutex.Unlock(ctx)
	return nil
}
```

Key requirements: (1) TTL on the lock (auto-release if holder dies), and (2) fencing tokens (monotonically increasing - reject operations from stale lock holders). (3) prefer CP system (etcd > Redis for lock correctness - Redis is eventually consistent by default). (4) lock release must be atomic with fencing token validation.

Common mistake: using Redis `SET NX EX` without fencing tokens - a slow holder can release a lock that was already taken by someone else.

---

**Q8: What is the thundering herd problem and how do you prevent it?**

A: Thundering herd occurs when many concurrent clients simultaneously need to fetch the same data (e.g., cache miss after cache expiry), overwhelming the backend.

Prevention strategies:
1. **Singleflight**: `golang.org/x/sync/singleflight` - only one goroutine fetches data. All other concurrent requests wait and share the result. Best for point lookups.
2. **Jittered cache warming**: on startup, each instance waits a random delay before warming caches. Prevents N instances all hitting DB simultaneously.
3. **Probabilistic early expiration (PER)**: as cache TTL approaches expiry, increase probability of background refresh. Prevents simultaneous expiry of popular keys.
4. **Circuit breaker on cache miss rate**: if cache miss rate spikes (indicating mass expiry), open circuit breaker and serve stale data rather than thundering to the DB.

---

**Q9: What lessons should Go engineers take from the Facebook 2021 BGP outage?**

A: Three critical lessons:
1. **Out-of-band management plane**: if your management tooling (SSH, monitoring, alerting, VPN) runs on the same infrastructure you're managing, you lose the ability to fix problems. Management plane must be on independent network/cloud.
2. **IP-based bootstrap configuration**: if DNS is unavailable (as it was for Facebook because their name servers lost BGP routes), services need to know where to connect using IP addresses. Use IP addresses for critical bootstrap connections (etcd, DB primary), and use DNS only after bootstrap.
3. **Staged rollout for all infrastructure changes**: BGP changes should apply to 1 router, validate, then 10%, then all. Never apply configuration changes to all infrastructure simultaneously.

---

**Q10: What is the difference between a network partition and a slow network in terms of system behavior?**

A: From CAP theorem's perspective, a partition means some or all messages are dropped - network is cut. In practice, distinguishing between "partitioned" and "slow" is hard (and the timeout determines which it looks like to the system).

Behavioral differences:
- **Partition**: requests fail fast or timeout. New requests can be handled independently
- **Slow network**: requests succeed but slowly. Pending requests accumulate, consuming goroutines, memory, and connection pool slots
- **From the system's perspective**: a sufficiently slow network looks like a partition after the timeout fires

Why this matters for Go: slow network is often worse than a partition, because slow calls accumulate goroutines and exhaust connection pools, whereas failed calls (partition) trigger error handling quickly. Always set timeouts. Consider the circuit breaker's "slow call threshold" in addition to "failure threshold."

---

**Q11: How do you handle distributed transactions in a microservices architecture?**

**What FAANG expects:** 2PC is rejected (blocking, coordinator SPOF). Sagas with compensations + outbox + idempotency-keyed consumers are the 2026 default. Recognize that "single service owns the data" is often the right answer, microservice boundaries should follow transaction boundaries. Bonus for naming Temporal as the orchestration layer for non-trivial sagas.

**Answer:** Two-phase commit (2PC) is the traditional answer but is problematic in microservices: it's blocking, creates long-lived locks, and the coordinator becomes a single point of failure.

Better alternatives:
1. **Saga pattern**: decompose transaction into a sequence of local transactions, each publishing an event. On failure, execute compensating transactions (undo each step in reverse). Example: PlaceOrder saga: ReserveInventory → ChargePayment → CreateShipment. If ChargePayment fails, run CancelInventoryReservation.
2. **Outbox pattern + eventual consistency**: write business record + event atomically. Consumer processes event in their own transaction. Eventual consistency.
3. **Single service owns the data**: if operations need to be atomic, put them in one service with one database. Microservices boundaries should be drawn at transaction boundaries.

In Go: implement sagas with state machine + outbox. Each saga step is idempotent (safe to retry). On timeout, the saga coordinator runs compensations.

---

**Q12: What are the signs of a distributed monolith?**

A: Six warning signs:
1. Deployment dependencies: "We can't deploy Service A without also deploying B and C"
2. Shared database: multiple services write to the same DB schema/tables
3. Synchronous chains: user request triggers A→B→C→D all synchronously - any one failure cascades to total failure
4. No independent testing: services can't be integration-tested without spinning up 5 other services
5. Schema migration coordination: DB changes require downtime coordination across teams
6. Shared libraries with business logic: all services import a central library containing business rules, creating implicit coupling

How to fix: introduce event-driven communication (Kafka/NATS), define API contracts that allow independent deployment, apply strangler fig pattern to gradually decouple, give each service its own database.

---

**Q13: How does consistent hashing work and why is it used for distributed data?**

**What FAANG expects:** Map nodes and keys to a ring, keys go to next node clockwise. Adding a node moves K/N keys (vs all K with modulo). Virtual nodes for better distribution and heterogeneous-capacity support. Bonus for knowing alternatives: jump-consistent-hash (Google, zero memory, no vnodes), rendezvous/HRW (best distribution, O(N) lookup), and the fact that Envoy uses Maglev for bounded memory.

**Answer:** Regular modulo hashing `hash(key) % N` causes N remappings when a node is added or removed, requiring mass data migration. Consistent hashing maps both nodes and keys onto a ring (0 to 2^32). A key is owned by the first node clockwise from the key's position. When a node is added, only the keys between the new node and its predecessor need migration - on average `K/N` keys move, not all K keys.

Virtual nodes (vnodes): each physical node has V virtual positions on the ring. Benefits: more even load distribution (statistical smoothing), easier handling of heterogeneous nodes (faster nodes get more vnodes). Used by: DynamoDB, Cassandra, Riak, Envoy for consistent routing.

Go implementation: sort a `[]uint32` of virtual node hashes, use `sort.Search` for O(log n) lookup.

---

**Q14: What is a fencing token and when do you need it?**

A: A fencing token is a monotonically increasing number issued by a lock service when a lock is granted. Resources use the token to reject operations from stale lock holders.

Scenario without fencing: Process A holds a distributed lock (TTL 30s). GC pause causes A to pause for 35s. Lock expires, Process B acquires the lock. A resumes from GC pause, still thinks it holds the lock, writes to shared resource. B also writes to shared resource. Split-brain: two writers.

With fencing: Lock service issues token=10 to A, token=11 to B. Resource tracks highest-seen token. A tries to write with token=10, resource has seen token=11 → rejected. B writes with token=11 → accepted. Fencing prevents stale lock holder from writing.

```go
package interviews

import "errors"

var ErrStaleLockToken = errors.New("stale lock token")

type Resource struct {
	highestToken int64
}

func (r *Resource) Write(token int64, data []byte) error {
	// Resource check
	if token < r.highestToken {
		return ErrStaleLockToken
	}
	r.highestToken = token
	_ = data
	// Proceed with write
	return nil
}
```

---

**Q15: How would you design a service that must work correctly during a network partition?**

A: Five-step design process:
1. **Classify data by consistency requirement**: financial (CP), user preferences (AP-friendly), counters (CRDTs for AP).
2. **Choose appropriate storage**: CP data in CockroachDB/etcd. AP data in Cassandra/DynamoDB with eventual consistency.
3. **Define partition behavior explicitly**: during partition, do we: return stale data? Return error? Accept writes for later reconciliation?
4. **Implement conflict resolution**: for AP systems, how are concurrent writes to same key resolved? LWW (last-write-wins with HLC), CRDTs (counters, sets, registers), or merge functions?
5. **Test with network partitions**: use tc netem or chaos tools to inject partitions and verify the documented behavior is what actually happens.

---

**Q16: What is the difference between at-most-once, at-least-once, and exactly-once delivery?**

A: Delivery semantics for distributed messaging:
- **At-most-once**: fire and forget. Message may be lost (e.g., UDP, unacknowledged Kafka producer). No retries.
- **At-least-once**: producer retries until acknowledged. Message may be delivered multiple times. Consumer must be idempotent. Most common in practice (Kafka default consumer groups, webhook delivery with retry).
- **Exactly-once**: each message processed exactly once. Achieved via: idempotent producers (Kafka) + transactional consumers, or idempotency keys with deduplication store. "Exactly-once processing" is the end-to-end guarantee - you need idempotent consumers even with at-least-once delivery.

In Go: at-least-once is the practical target. Implement idempotency on the consumer side: check `processed_events` table before processing, wrap processing and mark-processed in one transaction.

---

**Q17: What is backpressure and how do you implement it in Go?**

A: Backpressure is the signal propagated upstream when a downstream stage can't keep up with input rate. Without it, queues fill and cause OOM.

Go implementation: use bounded channels - when the channel is full, the sender blocks (or returns an error for non-blocking case). This is natural backpressure: the channel buffer absorbs bursts, and when it's full, the producer slows down or drops.

```go
package interviews

import (
	"context"
	"errors"
)

var ErrQueueFull = errors.New("queue full")

type Job struct {
	ID string
}

func EnqueueJob(ctx context.Context, jobs chan<- Job, job Job) error {
	// Producer respects backpressure:
	select {
	case jobs <- job:
		// Accepted
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		// Non-blocking: reject if full, propagate pressure to caller
		return ErrQueueFull
	}
}
```

HTTP/2 has built-in flow control (window size limits) for backpressure. gRPC inherits this. For Kafka: consumer lag is the backpressure signal, and the producer should reduce rate when consumer lag exceeds threshold.

---

**Q18: How do you prevent the thundering herd problem in Go services?**

A: Four complementary strategies:

1. **singleflight**: `group.Do(key, func)` - only one in-flight fetch per key. All concurrent callers for same key share one result.
2. **Jitter on cache TTL**: instead of `TTL=5min`, use `TTL=5min + rand(30s)`. Prevents all keys from expiring simultaneously.
3. **Probabilistic early refresh**: as TTL approaches 0, background refresh probability increases. `p = exp(-beta * remaining_ttl / max_ttl)`.
4. **Request coalescing in load balancer**: at the load balancer layer (Nginx, Envoy), coalesce duplicate requests for the same uncached resource.

Most Go services should at minimum use singleflight for all cache-miss paths to their data stores.

---

**Q19: What does the Amazon Dynamo paper teach us about building distributed data systems?**

A: Five foundational lessons still relevant today:
1. **Always-on availability through AP design**: by accepting eventual consistency, you enable higher availability. The user can always write their shopping cart even during a partition.
2. **Consistent hashing for horizontal scaling**: add/remove nodes with minimal data movement. N+1 nodes = only 1/N keys need to move.
3. **Quorum for tunable consistency**: N=3, W+R>N guarantees latest read. Tune W and R based on consistency vs availability trade-off per operation.
4. **Gossip protocol for membership**: nodes discover each other and propagate state changes via gossip - no central coordinator.
5. **Anti-entropy via Merkle trees**: efficiently detect which data is out of sync between replicas without transferring all data.

CRDTs (added after Dynamo): conflict-free replicated data types allow certain data types (counters, sets, registers) to be merged automatically without conflict resolution logic.

---

**Q20: What should every engineer know about distributed system failures before shipping to production?**

A: Ten hard lessons:
1. **Networks fail in ways you haven't tested**: partitions, slowdowns, asymmetric failures (A can reach B, B can't reach A). Test them all.
2. **Clocks lie**: wall clocks on different machines are not synchronized enough for distributed event ordering. Use HLC or logical clocks.
3. **At-most-once delivery is often a lie**: retries happen. Make your consumers idempotent.
4. **Your management plane must be independent of your data plane**: you need to be able to reach your servers when they're broken.
5. **Staged rollouts save lives**: never apply infrastructure changes to all nodes simultaneously.
6. **Cascades happen from unexpected directions**: the slow DB query you've had for 6 months becomes catastrophic when request rate doubles.
7. **Timeouts must cascade**: each downstream gets less time than the upstream gives you.
8. **Circuit breakers prevent cascade amplification**: fail fast when downstream is broken.
9. **CAP is about behavior during partition, PACELC is about normal operation**: design for both.
10. **Document partition behavior before you need it**: figure out what your service should do during failures in a calm design meeting, not during a 3am incident.

### Junior → FAANG: Interview Preparation Strategy for Distributed Systems Questions

The 20 questions in this section cover the core distributed systems curriculum for FAANG L4/L5 interviews. Rather than memorizing answers, organize your preparation around four themes: consistency models (Q1, Q2, Q11, Q15, Q16), failure patterns (Q6, Q7, Q8, Q10, Q14), debugging and observability (Q3, Q4), and architecture design (Q5, Q12, Q13, Q17, Q18, Q19).

The most common failure in distributed systems interviews is giving a technically correct but shallow answer. Q1 on CAP theorem is a good example: stating that "network partitions always happen so you choose between C and A" is correct but not differentiating. The differentiating answer adds a concrete example, names the business consequence, and mentions PACELC as the extension that covers normal operation. Depth of application, not breadth of recall, is what earns higher scores.

For Q11 on distributed transactions: the answer that mentions saga patterns and outbox earns partial credit. The answer that explains why 2PC is rejected at FAANG scale (blocking protocol, coordinator SPOF, lock duration incompatible with microservices independence) earns full credit. Always explain the why behind the design choice.

Practice talking through these questions out loud, timing yourself to two minutes per question. Written preparation feels very different from spoken explanation, and interviews are spoken.

### Senior @ FAANG: Bar-Raiser Signals in Distributed Systems Interview Loops

For L6 and L7 system design interviews, the 20 questions in this section represent baseline competence, not bar-raiser signals. Every L6 candidate can answer all 20 questions. The differentiation comes from how candidates reason about questions they have not encountered before, how they handle ambiguity and incomplete requirements, and whether they spontaneously introduce governance and platform thinking without being prompted.

**From technical answers to organizational answers.** An L6 bar-raiser signal on Q5 (distributed monolith) is not the technical description of strangler fig pattern: it is the observation that distributed monoliths persist because team boundaries and service boundaries diverged, and that the fix requires organizational alignment (who owns the shared database, who defines the service contract, who has authority to break the coupling) in addition to the technical migration. Candidates who only describe the technical fix are demonstrating L5 thinking.

**From individual correctness to systematic correctness.** An L6 bar-raiser signal on Q3 (debugging) is not describing how to use Jaeger to find a root cause: it is describing how to build a debugging capability that works for the entire team, including the on-call engineer who joined six months ago and has never seen this type of failure. The system includes runbooks, dashboards, trace coverage requirements, and post-mortem-driven improvements. Candidates who describe personal debugging technique are demonstrating L5 thinking.

**From incident prevention to incident prevention at scale.** An L6 bar-raiser signal on Q6 (cascading failures) is not describing circuit breakers: it is describing how to enforce circuit breaker usage across 50 services owned by 10 teams, measure compliance, and use aggregate compliance data to justify platform investment. The answer includes the governance mechanism, the measurement approach, and the incentive structure. Candidates who describe the circuit breaker pattern without addressing adoption at scale are demonstrating L5 thinking.

**Handling novel questions.** Bar-raisers deliberately ask questions that are not in any preparation guide, to test first-principles reasoning. A strong L6 candidate receiving a novel question explicitly narrates their reasoning process: "I haven't thought about this specific scenario before, so let me start with the consistency requirement, identify the partition behavior implications, and then consider the observability gaps this creates." This structured approach to novel problems is more valuable than a polished answer to a rehearsed question.

---
