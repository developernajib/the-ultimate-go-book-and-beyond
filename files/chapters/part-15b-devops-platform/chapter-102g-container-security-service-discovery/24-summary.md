## Summary

Container security and service discovery form the operational backbone of modern cloud-native architectures. Security in containerized environments cannot be retrofitted as an afterthought; it must be implemented as a continuous, defense-in-depth pipeline extending from developer source control and build pipelines through admission control, runtime kernel sandboxing, and service-to-service communication.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  End-to-End Container Security & Discovery               │
└──────────────────────────────────────────────────────────────────────────┘

  Supply Chain & Build             Admission & Policy          Runtime & Discovery
  ┌─────────────────────────┐     ┌──────────────────────┐    ┌────────────────────────┐
  │ • Multi-stage Go builds │     │ • OPA / Gatekeeper   │    │ • Seccomp & AppArmor   │
  │ • Distroless nonroot    │ ──> │ • Cosign signature   │──> │ • Falco + eBPF alerts  │
  │ • Trivy / Grype scans   │     │   validation webhook │    │ • Consul / etcd lease  │
  │ • SLSA provenance       │     │ • PSS Restricted     │    │ • SPIRE mTLS identity  │
  └─────────────────────────┘     └──────────────────────┘    └────────────────────────┘
```

---

### Core Architectural Pillars

1. **Supply Chain Security & Image Hardening (102G.1-102G.3, 102G.17)**:
   - **Distroless Nonroot**: Eliminating package managers, shells, and system utilities from production runtime images reduces both the static CVE attack surface and post-exploitation utility for attackers.
   - **Cryptographic Provenance**: SLSA Level 3 build environments and Sigstore Cosign keyless signatures guarantee that only trusted, un-tampered binaries produced by verified CI workflows reach production clusters.
   - **Continuous Vulnerability Lifecycle**: Static scanning at build time (Trivy, Grype) must be coupled with continuous registry rescanning to catch newly disclosed CVEs against running containers.

2. **Runtime Isolation & Behavioral Detection (102G.4, 102G.16)**:
   - **Kernel Sandboxing**: The `RuntimeDefault` seccomp profile disables hundreds of non-essential syscalls, neutralizing entire classes of kernel privilege escalation and container escape exploits.
   - **Restricted Pod Security Standards**: Enforcing `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and `capabilities.drop: [ALL]` leaves minimal writable surfaces.
   - **eBPF-Driven Observability**: Falco inspects kernel syscall events in real time to catch anomalous behaviors - such as unexpected process spawns, shell execution, or outbound mining connections - and triggers automated pod quarantine via Kubernetes network policies.

3. **Policy-as-Code & Admission Governance (102G.5)**:
   - **Declarative Enforcement**: OPA/Gatekeeper `ConstraintTemplate` and `Constraint` resources evaluate incoming workloads before scheduling, preventing non-compliant pod specifications from ever entering etcd.
   - **In-Process Go Evaluation**: The `rego.PreparedEvalQuery` pattern allows Go microservices and custom admission webhooks to evaluate complex Rego policies with sub-millisecond evaluation latency.

4. **Service Discovery & Resilient Routing (102G.6-102G.9, 102G.18)**:
   - **Dynamic Registration**: Consul health checks and etcd lease-backed keepalive heartbeats maintain a consistent view of live endpoints across dynamic pod lifecycles, immediately deregistering instances upon graceful `SIGTERM` shutdown.
   - **Discovery Mechanics**: Client-side discovery provides direct control over load balancing algorithms (round-robin, least-connections) and connection pooling, while Kubernetes CoreDNS SRV records provide a standardized, language-agnostic foundation.
   - **Probe Alignment**: Segregating `/healthz` (liveness), `/readyz` (readiness with dependency checks), and `/startupz` prevents catastrophic restart loops during initialization or downstream degradation.

5. **Zero-Trust Microservices & Workload Identity (102G.10)**:
   - **Cryptographic Identity**: SPIFFE IDs (`spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>`) replace IP-based network assumptions with verifiable cryptographic credentials.
   - **Automated mTLS**: SPIRE agents provide automatic, zero-downtime certificate rotation directly via the local Unix Workload API socket.
   - **Zero-Trust Middleware**: Enforcing peer SPIFFE validation at the application layer guarantees mutual authentication and granular authorization across multi-cluster and hybrid cloud boundaries.

---

### Key Takeaways for Senior & Staff Engineers

- **Defense in Depth**: No individual security control is self-sufficient. Build-time image scanning misses zero-days; runtime detection misses misconfigurations; network firewalls miss compromised internal pods. True resilience arises from composed layers with non-overlapping gap profiles.
- **Platform Golden Paths**: Security policies that rely on manual developer compliance fail at scale. Platform teams must encode security baselines into golden base images, reusable CI workflows, and cluster-wide admission webhooks.
- **Operational Reality**: High-availability security controls require safe operational patterns: break-glass bypasses with structured audit logs, permissive-to-strict mTLS rollout sequences, and graceful deregistration routines to guarantee zero dropped requests during rolling updates.

---

### Navigation

- **Previous Chapter**: [Chapter 102F - Platform Engineering & Internal Developer Platforms](../chapter-102f-platform-engineering/00-introduction.md)
- **Next Chapter**: [Chapter 102O - Monorepo Build Systems & Remote Caching](../chapter-102o-monorepo-build-systems/00-introduction.md)
