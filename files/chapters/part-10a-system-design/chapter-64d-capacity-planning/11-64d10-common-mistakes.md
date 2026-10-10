## Common Mistakes and How to Avoid Them

### Mistake 1: Skipping Estimation Entirely

The most common interview mistake: diving directly into architecture without estimating scale. This signals that you design without understanding the problem. Always anchor your design in numbers, even if they are rough.

**Fix**: Open every system design with the five-section framework. Write the headers first. Commit to numbers before drawing a single box in your architecture diagram.

### Mistake 2: Forgetting the Peak Multiplier

Designing for average traffic means your system fails every day during peak hours. Traffic is not uniform. Use 2-3x multiplier for average systems, 5-10x for event-driven workloads.

**Fix**: Always state "average RPS" and "peak RPS" separately. Design your system to handle peak, not average.

### Mistake 3: Ignoring Replication

Every storage estimate without a replication factor is wrong. Distributed systems replicate for fault tolerance. Always multiply raw storage by 3.

**Fix**: Add "×3 for replication" as the last step in every storage calculation.

### Mistake 4: Confusing Throughput with Capacity

"Our server can handle 10,000 RPS" means it can handle 10,000 RPS before becoming saturated. It does not mean you should run it at 10,000 RPS. Always apply a utilization target (50-70%) to leave headroom.

**Fix**: Use "RPS capacity at 70% utilization" as your sizing denominator, not peak capacity.

### Mistake 5: Ignoring Data Access Patterns

Calculating total data (10 PB) without considering access patterns leads to the wrong database choice. Is it time-series (Cassandra)? Key-value lookups (Redis, DynamoDB)? Complex relational queries (PostgreSQL)? Random access to large blobs (S3)?

**Fix**: After calculating storage size, explicitly state the access pattern and justify your database choice based on it.

### Mistake 6: Underestimating Fan-Out

Social media systems have non-obvious multiplicative effects. A single tweet write triggers N notifications (N = follower count). A single order creates events in 6 downstream systems. Ignoring fan-out leads to severely underestimated write amplification.

**Fix**: For each write, ask: "What does this write trigger?" Enumerate downstream effects and include them in your write RPS calculation.

### Mistake 7: Not Addressing the Long Tail

Pareto distributions dominate internet traffic. 80% of traffic hits 20% of content. A cache sized for the most popular content can absorb 80-95% of reads, dramatically reducing database load. Ignoring this makes your database sizing look scary when it is actually manageable.

**Fix**: Always calculate "with cache, actual DB reads = N × (1 - cache hit rate)" and size your database for that number, not total reads.

### Mistake 8: HDD for Database Primary Storage

Engineers who learned databases before NVMe SSDs sometimes default to HDD sizing. HDD's 100 IOPS random read capacity is a catastrophic bottleneck for any database serving interactive traffic.

**Fix**: All database primary storage is SSD (NVMe preferred). HDDs belong only in sequential-write workloads (Kafka log files, cold backup storage).

### Mistake 9: Ignoring Connection Limits

A Go application server with database connection pool of size 10 can only run 10 concurrent database queries. At 50,000 RPS, only 10 are hitting the database at any given time - the rest must either find cached results or queue. Connection limits are often the first bottleneck teams hit.

**Fix**: Explicitly calculate: (number of app servers) × (connections per server) = total DB connections. Ensure this is within your database's max_connections setting. Use a connection pooler (pgBouncer for PostgreSQL) to multiplex.

### Mistake 10: Confusing Read and Write Amplification in Interviews

Candidates often correctly calculate write RPS at 1,000 writes/second but then design a database to handle 50,000 reads/second without noting that a write-through cache reduces database reads to 5,000/second (90% cache hit rate). This makes the system appear to require 10x more database capacity than it actually does.

**Fix**: Apply cache hit rate to read estimates before sizing your database tier.

### Junior → FAANG: Internalizing Mistakes Before They Happen in the Interview

The ten mistakes in this section are not abstract warnings: they are patterns that interviewers observe in real candidates, and each one signals a specific gap in distributed systems understanding. Studying them before your interview lets you avoid them deliberately rather than discovering them through failure.

**Mistakes 1 and 2 are habits, not knowledge gaps.** Skipping estimation and forgetting the peak multiplier are not things you do because you do not know better. They are things you do under interview pressure when you rush to the "interesting" architecture part. The fix is procedural: always write the five framework headers before saying anything, and always produce both average RPS and peak RPS as a pair. Make this automatic through practice, not through trying to remember during the interview.

**Mistakes 3 and 4 are arithmetic discipline.** Forgetting replication and confusing throughput with capacity are calculation errors that experienced interviewers catch immediately. Build a checklist reflex: every storage number gets "times three." Every capacity number gets "times 0.7 for utilization." Run through the checklist at the end of your estimation section before moving to architecture.

**Mistakes 5, 7, and 10 are judgment gaps.** Ignoring access patterns, ignoring the long tail, and confusing read and write amplification all reflect a gap in understanding how caching and data access work at scale. The remediation: for every read-heavy system you design, explicitly state the expected cache hit rate and derive the database QPS from (total read RPS times (1 minus cache hit rate)). This calculation is what demonstrates that you understand the caching layer's role in the system.

**Mistake 6 (underestimating fan-out) is the most dangerous in practice.** Fan-out is often the difference between a design that works and one that falls over at scale. For every write operation in a social system, ask: who receives notification of this write? The answer (follower count, downstream systems, materialized views) is the fan-out multiplier. In a Twitter-scale system, the write RPS appears manageable at 120 per second, but the fan-out to 200 average followers produces 24,000 fan-out writes per second. Ignoring this makes your write infrastructure design wrong by a factor of 200.

**First-job habit:** After every design review or architecture discussion you participate in, mentally run through the ten mistakes list. Did the proposal calculate peak RPS with a peak multiplier? Did it include replication in the storage estimate? Did it account for fan-out? This review habit catches architectural gaps before they reach production.

### Senior @ FAANG: Common Mistakes as Signals for Team Process Gaps

At senior level, observing these mistakes in your team's design documents or post-mortems is a signal that a process gap exists, not just an individual knowledge gap. A staff engineer responds to each mistake pattern with a process fix, not just a correction.

**Mistake 1 (skipping estimation) as a design review culture signal.** If your team's design documents routinely reach the architecture section without a capacity estimate, the design review template is not enforcing the estimation requirement. The fix is structural: add capacity estimation as a required section in the design review template, with a checklist that the author must complete before the review can proceed. A staff engineer changes the template, not just corrects the individual document.

**Mistakes 3 and 4 as infrastructure provisioning risks.** An estimate that forgets replication understates storage requirements by 3x. An estimate that uses peak throughput as capacity (ignoring the 70% utilization target) understates server requirements by 43%. Either error can lead to under-provisioning that causes capacity incidents. A staff engineer who spots these errors in a design review must not just correct the numbers but identify what process failure allowed the error to reach the review stage. Is there no estimation checklist? No peer review of capacity estimates? No comparison to similar existing systems?

**Mistake 6 (fan-out underestimation) as a platform governance concern.** Fan-out underestimation at the individual service level becomes a platform-wide incident when the fan-out hits shared infrastructure. A single user action that triggers 10,000 downstream writes across a system with 1 million simultaneous users creates 10 billion fan-out writes per second across the platform's shared Kafka and database infrastructure. A staff engineer owning shared platform infrastructure must maintain a fan-out model: for each write event type on the platform, what is the fan-out multiplier, and what is the peak aggregate fan-out write rate to shared infrastructure? This model is the input to shared infrastructure capacity planning.

**Mistake 8 (HDDs for database storage) as a hiring signal.** When a candidate in a technical interview proposes HDDs for primary database storage without qualification, it signals that they have not operated databases at interactive traffic scale. At the team level, if an engineer proposes this in a design review, it signals that the team lacks production database operations experience. A staff engineer responds by documenting the team's storage tier policy (all interactive database primary storage on NVMe, all cold or batch storage on HDD) and sharing the HDD IOPS number that makes this policy quantitatively obvious.

**Mistake 9 (ignoring connection limits) as a recurring production incident pattern.** Connection pool exhaustion is one of the most common production incidents in Go-based services connecting to PostgreSQL. A staff engineer who has seen this incident pattern must drive proactive mitigation: every service that connects to a PostgreSQL database must document its connection pool size, the team must aggregate connection pool sizes across all services connecting to each database instance, and the aggregate must be compared to the database's max_connections setting. If the aggregate exceeds max_connections, a connection pooler (pgBouncer) must be deployed before the service launches, not after the incident.

**L6/L7 concern: common mistakes as interview bar-raiser signals.** When interviewing L5 and L6 candidates, a bar raiser at FAANG looks for whether the candidate proactively avoids these mistakes or only corrects them when prompted. A candidate who spontaneously says "I should note that my storage estimate needs a 3x replication multiplier, and I need to apply a 70% utilization target to the server count" is demonstrating fluency. A candidate who makes these mistakes and corrects them only when the interviewer asks "did you account for replication?" is demonstrating that they know the concepts but have not internalized them as habits. The bar raiser's job is to distinguish these two profiles, because the first produces reliable capacity plans under pressure and the second does not.

---
