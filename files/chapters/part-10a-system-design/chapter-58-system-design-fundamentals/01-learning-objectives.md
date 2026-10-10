## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand distributed systems fundamentals** including CAP theorem, PACELC, and consistency models
- **Design scalable architectures** using horizontal scaling, sharding, and database partitioning strategies
- **Implement load balancing** with various algorithms and health checking mechanisms
- **Design effective caching strategies** with appropriate invalidation and consistency patterns
- **Make informed database choices** between SQL and NoSQL based on requirements
- **Apply asynchronous processing patterns** using message queues and background job systems
- **Articulate trade-offs** between availability, consistency, latency, and cost in system design discussions
- **Apply these concepts** in real system design interviews and production architecture decisions

### Junior → FAANG: Translating Objectives into Interview Readiness

Learning objectives on their own do not prepare you for a system design interview. What matters is knowing how each objective maps to a specific type of question and a specific level of expected depth.

For entry-level and early-career candidates, the bar is: can you explain the CAP theorem correctly, can you name when you would choose a document store over a relational database, and can you describe at least two caching strategies with their invalidation trade-offs. Interviewers at FAANG do not expect a junior candidate to have implemented consistent hashing in production, but they do expect you to know what it is and why modulo sharding fails when nodes are added or removed.

A practical prerequisite gap to address before your first FAANG screen: most candidates know what "eventual consistency" means abstractly but cannot give a concrete example of a user-visible bug caused by it (a user updates their profile photo and immediately sees the old one on a page served by a replica). Practice constructing one concrete failure scenario for each consistency model listed in these objectives. That exercise will make the theory stick and give you something specific to say in the interview.

### Senior @ FAANG: Mapping Objectives to Staff-Level Expectations

These objectives describe the knowledge floor for a senior engineer. At L6 and above, the expectation is that you own the architectural decisions that embody these objectives for your team or platform, not just that you can describe them.

**Articulating trade-offs at the design review level.** At L5, you can explain the trade-off between strong and eventual consistency. At L6, you design the system such that each data type explicitly uses the correct model, document the decision in an ADR, and build the observability (replication lag metrics, stale read rate dashboards) that makes the trade-off visible in production. At L7, you set the organizational standard for how those decisions are made and reviewed across all teams in your domain.

**Ownership of asynchronous processing patterns.** "Apply asynchronous processing patterns" is an L5 objective. An L6 concern is: what happens when the message queue consumer falls behind by hours? Is there a dead-letter queue? Who is paged? Is there a runbook? Does the queue have backpressure that propagates upstream or does it accept messages silently until it OOMs? At L7, you own the platform-level queue infrastructure that makes it easy for every team to answer those questions correctly by default.

**Interview calibration for L6 and above.** System design interviewers at this level are evaluating whether you can lead the conversation. That means you raise the consistency question before the interviewer does, you estimate numbers rather than waiting to be asked, and you proactively identify which component will be the bottleneck at 10x load. The learning objectives in this chapter represent the vocabulary you bring to the conversation. The depth and proactivity with which you apply that vocabulary is what separates L5 from L6 from L7.

---
