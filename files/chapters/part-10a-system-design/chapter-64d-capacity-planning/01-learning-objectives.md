## Learning Objectives

By the end of this chapter, you will be able to:

- Explain why capacity planning matters for system design interviews and production engineering
- Recall and apply the standard latency and throughput numbers from memory
- Estimate traffic, storage, bandwidth, and server requirements for any system using a structured framework
- Walk through complete capacity estimates for Twitter, Instagram, YouTube, and Uber
- Produce fully worked estimates for URL shorteners, notification systems, and video streaming platforms
- Apply production capacity planning techniques including load testing, headroom targets, and auto-scaling limits
- Write Go-based load testers and capacity monitoring tooling
- Use the interview cheat sheet to structure estimates efficiently under time pressure
- Avoid the most common capacity planning mistakes that derail system design interviews and cause production outages

### Junior → FAANG: Using Learning Objectives as an Interview Preparation Checklist

Each objective in this list maps to a question type that appears in FAANG system design interviews. The gap most junior engineers have is not in knowing that capacity planning exists: it is in being able to execute it fluently under time pressure without notes.

**Gap 1: Treating numbers as something to look up.** If you have to pause during an interview to remember whether a smartphone photo is 100 KB or 3 MB, you lose momentum and signal uncertainty. The storage size table and latency table in this chapter must be internalized, not referenced. Spend one week writing the key numbers from memory every morning until they are automatic.

**Gap 2: Not knowing what "structured framework" means in practice.** "Use a structured framework" sounds obvious until you are in an interview and jump straight from DAU to architecture. The five-step sequence (clarify, traffic, storage, bandwidth, servers) is not a suggestion: it is the expected narrative structure for a system design interview at L4 and above. Practice running through it on paper for five different systems before your interview.

**Gap 3: Conflating estimation accuracy with estimation fluency.** Being off by 2x on a storage estimate is acceptable. Spending five minutes on arithmetic is not. Practice with round numbers and approximations: 86,400 seconds becomes 100,000, 3 MB photos become "a few MB." Interviewers reward structured reasoning, not arithmetic precision.

**First-job habit:** After any on-call incident involving capacity (high CPU, OOM, disk full), write a one-paragraph post-mortem that answers: what was the actual usage at the time of failure, what was our expected capacity, and when did growth make failure inevitable? This habit builds the intuition that turns textbook capacity planning into real engineering judgment.

**Interview entry point:** "Our service has 100M DAU. Walk me through a capacity estimate." This prompt appears verbatim in Google and Meta L4/L5 loops. The expected response runs through traffic estimation in under 90 seconds, produces storage and bandwidth numbers, then sizes servers. If you need more than three minutes for that sequence, you need more practice.

### Senior @ FAANG: Owning Capacity Planning as a Platform Responsibility

At senior level, the learning objectives in this list describe the minimum competency for every engineer on your team, not just you. Your job is to build systems and processes that ensure the team can execute capacity planning continuously, not just at the time of a design interview.

**Translating objectives into operational practice:**

"Recall and apply the standard latency and throughput numbers from memory" means your team's design documents use these numbers as reference anchors, not vague language like "fast" or "high throughput." A staff engineer establishes the convention: performance budgets in design documents are expressed in absolute numbers (p99 < 50ms, throughput target 20K RPS) with explicit references to the hardware profile that supports the estimate.

"Produce fully worked estimates for URL shorteners, notification systems, and video streaming platforms" means your team has a library of worked estimates for your own systems, not just textbook examples. A senior engineer documents the actual measured capacity of each service tier: how many RPS each application server handles at 70% CPU, how many QPS each database instance handles before p99 latency exceeds the SLA, what the cache hit rate is in production versus the estimate used during design. This library becomes the reference for the next design review.

"Apply production capacity planning techniques including load testing, headroom targets, and auto-scaling limits" means your team runs load tests quarterly against production-equivalent environments, not just at launch. Capacity decays as data grows, index cardinality increases, and access patterns shift. A senior engineer schedules quarterly load test reviews and drives the action items when baselines drift.

**ADR: when to auto-scale versus pre-provision.** Auto-scaling solves unpredictable spikes but introduces cold-start latency (2-5 minutes for new EC2 instances). For services with sharp traffic ramps (ticket sales, product launches), pre-provisioning during the pre-event window is lower risk. An ADR for your scaling strategy must specify: what is the acceptable cold-start latency, what is the expected ramp rate, and which tier (application servers, database read replicas, cache) cannot be auto-scaled in real-time and therefore requires manual pre-provisioning?

**Governance: capacity planning as a release gate.** A mature engineering organization treats capacity planning as a pre-launch gate, not a post-launch concern. The release checklist for any new feature that changes traffic or storage patterns should include: updated traffic estimate, load test result against staging at expected peak RPS, and a confirmation that existing capacity can absorb the new load with target headroom. A staff engineer writes and enforces this checklist.

**L6/L7 concern: capacity planning for shared infrastructure.** When your team's services run on shared infrastructure (shared Kafka cluster, shared database tier, shared Redis cluster), your capacity planning must account for noisy-neighbor effects. A service that unexpectedly doubles its Kafka consumer group lag can delay all other consumers on shared partitions. Staff engineers own the capacity allocation model for shared resources: each team is allocated a RPS/bandwidth/storage quota, over-quota traffic is throttled or deprioritized, and quota increases require a capacity review.

**Maturity model for capacity planning practice.** Level 1: estimates exist only in design documents and are never revisited. Level 2: load tests run at launch but not afterward. Level 3: quarterly load tests with documented baselines. Level 4: real-time capacity dashboards with automated runway alerts, pre-provisioning runbooks for known high-traffic events, and post-incident capacity reviews that update estimates based on observed behavior. A staff engineer drives the team from level 2 to level 4.

---
