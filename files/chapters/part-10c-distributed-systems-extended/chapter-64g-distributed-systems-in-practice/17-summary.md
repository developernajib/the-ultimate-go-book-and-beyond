## Summary

Distributed systems theory provides the vocabulary, and production experience provides wisdom. The gap between the two is often closed only by incidents - the goal of this chapter is to let you learn from others' incidents rather than your own.

**CAP and PACELC** give you a framework for trade-offs. Every distributed data store makes these choices, and your job is to select the system that matches your consistency requirements per data type - not to apply the same system to everything.

**Debugging distributed systems** requires correlated observability from day one. Distributed tracing (OpenTelemetry), structured logging with correlation IDs, and HLC-based timestamps are not nice-to-haves - they're the tools you'll desperately want at 3am during an incident.

**Clock skew** is a subtle bug waiting to corrupt your causality reasoning. Wall clocks are for humans. HLC is for causal ordering. Add HLC to any system where you need to reason about "what happened before what" across service boundaries.

**Anti-patterns compound**: a distributed monolith + chatty services + missing circuit breakers + no backpressure = guaranteed cascading failure when any single component slows down. Address each layer independently.

**Famous failures teach reproducible lessons**: Amazon (capacity commands need minimum safeguards), Cloudflare (don't rely on external routing being correct), Facebook (management plane must be independent). These aren't exotic failure modes - they're fundamental distributed systems risks that every production system eventually faces.

**The design review checklist** is the most practical takeaway: run through it before shipping any distributed component, and you'll prevent the majority of distributed systems incidents before they happen.

### Junior → FAANG: Summary as a Study Guide

This summary paragraph maps directly to the five topic areas that FAANG distributed systems interviews cover. Use it as a study guide checklist: can you explain each bullet point without looking at the chapter, with a concrete example and the Go implementation approach?

For CAP and PACELC: practice the mapping exercise. Given any data type (session token, shopping cart, view counter, distributed lock), name the appropriate consistency model, the right database, and the observable consequence during a partition.

For debugging: be able to describe the four-phase approach (scope, timeline, root cause, verify) and name the specific Go tools (OpenTelemetry, slog, pprof) at each phase.

For clock skew: be able to explain why HLC is safe when wall clocks are not, and describe the `Now()` and `Update()` operations without reference to the code.

For anti-patterns: have a one-sentence description of each (distributed monolith, chatty service, missing timeout cascade, missing backpressure) and the fix for each.

For famous failures: know the one-sentence root cause and the one-sentence mitigation for each (Amazon S3: no minimum safeguard on capacity commands. Cloudflare BGP: external routing dependency. Facebook BGP: management plane self-dependency).

The design review checklist is the exam at the end of the chapter. If you can generate the checklist from memory, you understand the chapter.

### Senior @ FAANG: Summary as a Platform Investment Roadmap

Each topic in this summary represents a category of platform investment that, if made correctly, reduces the organization's distributed systems incident rate systematically rather than episodically.

**CAP/PACELC as a platform design constraint.** The platform investment is a service data dictionary: a standardized format for documenting the consistency model, partition behavior, and PACELC trade-off for each data type in each service. The dictionary is queryable, reviewed at promotion time, and updated when service behavior changes. It converts implicit consistency choices into explicit, auditable commitments.

**Observability as a platform capability.** The investment is a standardized observability stack with mandatory adoption: a shared trace propagation library in the HTTP/gRPC transport layer, a structured log schema with required fields, an HLC library in the shared SDK, and dashboards that are provisioned automatically for every service from a common template. The goal is that any engineer can on-call any service and have the same debugging experience, regardless of which team owns the service.

**Clock skew as a platform default.** The investment is integrating HLC into all event, message, and log schemas as the default timestamp field, with the wall clock timestamp retained as a display-only field. This makes causal ordering correct by default and makes post-mortem timeline reconstruction unambiguous.

**Anti-patterns as platform enforcement.** The investment is tooling: lint rules that catch missing timeouts and context.Background() misuse, deployment gates that check circuit breaker configuration, and static analysis that identifies synchronous call chains longer than three hops in the service dependency graph. Each tool converts a code review suggestion into a deployment gate.

**Incident pattern prevention as platform SLA.** The goal is that the platform makes cascading failures, thundering herds, and split-brain detectable and bounded before they affect users. This requires load shedding in the service mesh, request coalescing in the caching layer, and epoch-based fencing in the distributed lock service. Staff engineers design these platform capabilities with explicit SLAs: cascading failure detected and circuit-broken within N seconds, thundering herd absorbed with at most M% database load increase, split-brain prevented with zero false positives.

The summary of this chapter, at staff level, is a platform roadmap that converts each distributed systems best practice into a platform capability that scales across every team in the organization without requiring individual heroics.
