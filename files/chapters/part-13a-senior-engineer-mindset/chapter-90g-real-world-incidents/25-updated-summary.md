## Exercises

The exercises for this chapter challenge you to implement the defensive patterns extracted from these 20 incident post-mortems:

1. **Multi-Region Failover Client (§90G.1)**: Build a resilient client that detects regional outages and dynamically routes to alternative geographic corridors.
2. **Progressive Rollout Controller (§90G.2)**: Implement canary stages with automated metric evaluation and rollback thresholds inspired by CrowdStrike.
3. **Out-of-Band Health Monitor (§90G.3)**: Design a health checker that operates independently of the monitored infrastructure's control plane.
4. **AI Output Quality Monitor (§90G.4)**: Detect semantic degradation, repetition loops, and anomalous characters in model outputs.
5. **Goroutine Leak Detector (§90G.10)**: Monitor runtime goroutine counts and capture stack traces upon abnormal growth.
6. **Circuit Breaker with Retry Budget (§90G.8, §90G.16)**: Prevent thundering herds with exponential backoff, jitter, and request budget limits.
7. **Rule Ordering Validator (§90G.7)**: Build a static analysis engine that flags shadowed or unreachable configuration rules.
8. **Living Incident Taxonomy (§90G.21)**: Catalog your organization's post-mortems into a structured risk register mapped to defensive Go implementations.

---

## Summary

This chapter studied twenty categories of real-world infrastructure failures, extracting engineering principles and
building Go implementations of the defensive patterns that would have prevented or mitigated each incident.

**The additional incidents and their core lessons (90G.14 through 90G.21):**

11. **Fastly CDN Global Outage** - A latent bug that passed all testing sat dormant until a single customer's valid
    configuration change triggered it, taking down 85% of the CDN network. Configuration changes need canary
    deployment, and latent bugs require fuzz testing to discover before customers do.

12. **Roblox 73-Hour Outage** - BoltDB's write amplification under Consul's increasing write load created a death
    spiral that was worsened by scaling attempts. Know your storage engine's I/O characteristics, and implement
    circuit breakers on service discovery to prevent thundering herds.

13. **AWS us-east-1 Internal Thundering Herd** - Retry policies without jitter synchronized internal clients into a
    thundering herd that overwhelmed networking infrastructure for 14 hours. Every retry policy must include jitter,
    and global retry budgets cap aggregate retry volume.

14. **Datadog 51-Hour Outage** - systemd-networkd deleted Cilium's eBPF-managed routes because it did not recognize
    them as intentional. When multiple systems manage the same resource (network routes), explicit ownership
    tracking and reconciliation daemons prevent conflicts.

15. **Atlassian 14-Day Deletion** - A maintenance script received site IDs instead of app IDs, deleting 775 customer
    tenants. Go's type system can prevent this entire class of bug: use distinct types for distinct identifiers,
    never `[]string` for IDs.

16. **Let's Encrypt Loop Variable Bug** - Go's pre-1.22 loop variable semantics caused a closure capture bug that
    skipped CAA checks, resulting in 3 million certificates being revoked. Upgrade to Go 1.22+, run `go vet` in
    CI, and write tests that specifically exercise concurrent access to loop-derived values.

17. **Cloudflare arm64 Compiler Bug** - A Go compiler bug in async preemption liveness analysis caused rare crashes
    on arm64 architecture. Compiler bugs exist in production - cross-architecture stress testing and knowledge of
    runtime escape hatches (GODEBUG) are essential.

18. **The Complete Incident Taxonomy** - 50 incidents mapped to root causes, defensive principles, and Go
    implementations. The #1 finding: configuration/deployment errors cause 32% of all incidents, making automated
    validation and progressive deployment the highest-ROI reliability investment.

**The meta-lesson remains unchanged:** Every failure was preventable with engineering practices that were well-known
at the time. The gap is not in knowledge but in discipline - the discipline to implement progressive deployments,
validate configurations, build independent recovery systems, use the type system for safety, tune runtime
parameters, and break positive feedback loops before they become death spirals. The senior engineer's job is to
close that gap systematically, one defensive implementation at a time.

---

*Next: Chapter 90H - Software Failures That Killed: When Code Costs Lives*

---

### Junior → FAANG: Turning the Full Chapter into an Interview Narrative

The 20 incidents studied in this chapter give you the raw material for every reliability-related interview question at FAANG. Rather than memorizing all 20, select two or three from different root cause categories and build a coherent narrative. A strong choice is CrowdStrike (deployment error), Roblox (feedback loop amplification), and Atlassian (type confusion). For each, you can explain the failure mechanism in one sentence, the defensive pattern that would have prevented it, and a concrete Go implementation from this chapter that demonstrates the pattern. When an interviewer asks "how do you ensure deployment safety?", your answer flows from CrowdStrike through the canary deployer. When they ask "how do you handle cascading failures?", Roblox plus the circuit breaker with write amplification monitoring is your anchor. The incidents are memorable and the implementations are tangible: two properties that distinguish candidates who understand reliability from candidates who have memorized reliability buzzwords.

### Senior @ FAANG: The Discipline Gap Measured and Closed at Org Scale

At L6, closing the discipline gap across 20 incident categories is a multi-quarter platform roadmap. The first step is measurement: for each of the defensive patterns documented in this chapter, determine what percentage of your org's production services implement it. Circuit breakers on all external dependencies. GOMEMLIMIT set and documented. Goroutine leak detection and alerting. Canary rollout for all artifact types including configuration. Type-safe identifiers for critical IDs. Each metric has a current state and a target state. The delta is the discipline gap.

The second step is sequencing: address failure categories by frequency and severity first. At 32%, configuration/deployment errors dominate the taxonomy. Closing that gap through a mandatory canary deployment platform for all artifact types is the single highest-ROI investment. At 24%, software bugs (including latent bugs exposed by configuration) are second. Closing that gap requires CI-enforced fuzzing for configuration parsers and static analysis gating for the known Go bug classes (loop variable capture, goroutine leaks, race conditions) documented in this chapter.

The third step is governance: make the correct behavior the default behavior. Services that use the platform's canary deployer automatically comply with the progressive rollout requirement. Services that import the organization's HTTP client library automatically get circuit breakers, jittered retry, and retry budgets. Services that use the standard identity type framework cannot accidentally confuse ID types. Platform investment converts individual discipline into organizational default, which is the only reliable way to close the discipline gap across a team that grows faster than the set of engineers who have personally read this chapter.

---

