## 102E.11 Mid-Chapter Synthesis: Core Architecture Recap

Advanced Kubernetes and Helm patterns are what separate teams that "run containers" from teams that run reliable, secure, and cost-efficient production workloads. The patterns in this chapter - Helm for packaging, CRDs and operators for extending Kubernetes, admission webhooks for enforcing policies, KEDA for event-driven scaling, network policies for zero-trust networking, and resource management for multi-tenancy - form the foundation of mature Kubernetes platforms.

**The platform engineering mindset**: The goal is to make the right thing the easy thing. Admission webhooks inject observability automatically, LimitRanges prevent resource accidents, golden Helm charts spread best practices to all services. Teams shouldn't have to think about security contexts, resource limits, or PDBs - the platform should enforce them.

**Key takeaways for FAANG interviews**:
1. HPA scales pods based on metrics. KEDA adds event-driven scaling and scale-to-zero for batch/async workloads
2. Admission webhooks are the enforcement layer for platform standards - mutating for defaults, validating for policies
3. Network policies implement zero-trust: default-deny-all, then explicit allow rules per service
4. CRDs + operators encode operational knowledge (backup, failover, scaling) into software - the operator pattern
5. Pod topology spread constraints are critical for HA - ensure replicas are distributed across AZs, not all on one node

### Junior → FAANG: From Kubernetes User to Platform Contributor

The summary's framing of "make the right thing the easy thing" is the most important mental model in this chapter for career growth. It shifts your perspective from "I deploy my service to Kubernetes" to "I shape the environment in which everyone deploys services." That shift is what the move from application engineer to platform engineer looks like in practice.

For interview preparation, use this summary's takeaway list as a self-assessment. For each item, ask: can I explain it without notes, can I implement a minimal version, and can I describe a failure mode or production incident it prevents? The HPA vs KEDA distinction, the mutating vs validating webhook order, and the operator pattern are the three most frequently tested concepts in Kubernetes platform interviews at FAANG-tier companies.

The phrase "CRDs and operators encode operational knowledge into software" deserves deliberate practice. Be able to give a concrete example of operational knowledge that would otherwise live in a human runbook and explain how a reconcile loop implements it. Database failover is the canonical example: the operator watches replication lag, detects a stalled primary, promotes a replica, and updates the service endpoint. That sequence, done reliably and idempotently, is what the operator pattern makes possible.

### Senior @ FAANG: Platform Maturity as an Organizational Capability

The platform engineering mindset described in this summary is not a one-time build. It is an ongoing capability that a team maintains, evolves, and governs over years. At L6/L7, the summary's topics each have a maturity dimension: not just "do we have admission webhooks" but "are our webhooks monitored, load-tested, documented with failure mode ADRs, and covered by runbooks that on-call engineers know how to use."

The operator pattern deserves particular attention at the staff level. Writing an operator is an investment in encoding operational knowledge that previously required experienced human judgment. That investment only pays off if the operator is tested at the failure modes that would previously require human intervention: what happens when the StatefulSet's PVC fills up, when the primary pod is killed during a write operation, when the backup job times out. The test coverage of an operator's failure handling is a better measure of its production-readiness than whether it deploys successfully in a happy-path scenario.

The staff-level synthesis across all five takeaways: each one represents a different axis of platform quality. Scaling (HPA and KEDA) covers the efficiency axis. Admission webhooks cover the policy and security axis. Network policies cover the isolation and blast-radius axis. CRDs and operators cover the abstraction and operational leverage axis. Pod topology spread constraints cover the reliability and SLO axis. A platform that excels on all five axes is materially safer, cheaper, and more reliable than one that handles only two or three. The staff engineer's job is to drive progress on all five simultaneously, not to optimize one at the expense of others.

---
