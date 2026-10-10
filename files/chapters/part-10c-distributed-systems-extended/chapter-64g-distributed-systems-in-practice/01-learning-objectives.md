## Learning Objectives

1. **Apply CAP theorem correctly** - Understand CP vs AP systems with real examples (etcd, Cassandra, DynamoDB), extend to PACELC, and make the right consistency trade-offs per data type
2. **Choose consistency models per use case** - Match per-operation consistency levels to business requirements: financial transactions need different guarantees than analytics counters
3. **Debug distributed systems** - Correlate traces, logs, and metrics across services to reconstruct timeline of distributed failures
4. **Test network partitions** - Use `tc netem` and chaos tooling to simulate partitions and verify Go services behave correctly under split-brain conditions
5. **Handle clock skew** - Understand why `time.Now()` is dangerous in distributed contexts and implement Hybrid Logical Clocks in Go
6. **Recognize anti-patterns** - Identify and remediate distributed monoliths, chatty services, synchronous chains, and missing backpressure
7. **Learn from famous failures** - Apply lessons from Amazon S3 2017, Cloudflare BGP 2019, and Facebook 2021 to design more resilient Go systems
8. **Build a distributed systems design review checklist** - Apply a systematic framework before shipping any distributed system component

### Junior → FAANG: Turning Objectives Into Interview Talking Points

Learning objectives in isolation are abstract. The value comes from being able to narrate each one as a concrete experience or worked example when an interviewer asks "tell me about a time you dealt with a distributed systems problem."

For each objective here, prepare a two-minute answer. For CAP, name a specific system you chose and why. For debugging, describe a real or hypothetical failure timeline: service A timed out because service B was slow because a DB index was missing, and you found it by correlating trace IDs across service logs. For clock skew, explain why HLC is safer than `time.Now()` for causality without needing to derive the algorithm from scratch.

Entry-level engineers commonly skip objectives 4 (partition testing) and 5 (clock skew) because they seem advanced. At FAANG, these are the objectives that separate candidates who have production experience from those who only know the theory. Invest extra time here.

### Senior @ FAANG: Using Objectives as a Team Capability Checklist

At senior level, this list of objectives doubles as a team capability audit. For each objective, the question is not "can I do this?" but "does my team have this capability built into its standard operating procedure?"

If objective 3 (distributed debugging) is not a standard workflow in your team's on-call runbook, the next major incident will take hours longer to resolve than it should. If objective 4 (partition testing) is not in CI, every deployment is a bet that the code behaves correctly under network failures that no one has tested. If objective 7 (famous failure analysis) has never been discussed in your team's engineering review, you are likely repeating failure modes that have already cost other organizations millions of dollars.

The staff-level output of reviewing these objectives is a gap analysis: which capabilities does the team lack, what is the cost of each gap in incident impact, and what is the minimum investment to close each gap? This analysis is the input to a quarterly engineering excellence proposal, not a one-day coding exercise.

For L6/L7 scope, objective 8 (design review checklist) is the most important: a checklist that every service must pass before deployment is a platform-level forcing function that scales capability across hundreds of engineers without requiring individual heroics.

---
