## 64D.9 Interview Cheat Sheet

### Quick Reference Numbers

System design interviews test your ability to reason from first principles about scale, and having key latency and throughput numbers memorized allows you to make defensible estimates rather than guessing. These numbers should be internalized as order-of-magnitude intuitions: memory access is ~100ns, same-datacenter network is ~0.5ms, and cross-continent is ~150ms. With these anchors, you can estimate whether a design is feasible, identify bottlenecks, and justify technology choices under interview time pressure.

```
LATENCY
────────────────────────────────────────
L1 cache hit:            0.5 ns
L2 cache hit:            7 ns
Main memory access:      100 ns
NVMe SSD read:           100 μs
Same-DC network round:   500 μs
HDD seek:                10 ms
Cross-continent:         150 ms

THROUGHPUT
────────────────────────────────────────
Go HTTP server (no DB):  100K RPS/server
Go HTTP server (w/ DB):  5-20K RPS/server
PostgreSQL (simple QPS): 50K QPS
Redis:                   500K ops/sec
Kafka partition write:   50 MB/s
NVMe IOPS (random 4K):   700K IOPS
HDD IOPS (random):       100 IOPS

STORAGE SIZES
────────────────────────────────────────
Tweet (text):            280 bytes
User profile:            1 KB
Web page (avg):          80 KB
Profile photo:           100 KB
Smartphone photo:        3 MB
Audio (1 min MP3):       1 MB
Video SD (1 min):        10 MB
Video HD (1 min):        50 MB
Video 4K (1 min):        200 MB

CONVERSIONS
────────────────────────────────────────
Seconds per day:         86,400 ≈ 100K
Days per month:          30
Days per year:           365
1 Gbps network:          125 MB/s

POWERS OF 2
────────────────────────────────────────
2^10 = 1K, 2^20 = 1M, 2^30 = 1B, 2^40 = 1T
```

### The Framework for Every System Design Interview

Use this five-step framework in every system design interview. Write these sections on the whiteboard as headers before filling in numbers.

```
1. CLARIFY REQUIREMENTS & SCALE (2 minutes)
   - DAU / MAU
   - Read:Write ratio
   - Data retention
   - SLA requirements

2. TRAFFIC ESTIMATION (3 minutes)
   - Reads per second (average and peak)
   - Writes per second (average and peak)
   - Derived throughput (fan-out, notifications)

3. STORAGE ESTIMATION (3 minutes)
   - Data per item
   - Total items
   - Replication factor
   - Retention period
   - Total storage

4. BANDWIDTH ESTIMATION (2 minutes)
   - Ingress
   - Egress
   - CDN vs. origin split

5. SERVER COUNT (2 minutes)
   - Application servers
   - Database sizing
   - Cache sizing
```

**Example walkthrough (60 seconds, whiteboard-style)**:

"Design Twitter DMs. Starting with scale: assume 200M DAU, each sends 5 messages per day. That's 1B messages per day.

Traffic: 1B / 100K seconds = 10K writes per second. Read ratio probably 3:1, so 30K reads per second. Peak: 3x, so 30K writes, 90K reads.

Storage: average message 1 KB, 1B messages per day, 7-year retention for legal: 1B × 1 KB × 365 × 7 = 2.5 PB raw, ×3 replication = 7.5 PB. Use Cassandra partitioned by (sender_id, recipient_id) for fast conversation loads.

Bandwidth: 30K writes × 1 KB = 30 MB/s ingress. 90K reads × 1 KB = 90 MB/s egress. Manageable.

Servers: 30K writes/sec at 3K writes/server (DB-bound) = 10 write servers. Cache messages for 24 hours to absorb read traffic - 10% DB read-through = 9K reads/second to DB, at 5K reads/server = 2 read servers. Cache the most recent ~2 hours of messages (the hot read set) to absorb read traffic: 1B messages/day × (2/24) × 1 KB ≈ 83 GB of hot messages - one Redis r6g.2xlarge (64 GB) handles most of it with recency-based eviction, spill to a second node if needed."

### Junior → FAANG: Using the Cheat Sheet as a Practice Scaffold

The cheat sheet in this section is not for use during the interview. It is for use during your preparation to verify that you have internalized each number and each framework step. Here is how to use it productively.

**Test yourself before the interview, not during.** Cover each section of the cheat sheet and try to produce the numbers from memory. L1 cache: 0.5 ns. HDD random IOPS: 100. Seconds per day: 86,400, approximate to 100K. If you hesitate on any number, that is the one to drill. The cheat sheet is your gap analysis tool.

**Use the 60-second walkthrough as your interview opening.** The Twitter DM example in this section is a model for how to open any system design interview. The structure is: state the scale assumption, run traffic estimation in two sentences, run storage estimation in two sentences, state the database choice with one justification, and state the server count with one justification. Practice delivering this opening for five different systems until you can do it in under 90 seconds for each. Speed here signals fluency, not recklessness.

**The five-step framework as a whiteboard template.** In every system design interview, write the five headers (Requirements and Scale, Traffic, Storage, Bandwidth, Servers) at the top of the whiteboard or shared document before saying anything. Then fill them in sequentially. This signals organizational discipline and prevents you from skipping steps under pressure. Interviewers who see this structure immediately understand that you know the framework and are applying it deliberately.

**First-job habit:** When your team does a design review for a new system, volunteer to run the estimation section. Use the five-step framework out loud. Getting feedback from experienced engineers on your estimation assumptions (too optimistic on peak multiplier, missing fan-out) in a low-stakes design review is better practice than discovering the gap in an interview.

**Interview entry point:** "Let me anchor the scale before we talk about architecture." This one sentence signals to the interviewer that you are going to do estimation first. It is the single most effective opening move in a system design interview, because it sets the expectation that your architecture will be grounded in numbers, not just pattern-matched from systems you have seen before.

### Senior @ FAANG: The Cheat Sheet as a Shared Team Standard

At senior level, the numbers in this cheat sheet are not personal knowledge: they are the team's shared vocabulary for capacity discussions. A staff engineer's job is to make these numbers part of the team culture.

**Embedding the numbers in team artifacts.** The latency and throughput reference numbers should appear in your team's wiki, capacity planning templates, and design review checklists. When these numbers are embedded in shared documents, engineers naturally use them in design discussions without needing to look them up. A staff engineer ensures the team's reference document stays current (NVMe throughput has improved significantly since 2020) and is linked from every design document template.

**The five-step framework as a design review requirement.** A mature engineering organization requires that every service design review include a completed five-step capacity estimate before the architecture discussion begins. A staff engineer writes the design review template that includes this requirement and enforces it in code review: proposals that lack capacity estimates are returned for completion. This is not bureaucracy: it is a process that prevents capacity-driven outages by ensuring every architecture decision is grounded in actual scale requirements.

**Using the framework to compress decision time in incidents.** During a production incident, time pressure is extreme. A team that has internalized the estimation framework can rapidly assess whether a capacity expansion will solve the problem. "Our current database is at 85% CPU on 50,000 QPS. Adding a read replica will reduce primary load by 50% for read queries. Our read-to-write ratio is 4:1, so primary CPU should drop to approximately 55%, giving us adequate headroom." This reasoning, applied in three minutes, is faster and more reliable than guessing or escalating. A staff engineer trains the team to apply this framework during incident response through tabletop exercises.

**ADR: standardizing the estimation framework across teams.** In a large engineering organization, teams that use inconsistent estimation frameworks produce capacity plans that cannot be compared or aggregated. The platform engineering team that owns shared infrastructure (database clusters, Kafka clusters, CDN) needs to aggregate capacity forecasts from product teams to plan shared resource capacity. If each product team uses a different estimation methodology, aggregation is unreliable. A staff engineer on the platform team drives the standardization of the estimation framework, including standard assumptions (peak multiplier by workload type, replication factor, headroom target), so that aggregated forecasts from product teams can be trusted as inputs to platform capacity planning.

**L6/L7 concern: the cheat sheet numbers as approximations with known error bounds.** The numbers in this cheat sheet are order-of-magnitude estimates, not precise measurements. PostgreSQL at 50K QPS is the ceiling for simple primary key queries on a specific instance type with warm buffer pool. Complex queries, cold buffer pool, or a smaller instance type change the number significantly. A staff engineer using these numbers in a capacity model documents the assumptions: what instance type, what workload type, what cache hit rate, what connection pool size. When production measurements diverge from estimates, the first question is which assumption was wrong, and the assumption documentation makes that analysis tractable. Capacity models without documented assumptions are not engineering artifacts: they are guesses.

---
