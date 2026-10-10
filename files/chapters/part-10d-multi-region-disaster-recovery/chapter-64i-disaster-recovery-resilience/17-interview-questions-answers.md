## Interview Questions

**Q1: How do you design a system to achieve RPO = 0 (zero data loss)?**

**What FAANG expects:** Synchronous replication (`synchronous_commit=remote_apply` in Postgres, equivalent in Aurora/Spanner). Every write pays cross-region RTT. The hard question: what do you do when the sync replica is down, block writes (100% availability loss) or degrade to async (RPO > 0)? This is a business decision, not a technical one. Bonus for knowing that Spanner achieves zero-RPO by design (Paxos quorum per write) and that most systems claiming zero-RPO actually have "near-zero" under streaming replication.

**Answer:** RPO = 0 requires synchronous replication: every write must be committed on at least one replica before the primary acknowledges success to the client. In PostgreSQL, this is `synchronous_commit = remote_apply`. The trade-off is write latency increases by the cross-region RTT (typically 60-120ms for inter-continental). For most FAANG payment systems, this is acceptable because the alternative is financial loss from data discrepancy. Synchronous replication also requires careful handling of replica failures - if the sync replica goes down, you must decide whether to allow writes to continue asynchronously (RPO > 0) or block writes (100% availability loss). The answer is a business decision encoded in your SLA contract.

**Q2: Your chaos experiment shows the circuit breaker opens but the downstream service recovers in 2 seconds. However, the breaker stays open for 30 seconds. How do you tune it?**

A: Reduce the `Timeout` in CircuitBreakerConfig from 30s to something like 5-10s to match the observed recovery time. Also reduce `SuccessThreshold` to 1 or 2 in half-open state since you have evidence the service recovers quickly. The key insight is that circuit breaker parameters must be calibrated from production data - specifically the p99 of downstream recovery time. Don't set them theoretically. Additionally, instrument the number of ErrCircuitOpen responses and alert when it's non-zero - a breaker that opens should always be investigated.

**Q3: Describe the difference between a circuit breaker and a bulkhead. When do you need both?**

A: A circuit breaker detects downstream failure and stops sending requests until recovery. It's about *fault propagation prevention*. A bulkhead limits concurrent resource consumption so one consumer can't starve others. It's about *resource isolation*. You need both when: (a) you have multiple downstream dependencies that share a thread pool or connection pool, where bulkheads prevent one slow downstream from consuming all connections, and (b) you have a downstream that can fail in a way that causes your service to block, where circuit breakers prevent those blocked calls from accumulating. In practice, always pair them. Bulkhead first (to limit concurrency), circuit breaker second (to detect failures and fast-fail).

**Q4: A DR test shows your RTO is 45 minutes but your SLA says 15 minutes. What do you do?**

A: First, instrument the DR test with fine-grained timing to identify which step is consuming the most time. Common culprits: (a) DNS propagation (use lower TTLs of 60s in DR readiness, not default 300s), (b) replica promotion (pre-warm standbys with connection pools open), (c) health check consensus (too many consecutive checks required before failover trigger), (d) service startup - standbys should already be running in warm-standby mode, not cold. Then fix the highest-impact bottleneck, re-run the DR test, and iterate. Also question whether the 15-minute RTO is realistic for your architecture - it may require re-architecting toward active-active rather than active-passive.

**Q5: How do you prevent split-brain in an automated failover system?**

**What FAANG expects:** Three layered mitigations: STONITH (forcibly kill old primary), fencing tokens (storage rejects stale writes), quorum/consensus-backed leader lease (etcd/Consul/ZK). Understand the trade-off: automated failover can cause split-brain. manual failover cannot but costs RTO. Bonus for recognizing that AWS RDS Multi-AZ uses a combination (DNS-based DNS cutover + persistent storage layer that only one instance can attach to).

**Answer:** Split-brain occurs when both primary and promoted standby accept writes simultaneously, causing data divergence. Prevention strategies: (1) **STONITH (Shoot The Other Node In The Head)**: before promoting standby, send a command to forcibly terminate the primary. If STONITH fails, abort the failover. (2) **Fencing tokens**: each region has a monotonically increasing token. The token is checked on every write - a lower token means the region is demoted and writes are rejected. (3) **Quorum/consensus**: use a distributed coordination service (etcd, Consul, ZooKeeper) where the primary must hold a lock. If it can't renew the lock (e.g., due to network partition), it self-demotes. Only one region can hold the lock. In Go, this is implemented via etcd's lease mechanism with a background goroutine that continuously renews the lease.

**Q6: What is a "blameless" postmortem and why is it hard to do in practice?**

A: A blameless postmortem concludes that incidents are caused by systemic failures - inadequate tooling, missing safeguards, incomplete processes, knowledge gaps - not by individual mistakes. In practice it's hard because: (a) management culture often seeks a scapegoat, (b) engineers self-censor near-misses to avoid blame, and (c) the language "engineer X made a mistake" is easier than "the deployment process allowed X to happen without validation." True blameless culture requires leadership to explicitly praise engineers who document near-misses, to track action items from postmortems as engineering investment (not tech debt), and to measure postmortem quality (number of contributing factors identified, number of action items completed on time) rather than postmortem volume.

**Q7: How do you measure RPO in a real DR test?**

A: RPO measurement requires: (1) Record the timestamp of the last write that was confirmed to the client before the simulated disaster. (2) After recovery, query the restored system for the most recent record. (3) RPO = timestamp_of_disaster - timestamp_of_most_recent_recovered_record. In practice this requires injecting test writes with known timestamps at regular intervals (e.g., every 30 seconds) during the test window, then querying for the most recent recovered write after promotion. The gap is your measured RPO. Automate this measurement in your DR test pipeline - manual RPO measurement is error-prone.

**Q8: Describe how WAL shipping achieves near-zero RPO without synchronous replication.**

A: PostgreSQL's WAL (Write-Ahead Log) records every change before it's applied. WAL archiving continuously ships WAL segment files to a standby. With streaming replication, WAL bytes are forwarded in real-time (not as complete segments), reducing the lag to milliseconds in a healthy network. RPO = amount of WAL generated in the worst case network gap. For streaming replication: if a network partition lasts 10 seconds and the database generates 5MB of WAL per second, RPO ≈ 10 seconds. This is not zero, but it's near-zero. For true RPO = 0, you need `synchronous_commit = remote_apply`, which makes every write synchronous.

---

### Junior -> FAANG: Practicing the Q&A Format for Reliability Interviews

These eight questions cover the full range of DR topics tested at FAANG from L4 to L6. For each question, practice giving the answer in under 3 minutes. Interviewers at FAANG typically allow 5-7 minutes per question, but candidates who need more than 3 minutes for a direct question usually indicate uncertainty.

Questions 1 and 5 (zero RPO and split-brain prevention) are the highest-frequency topics. They appear in virtually every senior reliability or system design screen. Q1 requires understanding the synchronous replication trade-off clearly and being able to name the "block writes vs. degrade to async" decision point as a business decision. Q5 requires knowing all three mitigation layers (STONITH, fencing tokens, consensus) and being able to explain why any single one alone is insufficient.

For Q4 (45-minute RTO against a 15-minute SLA), practice the diagnosis process: identify the bottleneck, fix the bottleneck, re-measure, iterate. The interview validates whether you approach operational problems systematically (measure first, fix second) or intuitively (guess and try). Always measure before proposing a solution.

### Senior @ FAANG: Bar-Raiser Calibration for DR Interview Questions

**Q1 at L6/L7 level.** An L6 answer explains the synchronous replication trade-off and names the business decision about write blocking. An L7 answer goes further: explain that Spanner achieves zero-RPO by design because Paxos quorum writes are synchronous by definition, and discuss why most "zero-RPO" systems actually have "near-zero RPO" because network partitions between synchronous replicas require a write-blocking mode that most teams avoid. The bar raiser asks: "What is your policy when the synchronous replica is down?" The expected answer is: "This is encoded in the SLA contract as a business decision, not left to engineering judgment at incident time."

**Q2 at L6/L7 level.** The L5 answer calibrates the timeout to match downstream recovery. The L6 answer adds: "calibrate from the P99 of downstream recovery time measured over the last 90 days, not from a single chaos experiment. Recovery time distributions are heavy-tailed, so a single measurement may underestimate the true P99." The L7 answer adds: "document the calibration rationale in the ADR alongside the circuit breaker configuration so future engineers understand why the timeout is set to 10 seconds and not 5 or 30."

**Q5 at L6/L7 level.** The three-layer answer (STONITH, fencing tokens, consensus) is the L5 level. The L6 bar is: explain the order in which these layers are applied and why STONITH must complete before the standby is promoted. If STONITH fails (old primary is unreachable), do you abort the failover or proceed? The business-safe answer is to abort and page the human operator, because proceeding without STONITH success risks split-brain. The L7 bar adds: describe how AWS RDS Multi-AZ solves this with the storage layer as the exclusive resource, effectively providing automatic STONITH through the EBS attachment model.

**Q7 at L6/L7 level.** The RPO measurement procedure (record last confirmed write, query most recent recovered record, compute gap) is L5. The L6 bar is: explain the precision requirements for the test write timestamps. If your write timestamps have 1-second precision, you cannot measure RPO below 1 second. For a system with sub-second RPO target, you need microsecond-precision timestamps in test writes and the recovery verification query. The L7 bar: explain how you automate this measurement in the DR testing pipeline so it runs after every DR test and produces a time series of measured RPO values that can be trended.
