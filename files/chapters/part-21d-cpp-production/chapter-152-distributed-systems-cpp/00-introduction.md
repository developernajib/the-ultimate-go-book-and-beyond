# Chapter 152: Distributed Systems in C++

> "A distributed system is one in which the failure of a computer you didn't even know existed can render your own computer unusable.", Leslie Lamport

Distributed systems written in C++ are the load-bearing infrastructure of every hyperscaler on the planet. When you open a Google Doc, your keystrokes traverse Spanner. When you watch a YouTube video, the metadata path went through Bigtable. When a Discord channel buffers a million concurrent users, the routing layer is C++. When your AWS bill ticks up by a fraction of a cent, the billing pipeline that recorded it was almost certainly built on a C++ event store. The world runs on distributed C++, and the engineers who can design, build, and operate these systems are among the most highly compensated specialists in the industry.

This chapter is for the L5+ engineer who already knows modern C++ and now needs to build production distributed services. We will not rehash CAP theorem cartoons. We will write Raft from scratch in C++23, implement vector clocks and CRDTs, build gossip protocols on Asio, and walk through the actual architecture of Spanner, Bigtable, and FoundationDB at the level of detail expected in a staff-engineer design review at Google.

## Why C++ for Distributed Systems

Three properties make C++ the dominant language for the deepest layers of distributed infrastructure: latency, footprint, and control.

**Latency**. A garbage-collected language pays a tail-latency tax that compounds across every hop in a distributed call graph. A 99th-percentile pause of 50 ms in a single Java service becomes a 99.9th-percentile pause of 500 ms when fanned out over ten parallel calls. C++ services with deterministic destruction and arena allocators can hold p99 latencies at single-digit microseconds for in-memory operations and sub-millisecond for disk-backed ones. ScyllaDB rewrote Cassandra in C++ specifically to escape this tax.

**Footprint**. A storage node that hosts 50 TB of data has perhaps 256 GB of RAM. Every byte of per-key overhead matters. RocksDB's SkipList memtable, FoundationDB's storage engine, and ClickHouse's columnar engine all use C++ because they need bit-packed structs, custom allocators, and zero-overhead abstractions. A JVM's per-object header overhead alone would consume tens of gigabytes on these nodes.

**Control**. Distributed correctness often depends on memory ordering, fence semantics, and the ability to reason about exactly when a write becomes visible to another thread or another machine. C++23 gives you `std::atomic` with explicit memory orderings, `std::hardware_destructive_interference_size` for cache-line padding, and direct access to `mmap`, `io_uring`, `RDMA`, and `DPDK`. Higher-level languages abstract these away, which is fine until you are debugging a Raft implementation that loses log entries because of a missing acquire fence.

## The C++ Distributed Systems Canon

The systems below form the reading list of any senior distributed C++ engineer.

**FoundationDB** (Apple). An ordered key-value store with strict serializable transactions, written in C++ with a custom actor language called Flow that compiles to C++. Famous for simulation-driven testing: the entire system runs deterministically inside a single process, and the test harness injects faults until correctness violations surface. We dedicate a section to this approach.

**ScyllaDB** (ScyllaDB Inc). A C++ rewrite of Cassandra using the Seastar framework, a shared-nothing thread-per-core runtime with futures and continuations. ScyllaDB regularly delivers 10x the throughput of Cassandra on the same hardware.

**ClickHouse Keeper** (ClickHouse Inc). A C++ reimplementation of ZooKeeper's coordination protocol, replacing the Java original. Demonstrates that Raft + a deterministic state machine can be packaged as a drop-in replacement for an entrenched coordination service.

**etcd-cpp-apiv3** and **etcd-cpp-api**. Client libraries for talking to etcd from C++ services. The server itself is in Go, but every C++ service running in a Kubernetes cluster talks to it.

**brpc** (Apache, originated at Baidu). The most production-hardened C++ RPC framework outside Google. Powers tens of millions of QPS at Baidu and is a sane alternative to gRPC when you need deterministic latency. Ships with a built-in distributed counter, a built-in name service plugin, and the **braft** library for Raft consensus.

**RethinkDB**. A C++ document database with realtime push queries. Now community-maintained but historically a clean reference for how to structure a sharded, replicated database in modern C++.

**Apache Kudu**. A columnar store with Raft replication, written in C++ at Cloudera. The Kudu codebase is one of the cleanest production references for Raft in C++.

## Google's Distributed Stack

Most of Google's foundational distributed services are C++. An L5+ candidate is expected to have a working mental model of each.

**Chubby**. A coarse-grained lock service. Few clients, high availability, lease-based locks. Underpins GFS master election, Bigtable tablet assignment, and DNS-like name resolution inside Google. The original paper by Mike Burrows is required reading.

**GFS / Colossus**. The append-mostly distributed file system that birthed HDFS. Colossus is the modern successor rewrite, with smaller chunk sizes, Reed-Solomon erasure coding, and a distributed metadata layer (the original GFS had a single master).

**Bigtable**. A sparse, distributed, persistent multi-dimensional sorted map. Tablets are served by tablet servers, with a master coordinating splits and merges through Chubby. The on-disk format (SSTable) and in-memory format (memtable) are the direct ancestors of LevelDB and RocksDB.

**Spanner**. A globally distributed, externally consistent database. Combines Paxos for replication, two-phase commit for cross-shard transactions, and TrueTime (a hardware-assisted clock with bounded uncertainty) for serializable timestamp ordering. We dissect Spanner's architecture in chapter 15 of this section.

**Borg / Omega / Kubernetes ancestor**. Cluster manager. The Borg paper describes how Google schedules millions of jobs across hundreds of thousands of machines. Kubernetes is its open-source spiritual descendant.

**Stubby**. The internal RPC framework that became gRPC after sufficient scrubbing for open-source release. Stubby has features gRPC does not: automatic load balancing through a service mesh, deadline propagation tied into the global tracing system, and integration with Google's auth and quota services.

## What This Chapter Covers

The chapter has 25 sections. The first six establish the theoretical and engineering foundation: fallacies, RPC, clocks, causality. Sections seven through eleven cover consensus and replication in depth: Raft, Paxos, leases, replicated state machines, CRDTs. Sections twelve through sixteen cover the membership and storage layer: gossip, transactions, sharding, quorums, Google's stack, and Bigtable-style storage. The final group covers production engineering: simulation testing, load balancing, rate limiting, distributed locks, an end-to-end KV store design, interview questions, and exercises.

Every code example is real production C++23. Every architectural claim is sourced from a paper or a deployed system. By the end of the chapter, you will be able to design and build a distributed service that holds correctness invariants under partition, recover gracefully from the eight fallacies, and pass a staff-level distributed systems design interview at any FAANG.

**Junior at FAANG**: focus on the fallacies, RPC, clocks, Raft, gossip, and the KV store design. These are the topics on senior promotion packets.

**Senior at FAANG**: every section. The Paxos, FoundationDB simulation, Spanner deep-dive, and CRDT sections are the differentiators between L5 and L6.

---
