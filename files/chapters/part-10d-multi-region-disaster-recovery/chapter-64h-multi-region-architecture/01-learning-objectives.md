## Learning Objectives

By the end of this chapter, you will be able to:

1. Design and implement active-active and active-passive multi-region topologies in Go
2. Build GeoDNS and Anycast-aware global load balancing with latency-based routing
3. Implement cross-region data replication with conflict resolution using CRDTs, last-write-wins, and vector clocks
4. Automate regional failover with health-check driven traffic shifting
5. Manage distributed sessions across regions with consistency guarantees
6. Integrate multi-region PostgreSQL setups using Citus and Patroni patterns
7. Apply chaos engineering techniques to validate regional resilience
8. Reason clearly about CAP theorem trade-offs in production multi-region systems

---

### Junior -> FAANG: Using Learning Objectives as an Interview Checklist

Each objective in this list maps directly to a line of questioning in FAANG system design interviews. Treat the list as a self-assessment before your interview loop. For each item, ask yourself: can I explain this clearly in two minutes? Can I identify a concrete trade-off? Can I name a real system that makes this choice?

The two objectives that trip up junior candidates most frequently are conflict resolution and CAP theorem application. Conflict resolution is not just "last write wins." You need to explain when LWW is safe (user profile avatar, which has no business semantic relationship between concurrent updates) versus when it silently corrupts data (shopping cart quantity, where two increments from different regions should add, not overwrite). CAP theorem application means knowing that you choose CP or AP per data type, not per system, and being able to name which choice you would make for different entity types.

For your first job, prioritize objectives 1, 4, and 5 in the short term. Understanding topology choice, automated failover, and session consistency will unblock 80% of the feature work you encounter on a team that operates multi-region services.

### Senior @ FAANG: Objective Completeness as a Maturity Signal

A senior engineer can walk through this objective list and explain which ones their current system satisfies, which ones it partially satisfies, and which ones it knowingly skips and why. That honest gap analysis is more valuable than claiming to have implemented everything.

At L6, you are expected to own multiple objectives across an entire service. At L7 and above, you own the framework within which other teams achieve these objectives. The distinction matters: an L6 implements the health-check-driven failover controller for their service. An L7 provides the health-check interface contract, the runbook integration protocol, and the SLA validation framework that ten teams use to build their own controllers.

The objective on chaos engineering deserves particular attention at senior levels. Most teams have chaos engineering as an aspiration. The bar-raiser question is: does your chaos testing run automatically in CI? Is it blocking on merge? Do your chaos experiments have documented hypotheses and measured steady-state baselines? If chaos engineering only runs during GameDays, it is not integrated, it is theatrical. At staff level, the objective is not "apply chaos engineering techniques" but "build the platform that makes chaos testing as routine as unit testing."

Objective 8 on CAP theorem reasoning is the L6/L7 signal in interviews. Candidates who say "we use eventual consistency" without specifying which data types and under which partition scenarios are pattern-matching, not reasoning. The bar raiser probes by changing the scenario: "What if the network partition lasts 10 minutes instead of 30 seconds? Does your consistency model hold? What do you tell the user?"
