## Core Incident Concepts Recap (Part 1: 90G.1-90G.13)

This chapter studied ten categories of real-world infrastructure failures, extracting engineering principles and
building Go implementations of the defensive patterns that would have prevented or mitigated each incident.

**The incidents and their core lessons:**

1. **Kinetic-attack tabletop scenario** - Multi-AZ is not disaster recovery against kinetic or regional threats.
   Geographic risk modeling and multi-region architecture with cable corridor diversity is required for true
   resilience.

2. **CrowdStrike Global Outage** - The largest IT outage in history was caused by skipping canary deployments
   for a configuration update. Progressive rollout with automated rollback is not optional for infrastructure
   software. A single canary host would have saved $5.4 billion.

3. **Meta's 6-Hour Disappearance** - Recovery tools that depend on the system they recover create a paradox
   where the outage makes recovery impossible. Out-of-band monitoring, management, and communication systems
   are essential.

4. **Claude/Anthropic's Three Overlapping Bugs** - Standard health checks miss quality degradation. AI systems
   require continuous output quality monitoring. Multiple overlapping bugs on different platforms create
   contradictory diagnostic signals that delay resolution.

5. **Discord's Go-to-Rust Migration** - Go's garbage collector is a liability for services with massive
   pointer-heavy caches. Before migrating, try GOMEMLIMIT, off-heap storage, and external caches. Know when
   Go is not the right tool.

6. **Grab's 5x CPU Reduction** - For CPU-bound services, Go's runtime overhead (GC, scheduler, allocator) can
   consume 55% of CPU. Evaluate language alternatives for cost-critical, CPU-bound workloads.

7. **Cloudflare's Configuration Catastrophes** - Rule ordering errors in BGP/firewall/ACL policies are a
   well-known failure class. Automated validation must check for unreachable rules before deployment.
   Centralized control planes are a single point of failure.

8. **GitHub's Three-Day Database Nightmare** - Automated failover can cascade. Retry storms from dependent
   services prevent recovery. Circuit breakers and retry budgets are essential.

9. **Twitter/X Staff Reduction** - Institutional knowledge is the most valuable and least documented asset.
   Runtime dependency discovery, mandatory documentation, and bus factor > 1 are organizational resilience
   requirements.

10. **Go-Specific Failures (Uber, Twitch)** - Goroutine leaks are the Go equivalent of memory leaks. GC
    tuning (GOMEMLIMIT, ballast) is essential for cache-heavy services. Monitor goroutine count and GC metrics
    in every Go service.

**The meta-lesson across all incidents:** Every failure was preventable. Not in hindsight - with engineering
practices that were well-known at the time of each incident. The gap is not in knowledge but in discipline:
the discipline to implement canary deployments, to validate configurations, to build recovery independence, to
monitor output quality, to document dependencies, and to tune runtime parameters. The senior engineer's job is
to close that gap - not by being perfect, but by building systems that fail safely when imperfection inevitably
occurs.

### Junior → FAANG: Synthesizing the Chapter into Interview Answers

The meta-lesson is your framing for behavioral interview questions about reliability: "The gap is not knowledge, it is discipline. The patterns exist. The question is whether you build them in before the incident or after." This framing demonstrates engineering maturity. Reinforce it with one specific example from this chapter, applied to your own experience: "I applied the canary pattern after reading about CrowdStrike, and we caught a configuration regression on our first canary host before it reached 10% of our fleet."

### Senior @ FAANG: The Discipline Gap as a Staff Engineer's Mission

At L6, closing the discipline gap is your primary contribution. You are not the person implementing canary deployments on one service. You are the person who builds the canary platform, defines the org-wide canary policy, and creates the CI gate that prevents any service from going to production without a configured rollback threshold. You measure the gap (how many services lack circuit breakers, how many have no goroutine monitoring, how many runbooks have not been tested in six months), report it to leadership, and drive systematic closure. The difference between an org that executes well and one that does not is almost always a staff engineer who made the correct behavior the easiest behavior.

---
