## Architecture Overview

Container security is not a single control but a layered defense-in-depth strategy that spans every stage of the software supply chain. From the moment source code is written to the instant a container process handles a live request. Each layer in the diagram below addresses a distinct threat model: supply chain attacks at build time, known CVEs at the image layer, policy violations at admission, and zero-day exploits at runtime. Understanding where each tool sits in this pipeline helps you reason about which vulnerabilities each control can and cannot catch.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                Container Security Layers                                 │
└──────────────────────────────────────────────────────────────────────────┘

  Supply Chain Security
  Source Code → Build → Image → Registry → Deploy → Runtime
     │            │       │         │          │         │
  SAST scan   Multi-stage Trivy   Notary    OPA/GK   Falco
  (gosec)     distroless  scan   signing   policy   runtime

  Runtime Security Stack
  ┌──────────────────────────────────────────────────────────────────┐
  │  Pod Security Standards (restricted)                             │
  │  ├── runAsNonRoot: true                                          │
  │  ├── readOnlyRootFilesystem: true                                │
  │  ├── allowPrivilegeEscalation: false                             │
  │  └── capabilities.drop: [ALL]                                    │
  │                                                                  │
  │  seccomp profile: RuntimeDefault (blocks 300+ syscalls)          │
  │  AppArmor profile: blocks file writes outside /tmp               │
  └──────────────────────────────────────────────────────────────────┘

  Service Discovery
  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
  │  Consul         │    │  etcd           │    │  Kubernetes DNS │
  │  Health checks  │    │  Lease-based    │    │  CoreDNS        │
  │  Service mesh   │    │  registration   │    │  SRV records    │
  └─────────────────┘    └─────────────────┘    └─────────────────┘

  Zero Trust
  ┌──────────────────────────────────────────────────────────────────┐
  │  SPIFFE/SPIRE → workload identity → mTLS between every service   │
  │  No implicit trust based on network location                     │
  └──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Reading Architecture Diagrams as Interview Preparation

Understanding this layered architecture is table stakes for any senior-track interview involving containers. The key skill is being able to trace a threat through the layers and identify which control stops it, and which controls are blind to it.

Example: a developer accidentally pins a base image that has a known RCE vulnerability in its OpenSSL version. Trivy scanning in CI catches this at the image layer before it reaches the registry. OPA/Gatekeeper does not catch it because Gatekeeper validates pod spec structure, not image CVEs. Falco at runtime would not catch it unless the vulnerability is exploited and triggers a suspicious syscall. This kind of tracing is what interviewers mean when they ask "tell me about defense in depth."

Prerequisite gap: many juniors conflate "the container is secure" with "we run as non-root." Non-root reduces privilege escalation risk but does nothing about a vulnerable library in the image or an overly permissive network policy. Being able to name what each control does and does not address is the distinction that gets you to mid-level.

First-job habit: when reviewing a Kubernetes manifest, mentally walk it through this diagram. Does the image come from a scanned registry? Does the pod spec enforce the restricted Pod Security Standard? Is there a network policy? Asking those questions in code review builds the habit that FAANG interviewers test in design rounds.

### Senior @ FAANG: Designing the Security Control Plane as a Platform Product

The architecture diagram here represents the technical controls. What it does not show is the organizational control plane: who owns each layer, how exceptions are tracked, how drift is detected, and how failures in one layer are compensated by adjacent layers.

At the staff level, the design question is not "which tools do we use" but "how do we build a system where security controls are enforced consistently across hundreds of teams without manual review at each step." The answer is a platform product: a golden path that gives teams compliant base images, pre-configured Helm chart defaults that enforce the restricted pod security standard, and a CI template that includes Trivy and SAST without teams needing to add them manually.

The ADR for this platform product needs to cover: how deviations from the golden path are approved (a formal exception process with a time-bounded waiver and a remediation deadline), how the exception inventory is tracked and reported to security leadership, and what the automated detection mechanism is for configurations that drift from the approved baseline after initial deployment.

The service discovery and zero-trust layer adds an operational complexity that requires its own governance. SPIFFE/SPIRE workload identities must be rotated on a schedule shorter than your threat model's dwell-time assumption. If your security team assesses that an attacker who gains a workload credential would need 24 hours to do meaningful damage, your certificate TTL should be well under 24 hours, and your rotation mechanism must be automated and monitored. A staff engineer proposing this architecture must also propose the alert: "certificate not rotated within expected window" must page someone.

Bar-raiser signal: candidates who can articulate what happens to service availability when the SPIRE server is unavailable (existing connections stay up because TLS is already established, new connections fail because no new certificates can be issued), and who can propose a mitigation (SPIRE server HA, longer TTLs with emergency rotation, circuit breakers at the client), demonstrate the operational depth that distinguishes L6 from L5 thinking.
