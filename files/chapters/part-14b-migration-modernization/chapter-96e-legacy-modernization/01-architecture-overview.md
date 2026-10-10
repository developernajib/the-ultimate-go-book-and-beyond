## Architecture Overview

Before diving into code, it helps to see how all the moving pieces fit together. The diagram below shows the complete legacy modernization architecture, from the client request entering the Strangler Fig proxy all the way down to the dual-write coordinator and shadow mode test runner. Each component in this diagram corresponds to a section later in the chapter, so refer back to this overview whenever you need to understand how a particular piece connects to the rest of the system.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                     LEGACY MODERNIZATION ARCHITECTURE                         │
│                                                                               │
│  ┌──────────┐    ┌─────────────────────────────────────────────────────┐      │
│  │ Clients  │───►│           Strangler Fig Proxy (Go)                  │      │
│  └──────────┘    │  ┌─────────────┐         ┌─────────────────────┐    │      │
│                  │  │ Feature Flag│         │  Traffic Router     │    │      │
│                  │  │   Engine    │────────►│  (weighted split)   │    │      │
│                  │  └─────────────┘         └──────────┬──────────┘    │      │
│                  └─────────────────────────────────────┼───────────────┘      │
│                                                         │                     │
│                          ┌──────────────────────────────┤                     │
│                          │                              │                     │
│                    ┌─────▼──────┐               ┌──────▼──────┐               │
│                    │   Legacy   │               │   New Go    │               │
│                    │  Service   │               │   Service   │               │
│                    │  (Python/  │               │  (Modern)   │               │
│                    │   Java)    │               │             │               │
│                    └─────┬──────┘               └──────┬──────┘               │
│                          │                              │                     │
│                    ┌─────▼──────┐               ┌──────▼──────┐               │
│                    │  Legacy DB │               │   New DB    │               │
│                    │ (MySQL 5.7)│               │ (Postgres)  │               │
│                    └─────┬──────┘               └──────┬──────┘               │
│                          │                              │                     │
│                    ┌─────▼──────────────────────────────▼──────┐              │
│                    │         Dual-Write Coordinator              │            │
│                    │   ┌──────────────┐  ┌───────────────────┐  │             │
│                    │   │ Write to Old │  │  Write to New     │  │             │
│                    │   │  (Primary)   │  │  (Async/Shadow)   │  │             │
│                    │   └──────────────┘  └───────────────────┘  │             │
│                    └────────────────────────────────────────────┘             │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │                    Shadow Mode Test Runner                          │      │
│  │  Production Request ──► Legacy (primary response)                   │      │
│  │                    ──► New Service (shadow, compare & log diffs)    │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐     │
│  │                     Migration Metrics Dashboard                      │     │
│  │  [Traffic Split %] [Error Rate Delta] [Latency P99] [Data Divergence]│     │
│  └──────────────────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams as a Learning Tool

This architecture diagram is the most important single artifact in the chapter because it shows how all the components relate before you see any implementation code. Early-career engineers often skip architecture diagrams and go directly to the code. This is backwards: understanding the component relationships and data flow first makes every implementation detail more comprehensible because you know what it is for and what it connects to.

Practice reading architecture diagrams by describing them verbally before reading the implementation. For this diagram specifically: trace a single request from client entry to response, naming each component it passes through and what decision each component makes. Then trace what happens if the feature flag routes the request to the new service instead of the legacy service. Then trace what happens in shadow mode when the new service produces a different response than the legacy service. Each trace reveals a different aspect of the system's behavior.

For Go engineers specifically: the architecture diagram shows component boundaries that should correspond directly to package boundaries in the implementation. The strangler fig proxy is a separate package from the feature flag engine, which is separate from the shadow mode tester. Recognizing this alignment between architecture diagrams and package structure is an idiom of well-designed Go codebases.

### Senior @ FAANG: Architecture Review at Senior Level and the Failure Mode Analysis

At senior level, the primary value of an architecture overview diagram is not understanding what the system does but understanding what can go wrong. The diagram reveals the failure modes: which component's failure affects the widest blast radius, which data flows have no fallback path, and which components are potential single points of failure.

For this architecture: the feature flag store is the highest-risk component in the diagram. If the flag store is unavailable, the proxy cannot make routing decisions. The correct behavior (fail open to legacy, fail closed to new service) needs to be an explicit design decision documented in the ADR, not an implicit behavior discovered during an incident. Senior engineers reviewing this architecture would ask: what is the flag store's read availability guarantee, what is the behavior when a flag check times out, and how is the flag store's health monitored independently of the proxy's health?

The governance practice for architecture review at senior level: create a separate failure mode analysis document alongside the architecture diagram. For each component, document the failure modes, the expected behavior under each failure mode, and the monitoring that detects each failure mode. This document is the runtime governance artifact that the architecture diagram alone cannot provide.

---
