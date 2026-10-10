# Capstone Project 7: Production-Grade CI/CD Platform

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Production-ready, distributed CI/CD pipeline orchestration engine
**Tech Stack**: Go 1.27+, Docker Engine API, gRPC, PostgreSQL, Redis, Prometheus, WebSockets

---

### Project Overview & Architecture

Continuous Integration and Continuous Deployment (CI/CD) platforms are the backbone of modern software engineering productivity. Building a distributed build system requires solving rigorous systems problems: parsing and validating arbitrary Directed Acyclic Graphs (DAGs) of pipeline tasks, scheduling workloads fairly across ephemeral worker nodes, executing untrusted code securely inside isolated container sandboxes, and multiplexing real-time build logs to thousands of connected clients.

In this capstone project, you will build a scalable, production-grade CI/CD Platform in Go. The architecture features a central Control Plane server that orchestrates pipeline state, a distributed Worker Pool that executes job steps inside isolated Docker containers via the Docker Engine API, and a real-time WebSocket log streaming pipeline.

```
┌──────────────────────────────────────────────────────────────┐
│                    Developer / Git Webhook                   │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP / Webhook Trigger
                               ▼
┌──────────────────────────────────────────────────────────────┐
│               CI/CD Control Plane Coordinator                │
│                                                              │
│   ├─ 1. Pipeline YAML Parser & DAG Dependency Validator      │
│   ├─ 2. Job Queue & Priority Fair Scheduler                  │
│   ├─ 3. State Management (PostgreSQL & Redis Locks)          │
│   └─ 4. Real-time Log Hub (WebSocket Multiplexer)            │
└──────┬───────────────────────────────────────────────┬───────┘
       │ gRPC Dispatch                                 │ gRPC Dispatch
       ▼                                               ▼
┌──────────────────────────────┐       ┌──────────────────────────────┐
│        Worker Node 1         │       │        Worker Node 2         │
│                              │       │                              │
│   ├─ Ephemeral Container Pool│       │   ├─ Ephemeral Container Pool│
│   ├─ Docker Engine API Client│       │   ├─ Docker Engine API Client│
│   └─ Streaming Log Forwarder │       │   └─ Streaming Log Forwarder │
└──────────────────────────────┘       └──────────────────────────────┘
```

### What You Will Build and Learn Across Sections

Throughout this project, you will build each layer of the platform step-by-step:

- **Part 1 & 2 (Architecture & Foundation)**: Define the pipeline schema, design the control plane architecture, and configure database models for pipelines, stages, and jobs.
- **Part 3 (Pipeline DAG Parser & Engine)**: Build a Directed Acyclic Graph (DAG) validator using topological sort to detect cyclic dependencies and determine parallelizable job execution waves.
- **Part 4 (Distributed Worker Pool & gRPC)**: Implement a high-performance gRPC control protocol between the central coordinator and distributed worker daemons with heartbeat liveness probes.
- **Part 5 (Container Execution & Sandbox Isolation)**: Leverage the official Docker Go SDK to dynamically create isolated build containers, mount workspace volumes, stream exit codes, and enforce memory/CPU limits.
- **Part 6 (Real-Time WebSocket Log Streaming)**: Stream build output in real time from worker containers back to the coordinator, multiplexing ANSI escape codes and log buffers to web browser clients via WebSockets.
- **Part 7 (Artifact Caching & Workspace Storage)**: Implement an efficient artifact storage subsystem to preserve and transfer build outputs between dependent pipeline stages.
- **Part 8 & 9 (Metrics & Production Deployment)**: Instrument pipeline queues with Prometheus metrics (queue wait time, job execution duration, worker utilization) and package the platform for high availability.

---

### Junior → FAANG: Understanding CI/CD as a Systems Problem

Many junior engineers treat CI/CD as configuration glue around shell scripts. The prerequisite gap is understanding CI/CD as a distributed system with real guarantees: exactly-once job dispatch, durable state, and fair scheduling across tenant workloads. Entry-point interview framing: when asked "design a CI system," lead with the job queue, worker isolation model, and artifact storage before discussing YAML syntax.

First-job habit: every time you modify a pipeline definition, ask what happens when the worker crashes mid-job. If the answer is "the job silently disappears," that is a production bug, not a configuration choice.

### Senior @ FAANG: Platform Governance for CI/CD Infrastructure

A staff engineer owning a CI/CD platform must answer: "What is our blast-radius policy when a bad pipeline definition takes down shared workers?" That question drives three governance decisions. First, the tenancy model: shared workers with cgroup isolation versus per-team dedicated worker pools. The ADR should quantify cost versus isolation trade-off with concrete numbers (e.g., dedicated pools cost 3x but reduce cross-tenant incident correlation by 90%). Second, the scheduling contract: do teams get a hard concurrency quota or a soft priority queue? Hard quotas are predictable but wasteful during off-hours. Third, the secrets governance model: who can grant a pipeline access to production credentials, and what audit trail exists for that grant?

Maturity model for CI/CD platforms: level 1 is pipelines that run to completion, level 2 adds retry logic and artifact caching, level 3 adds tenant quotas and queue fairness, level 4 formalizes SLOs (P99 queue wait time, job success rate per team) with automated alerting. Bar-raiser signal at L6: candidate distinguishes between a CI platform that is operated and one that is governed. Governance means change management for the platform itself, deprecation policies for old runner images, and a review process before a team can add a privileged Docker socket mount.
