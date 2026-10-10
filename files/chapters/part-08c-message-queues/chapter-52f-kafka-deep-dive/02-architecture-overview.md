## Architecture Overview

This diagram shows how Kafka's components fit together. Brokers hold partitioned topic data, producers write to partition leaders, and consumer groups read independently:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        KAFKA CLUSTER                                │
│                                                                     │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │
│  │  Broker 0   │   │  Broker 1   │   │  Broker 2   │                │
│  │ (Controller)│   │             │   │             │                │
│  │             │   │             │   │             │                │
│  │ ┌─────────┐ │   │ ┌─────────┐ │   │ ┌─────────┐ │                │
│  │ │Topic A  │ │   │ │Topic A  │ │   │ │Topic A  │ │                │
│  │ │Part 0(L)│ │   │ │Part 1(L)│ │   │ │Part 2(L)│ │                │
│  │ │Part 1(F)│ │   │ │Part 2(F)│ │   │ │Part 0(F)│ │                │
│  │ └─────────┘ │   │ └─────────┘ │   │ └─────────┘ │                │
│  │ ┌─────────┐ │   │ ┌─────────┐ │   │ ┌─────────┐ │                │
│  │ │Topic B  │ │   │ │Topic B  │ │   │ │Topic B  │ │                │
│  │ │Part 0(L)│ │   │ │Part 0(F)│ │   │ │Part 1(L)│ │                │
│  │ └─────────┘ │   │ └─────────┘ │   │ └─────────┘ │                │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘                │
│         │                 │                 │                       │
│         └────────┬────────┴────────┬────────┘                       │
│                  │   KRaft Raft    │                                │
│                  │   (Metadata)    │                                │
│                  └────────┬────────┘                                │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
    ┌───────▼──────┐ ┌──────▼───────┐ ┌────▼─────────┐
    │  Producer 1  │ │  Producer 2  │ │  Producer 3  │
    │  (Go App)    │ │  (Go App)    │ │  (Go App)    │
    └──────────────┘ └──────────────┘ └──────────────┘

            ┌───────────────┼───────────────┐
            │               │               │
    ┌───────▼──────┐ ┌──────▼───────┐ ┌────▼─────────┐
    │ Consumer     │ │ Consumer     │ │ Consumer     │
    │ Group A      │ │ Group A      │ │ Group B      │
    │ (Instance 1) │ │ (Instance 2) │ │ (Instance 1) │
    └──────────────┘ └──────────────┘ └──────────────┘

    (L) = Leader Replica    (F) = Follower Replica
```

**Key Takeaway**: Kafka distributes topic partitions across brokers. Each partition has one leader (handles reads/writes) and configurable follower replicas (for fault tolerance). Since Kafka 3.5+, KRaft replaces ZooKeeper for metadata management, running the Raft consensus protocol directly within the brokers.

### Junior -> FAANG: Reading Architecture Diagrams Under Interview Pressure

Architecture diagrams in interview settings are not decoration. When a whiteboard shows a Kafka cluster, interviewers expect you to point to specific elements and explain causality, not just name components.

Practice reading this diagram until these answers are instant:

- A producer writes to partition 1 (L) on Broker 1. What happens next? The leader writes to its local log, the ISR followers (partition 1 follower on Broker 0 and Broker 2) fetch and replicate. When all ISR members acknowledge, the producer receives a response.
- Broker 1 crashes. What happens to Topic A Partition 1? Partition 1's leader was on Broker 1. The KRaft controller detects the failure via missed heartbeats and elects a new leader from the ISR, one of the follower replicas on Broker 0 or Broker 2. Producers redirect to the new leader within seconds.
- Consumer Group A has two instances. How are six partitions distributed? Kafka assigns two partitions per consumer. If one instance crashes, the remaining instance is assigned all six partitions after a rebalance.

The (L) and (F) notation is worth internalizing: every read and write goes to the leader. Followers never serve client requests in the default configuration (rack-aware follower reads are an opt-in feature added in Kafka 2.4). If you see a question about "reading from a replica," that is the rack-aware fetch feature, not default behavior.

### Senior @ FAANG: Mapping Diagram Elements to Operational Failure Modes

The architecture diagram is a topology map for reasoning about failure propagation. At the senior level, you should be able to walk through each connection in the diagram and describe what breaks, what degrades, and what continues when that connection is severed.

**KRaft Raft quorum failures.** The diagram shows Broker 0 as Controller. In a three-node KRaft deployment, losing the controller triggers an election among the remaining two. With three controller nodes, the cluster can tolerate one controller failure. If you run combined mode (broker and controller on the same node), losing a node is a double failure: you lose both a broker and a controller vote. This is why production deployments should use dedicated controller nodes separate from broker nodes.

**Cross-broker replication lag as a leading indicator.** The follower replica connections in the diagram are continuous fetch streams. When a follower falls behind by more than `replica.lag.time.max.ms` (default 30 seconds), it is removed from the ISR. ISR shrinks are a leading indicator that something is wrong: disk I/O contention, network saturation, or GC pauses on the follower broker. An ISR shrink rate above zero, sustained for more than five minutes, should page on-call before it becomes an under-replicated partition alarm.

**Consumer group coordinator placement.** Consumer Groups A and B each have a coordinator broker, determined by `hash(group.id) % __consumer_offsets.partition.count`. The coordinator handles offset commits, heartbeats, and rebalance orchestration. If the coordinator broker is overloaded, all consumer groups whose coordinator lives on that broker will experience elevated rebalance latency. At scale, this is an argument for distributing coordinator load by using distinct group ID prefixes across services, which naturally distributes coordinator assignment.

**Multi-region extension of this diagram.** The single-cluster diagram does not show what happens when the entire datacenter fails. At FAANG, the answer is MirrorMaker 2 replicating to a standby cluster with offset translation. The operational implication: consumer groups in the standby cluster use translated offsets, not the original offsets, so a failover requires either a checkpoint synchronization step or the ability to handle re-processing the last N seconds of messages with idempotent consumers.

---
