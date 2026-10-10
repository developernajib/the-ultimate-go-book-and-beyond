## TLA+ and System-Level Verification

TLA+ is Leslie Lamport's specification language for concurrent and distributed systems. The Temporal Logic of Actions sits at a different level of the verification stack from Frama-C or Coq: TLA+ specifies and checks **designs**, not code. You write what your protocol *should* do, the model checker explores all possible executions, and you find design bugs before any C++ is written.

For a senior engineer, TLA+ is the highest-ROI formal method for distributed systems work. The reason is simple: distributed-system bugs are dominated by interleavings the human brain cannot enumerate, and TLC (the model checker) does enumerate them.

### Why TLA+ matters in industry

Chris Newcombe et al., 2015 CACM "How Amazon Web Services Uses Formal Methods":

- DynamoDB replication protocol: TLA+ caught a bug the design review missed, would have caused data loss.
- S3: a fault-tolerant low-level network algorithm, TLA+ found a bug that occurred only on at least 35 steps.
- EBS: TLA+ specs guide implementation, regression-checked on changes.
- IAM: design specs in TLA+ before C++ work begins.

Microsoft Azure (Cosmos DB), Confluent (Kafka KRaft), MongoDB (replication), Elastic (Elasticsearch cluster coordination) all publish or describe TLA+ specs as part of their design process. By 2026, TLA+ is mainstream in protocol-heavy organizations.

### TLA+ in 90 seconds

TLA+ is the assertion language plus a temporal logic. PlusCal (also by Lamport) is a pseudocode-like surface syntax that translates to TLA+. Most engineers start in PlusCal.

```tla
---- MODULE TwoPhaseCommit ----
EXTENDS Naturals, FiniteSets

CONSTANTS RM   \* set of resource managers

VARIABLES rmState, tmState, msgs

(* --algorithm 2pc {
    variables rmState = [r \in RM |-> "working"],
              tmState = "init",
              msgs = {};
    process (TM = "tm") {
      tm_prepare:
        msgs := msgs \cup {[type |-> "Prepare"]};
        tmState := "wait";
      tm_decide:
        await \A r \in RM: rmState[r] \in {"prepared", "aborted"};
        if (\A r \in RM: rmState[r] = "prepared") {
            tmState := "committed";
            msgs := msgs \cup {[type |-> "Commit"]};
        } else {
            tmState := "aborted";
            msgs := msgs \cup {[type |-> "Abort"]};
        };
    }
    process (R \in RM) {
      r_loop:
        either {
            await [type |-> "Prepare"] \in msgs;
            rmState[self] := "prepared";
        } or {
            rmState[self] := "aborted";
        }
    }
} *)

Consistent == \A r1, r2 \in RM:
    ~(rmState[r1] = "committed" /\ rmState[r2] = "aborted")

==============================
```

`Consistent` is the safety property: no two resource managers ever reach contradictory committed/aborted states. TLC is run with a configuration file specifying RM = {r1, r2, r3} and the property to check.

### TLC: the model checker

TLC explores the state space exhaustively up to a bound. For finite-state designs (and most protocols are finite-state when you bound the number of nodes and message buffer size), TLC either:

- Confirms the property holds on every reachable state.
- Produces a counterexample trace, a sequence of states leading to a violation.

Counterexample traces are the killer feature. You see the exact interleaving, the exact message reorder, the exact node failure that breaks your design. Real example from Newcombe's paper: a DynamoDB inconsistency that required exactly 35 steps and a specific failure pattern. No human reviewer would have found it. TLC found it in minutes.

### Apalache

Apalache (University of Lugano, Informal Systems) is a **symbolic** model checker for TLA+. Instead of enumerating states like TLC, Apalache encodes the spec as SMT and queries Z3.

Trade-offs:

| | TLC | Apalache |
| --- | --- | --- |
| Mode | Explicit-state enumeration | Symbolic (SMT-based) |
| Scaling | Bounded by state count, parallelisable | Bounded by SMT solver, less parallelism |
| Counterexamples | Concrete trace | Concrete trace from SMT model |
| Liveness | Yes (with fairness) | Limited |
| Bounded model checking | No | Yes (k-step bounded) |

By 2026 Apalache is the tool of choice for industrial use cases where the state space is too large for TLC. Informal Systems uses it on the Cosmos blockchain protocols. The recommended workflow: prototype with TLC for fast feedback, scale with Apalache for production-size models.

### How TLA+ guides C++ implementation

The cycle:

1. **Design in TLA+**. Write the protocol abstractly. Run TLC. Fix design bugs.
2. **Document invariants**. Each TLA+ invariant becomes a target assertion in the C++ implementation.
3. **Implement in C++**. The implementation refines the TLA+ spec, but the refinement is rarely proved formally. Instead it is *reviewed* against the spec.
4. **Property-test the implementation against the spec**. Tools like TLC traces converted to test inputs, or model-based testing frameworks (e.g. spec-based fuzzing) compare implementation behavior against TLA+ predictions.
5. **Re-check the spec on changes**. When the protocol evolves, update the spec first.

The discipline of *writing the spec first* is itself the value, even before TLC runs. Lamport: "Writing a specification means thinking precisely about what your system does. Most engineers do not think precisely about that." TLA+ forces precision.

### Liveness and fairness

Safety: nothing bad happens. Liveness: something good eventually happens (every request is eventually served, every transaction eventually commits or aborts). Liveness requires fairness assumptions: a process that is enabled infinitely often eventually steps.

```tla
Liveness == <>(\A r \in RM: rmState[r] \in {"committed", "aborted"})
Spec == Init /\ [][Next]_vars /\ WF_vars(Action)
```

`<>` is "eventually". `WF_vars(Action)` is weak fairness on the action. TLC checks liveness with depth-first search and cycle detection in the state graph.

### When TLA+ is the right answer

- Distributed protocols: replication, consensus, leader election, two-phase commit, Raft, Paxos.
- Concurrent algorithms: lock-free queues, work-stealing schedulers (at design level).
- Caching protocols and consistency models.
- Configuration changes in running clusters.
- Failure recovery sequences.

When TLA+ is **not** the right tool:

- You want to verify *code*, not design. TLA+ stops at the spec level. Use Frama-C, CBMC, or Coq for code.
- The system is single-threaded with simple control flow. Property tests suffice.
- The state space genuinely cannot be bounded. Nothing helps here, redesign.

### Specifying a Raft cluster

Diego Ongaro's TLA+ spec of Raft (raft.tla) is the canonical example. Roughly 500 lines, captures leader election, log replication, configuration changes, and the safety invariants (election safety, log matching, leader completeness, state machine safety). Run with TLC bounded to 3 servers and message buffer size 4, you get exhaustive coverage of those interleavings. The spec has caught bugs in implementations including etcd and HashiCorp's Raft library.

The same model applies to any new consensus protocol your team designs. Spec first, model check, *then* implement.

### Tooling pragmatics in 2026

- **TLA+ Toolbox**: the original IDE, still works, less actively developed.
- **VS Code TLA+ extension**: the recommended editor by 2026, with model running, syntax highlighting, and go-to-definition.
- **PlusCal Tools**: translation from PlusCal to TLA+, integrated.
- **Apalache CLI**: `apalache-mc check --inv=Inv spec.tla`
- **TLC CLI**: `tlc -config model.cfg spec.tla`

Cloud TLC (CommunityModules has a runner for AWS): run TLC across hundreds of cores for large state spaces.

### Cost

Realistic numbers for adopting TLA+:

- Engineer time to learn enough TLA+ to be productive: 2 to 4 weeks.
- First usable spec for a real protocol: 1 to 3 weeks.
- Spec maintenance: 5 to 10 percent of design time once the team is fluent.
- Bug catch rate: anecdotally one design-level bug per non-trivial spec, sometimes catastrophic.

The ROI is the highest of any formal method discussed in this chapter. If you have not specified your distributed system in TLA+, that is the first investment to make.

> **Senior at FAANG.** TLA+ is the rare formal method whose ROI a director will sign off on after a single internal demo. The pattern that works: pick a protocol your team is about to design. Spec it in TLA+ before any C++ is written. Run TLC. Show the design review the trace of a bug TLC found. The next protocol will get a TLA+ spec without you having to ask.
