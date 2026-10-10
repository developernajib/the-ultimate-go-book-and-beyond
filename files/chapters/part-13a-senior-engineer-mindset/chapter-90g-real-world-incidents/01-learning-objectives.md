## Learning Objectives

1. **Analyze real-world incidents** - Reconstruct timelines, identify root causes at technical and organizational
   levels, and extract actionable engineering principles from each failure
2. **Build multi-region failover** - Implement Go clients that detect regional failures and transparently route
   to healthy regions with proper health checking and circuit breaking
3. **Implement progressive rollouts** - Build canary deployment systems in Go with automatic rollback based on
   error rate monitoring and configurable blast radius
4. **Design recovery independence** - Ensure recovery tools and runbooks do not depend on the systems they are
   meant to recover, avoiding the "recovery tool paradox"
5. **Understand GC trade-offs** - Know when Go's garbage collector is a liability, how to tune it with GOGC and
   GOMEMLIMIT, when to use the ballast pattern, and when to consider other languages
6. **Detect goroutine leaks** - Build production leak detectors using pprof and runtime metrics, identify common
   leak patterns, and prevent them with proper channel and context discipline
7. **Validate configurations** - Build config validation pipelines in Go that catch ordering errors, missing
   rules, and semantic inconsistencies before deployment
8. **Prevent retry storms** - Implement circuit breakers, exponential backoff with jitter, and load shedding
   to prevent cascading failures during partial outages
9. **Build incident response tooling** - Implement monitoring, alerting, and incident coordination systems in Go
10. **Apply failure principles** - Map each incident to the system design principles it violated, building a
    solid mental model of distributed system failure modes

### Junior → FAANG: Which Objectives to Master First

For entry-level FAANG interviews, prioritize objectives 3 (progressive rollouts), 7 (config validation), and 8 (retry storms). These map directly to system design questions you will face. A candidate who can describe how to implement a canary deployment with automatic rollback at a conceptual level, explain why configuration validation should run before deployment, and describe the exponential backoff pattern for preventing retry storms is well-prepared for a mid-level system design loop.

### Senior @ FAANG: All Objectives as Staff Engineering Expectations

At L6, all ten objectives are expected capabilities, not aspirational ones. The question is not whether you know these patterns but whether you have deployed them at scale and can articulate the trade-offs. "Implement progressive rollouts" at L5 means you can write the code. At L6, it means you have defined the rollout policy for your org, set the automatic rollback thresholds, and handled the case where a rollout needs to be paused mid-way due to an unrelated incident.

---
