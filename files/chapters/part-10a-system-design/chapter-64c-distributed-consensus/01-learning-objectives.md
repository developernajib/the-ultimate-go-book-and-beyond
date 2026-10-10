## Learning Objectives

By the end of this chapter, you will be able to:

- Explain the distributed consensus problem and why it is fundamental to reliable systems
- Describe the FLP impossibility result and its practical implications
- Walk through the Paxos algorithm (Prepare/Promise/Accept/Accepted) correctly
- Explain Raft's leader election, log replication, and safety guarantees from memory
- Implement a simplified but correct Raft node in Go with persistent state, RPC communication, and an apply loop
- Use etcd's Go client for KV operations, watches, leases, and leader election
- Implement distributed locking with fencing tokens to prevent split-brain actions
- Identify when consensus is and is not the right tool
- Answer 20+ FAANG-level distributed systems interview questions on consensus

**Target audience:** Engineers who build or operate distributed services and want to understand the consensus layer underneath them.

### Junior → FAANG: Turning Objectives into Interview Preparation

Each learning objective in this list maps to a specific interview question type. Here is how to use this list as a study guide, not just a checklist.

"Explain the FLP impossibility result" is not a memorization exercise. It is preparation for the follow-up: "If consensus is impossible in an asynchronous system, how does Raft work?" The expected answer is that Raft uses timeouts, which introduce a partial synchrony assumption. If you can explain the assumption without being prompted, you demonstrate distributed systems fluency.

"Implement a simplified but correct Raft node in Go" is harder than it looks. The three persistent variables (currentTerm, votedFor, log) must be persisted before responding to any RPC. Getting the order of operations wrong is a safety violation. Study the implementation in section 64C.4 with attention to where `persist()` is called and why.

"Identify when consensus is and is not the right tool" is the objective that most candidates skip, and it is the one senior interviewers weight most heavily. Practice articulating: eventual consistency with idempotent consumers is the right model for event-driven pipelines, optimistic locking is the right model for low-contention shared counters, and consensus (etcd) is right only for coordination primitives that must be linearizable. The more precisely you can articulate the boundary, the stronger your signal.

**First-job habit:** Before using any distributed coordination library (etcd, consul, zookeeper client), read its source or documentation long enough to answer: what happens if the network partitions for 30 seconds? What happens if the client process GC-pauses for 60 seconds? Answering those questions before writing code prevents a class of subtle production bugs.

### Senior @ FAANG: Owning the Objectives at Platform Scale

At senior level, learning objectives are not personal study targets. They are the minimum bar for everyone on your team, and your job is to ensure the team can demonstrate each one in a production incident, not just an interview.

**Operational translation of each objective:**

"Walk through Paxos and Raft from memory" means your on-call engineers can read a Raft state diagram during an incident and determine whether the cluster behavior they observe is expected or anomalous. This requires that your team has actually run chaos experiments: partitioned the leader, observed the election, healed the partition, and confirmed the stepped-down leader behavior.

"Use etcd's Go client for KV operations, watches, leases, and leader election" means your team has instrumented every etcd call with traces and metrics. When a watch stream closes unexpectedly, you want an alert, not a silent failure. When lease renewal latency spikes, you want a dashboard showing it, not a 3am page when services start losing locks.

"Implement distributed locking with fencing tokens to prevent split-brain actions" is not complete until the storage systems that receive fenced writes actually validate the token. Implementing the lock without implementing the validation gives false safety. A staff engineer drives the end-to-end contract: the lock holder commits to including the token, the storage system commits to rejecting stale tokens, and both sides have integration tests proving the contract holds.

**Staff concern: documenting what the team does NOT own.** Learning objective lists tell engineers what to know. Staff engineers also maintain a "not our problem" list: the etcd cluster SLA is owned by platform engineering, not the application team, and the Raft leader election latency budget is owned by the consensus library, not the Go client code. Clear ownership boundaries prevent both gaps and duplicate work.

---
