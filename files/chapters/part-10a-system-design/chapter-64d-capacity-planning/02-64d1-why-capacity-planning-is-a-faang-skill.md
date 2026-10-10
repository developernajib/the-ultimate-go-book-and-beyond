## 64D.1 Why Capacity Planning Is a FAANG Skill

### The System Design Interview Reality

In every FAANG system design interview, within the first five minutes, the interviewer expects you to anchor the discussion in scale. "Design Twitter" means nothing without understanding whether you are designing for 1,000 users or 1,000,000,000 users. The entire architecture changes based on that answer.

Scale estimation - also called back-of-envelope (BOE) calculation - is the technique of producing order-of-magnitude estimates for the key parameters of a system: traffic, storage, bandwidth, and compute. You do not need precise numbers. You need correct orders of magnitude.

Interviewers evaluate BOE estimation on two dimensions:

1. **Do you know the numbers?** Latency numbers, throughput numbers, storage constants - these must come from memory. An engineer who cannot recall whether an SSD read takes microseconds or milliseconds cannot design reliable systems.

2. **Do you have a structured framework?** Ad-hoc estimation that jumps to conclusions is as bad as no estimation. Interviewers want to see a repeatable process: start with users, derive requests per second, calculate storage and bandwidth, then size servers.

Engineers who skip estimation and jump to architecture diagrams consistently receive lower interview scores. Estimation demonstrates senior thinking: understanding the scale of the problem before committing to a solution.

### Production Capacity Planning and Outages

Beyond interviews, capacity planning is one of the most impactful engineering practices in production. The majority of production outages at scale are capacity failures, not code bugs:

- **CPU saturation**: More traffic than CPU can handle. Requests queue and timeout
- **Database connection exhaustion**: More concurrent queries than connection pool allows. Requests fail immediately
- **Disk IOPS exhaustion**: More I/O operations than disk can sustain. Latency spikes
- **Memory exhaustion**: OOM kills. Service restarts under load
- **Network bandwidth saturation**: More data than links can carry. packet loss

Each of these failures has a predictable signature in metrics. An engineering team with good capacity planning practices identifies the warning signs weeks or months before they cause an outage. Teams without capacity planning are always surprised.

At Google, capacity planning is formalized in the Site Reliability Engineering practice. Every service has a capacity plan that answers: what is our current utilization? At what utilization level will we fail? How far are we from that level? When will we reach it at current growth? What will we do when we get there?

A staff engineer is expected to own this analysis for their team's services.

### Junior → FAANG: Making Capacity Planning Second Nature Before Your Interview

The distinction this section draws between knowing numbers and having a framework is the exact distinction that separates candidates who pass system design rounds from those who do not. Here is how to close each gap.

**Knowing the numbers in practice.** The latency table and throughput table in this chapter are not reference material for the interview: they are things you say out loud from memory while drawing boxes on a whiteboard. The test is whether you can say "NVMe random read is about 100 microseconds, so a database query with one disk seek is sub-millisecond" without pausing. If you cannot, you will waste time during the estimation phase and compress the architecture discussion. Drill the numbers with flashcards or by writing them from memory daily for two weeks.

**Having a framework in practice.** "I have a structured framework" means that the first thing you write on the whiteboard, before any architecture box, is a table with five rows: DAU, average RPS, peak RPS, storage, bandwidth. You fill in the rows using the four-step traffic method and the five-step storage method before drawing anything. Interviewers at Google and Meta explicitly look for this sequencing as a signal of senior thinking.

**Why skipping estimation costs you the offer.** An engineer who jumps to "use Cassandra for storage and Kafka for events" without estimating whether the traffic requires distributed storage or whether a single PostgreSQL instance would suffice is signaling that they design by pattern-matching, not by first principles. Interviewers note this explicitly in debrief. The estimation phase is not a hurdle before the real interview: it is part of the evaluation.

**First-job habit:** The next time your team has a production capacity incident (CPU, memory, connections, disk), write down two numbers before the post-mortem: what was the measured peak at the time of failure, and what would the correct headroom target have implied about when to act? Then find when that date was relative to when the team first noticed the growth. That delta is the cost of skipping capacity planning.

**Interview entry point:** "Design a system at Twitter scale." Before drawing anything, say: "Let me start by anchoring the scale. Twitter has about 400M DAU, roughly 10 timeline reads per user per day and about 0.03 tweets per user per day (most users lurk). That gives me 40K read RPS and 120 write RPS on average, and a 2.5x peak multiplier takes reads to about 100K RPS, but with fan-out to followers the write amplification is much higher. Let me work through that." That opening signals exactly the kind of structured thinking the interviewer is looking for.

### Senior @ FAANG: Capacity Planning as an Organizational Discipline, Not a Personal Skill

At senior level, capacity planning is not something you do before a design review. It is a continuous organizational practice that you own and drive across your team's services.

**ADR: formal capacity planning cadence.** Every service that handles user traffic should have a documented capacity plan that is reviewed on a defined cadence: monthly for high-growth services, quarterly for stable services. The plan answers four questions: what is current peak utilization for each constrained resource (CPU, memory, connections, disk IOPS), at what utilization level does the service degrade (the knee of the curve), when will current growth reach that level, and what is the remediation plan. A staff engineer writes the template, trains the team on it, and ensures it is updated after every major traffic change.

**Governance: capacity incidents as planning failures.** When a service pages due to capacity exhaustion, the post-mortem should always include a root-cause answer to "when was this growth trend visible, and why was no action taken?" If growth was visible three months before the incident and no capacity action was taken, that is a planning governance failure, not just an operational failure. A staff engineer ensures post-mortems include this analysis and that the action item is a process fix (adding the service to the capacity review cadence), not just a one-time remediation.

**Platform thinking: cost and capacity together.** At Google and AWS, the canonical SRE practice frames capacity planning in terms of both reliability and cost. Running at 50% utilization is safer than 80%, but it also costs roughly 60% more per unit of throughput. A staff engineer owns the utilization target decision for their team's services: for stateless application servers, 70% is defensible. For database primaries where a spike can cause a cascading failure, 50% is the right target. Documenting these targets and their rationale is part of the platform's operational contract.

**Maturity model for production capacity planning.** Level 1: capacity planning happens reactively after incidents. Level 2: rough estimates exist in design documents but are not updated or measured against reality. Level 3: quarterly reviews compare estimates to actuals, and runway calculations exist for constrained resources. Level 4: automated dashboards show real-time utilization against targets, runway alerts fire with 90-day lead time, load tests run quarterly and baselines are tracked over time, and pre-provisioning runbooks exist for known high-traffic events. Driving the team from level 2 to level 4 is the staff engineer's capacity planning responsibility.

**L6/L7 concern: capacity planning for multi-tenant platforms.** If your team owns infrastructure used by other teams (a shared Kafka cluster, a shared Redis tier, a shared database cluster), capacity planning becomes a multi-tenant resource allocation problem. You need usage quotas per team, enforcement mechanisms (throttling, backpressure), and a quota increase process that requires a capacity review. Without this governance, one team's growth can cause latency degradation or outages for every other team on the shared platform. Staff engineers design and own this multi-tenant capacity model.

---
