# Chapter 102G: Container Security & Service Discovery

*"Security is not a product, but a process - and in containers, that process starts at the image and ends at the runtime."* - Bruce Schneier (adapted)

The shift to containerized microservices fundamentally changed the attack surface of production systems. Where a monolith had one deployment artifact and a handful of network endpoints, a modern Kubernetes cluster has hundreds of container images - each a potential vector for a compromised base image, a vulnerable OS package, or an overly permissive seccomp profile. The 2020 SolarWinds attack and numerous Kubernetes-specific CVEs demonstrated that supply chain security and runtime hardening are not theoretical concerns. They are operational requirements for any system handling sensitive data or running at scale.

Alongside security, reliable service-to-service communication is the other foundational concern of microservice architectures. In a dynamically scheduled environment where pod IP addresses change on every restart and services scale horizontally, hardcoded endpoints are a liability. Service discovery - whether through Consul health checks, etcd lease-based registration, or Kubernetes DNS - is what lets services find each other without human intervention, and zero-trust mTLS with SPIFFE/SPIRE workload identities is what ensures those connections remain authenticated and encrypted without relying on network perimeter assumptions.

This chapter covers the full container security stack - from image scanning and distroless builds through runtime seccomp/AppArmor profiles and OPA policy enforcement - and then builds a complete service discovery and zero-trust communication layer in Go using Consul, etcd, and SPIFFE/SPIRE.

**What you'll learn in this chapter:**
- Container threat modeling: the attack surface from source code through image build, registry storage, and runtime execution
- Image security: Trivy scanning in CI pipelines, distroless and scratch-based images, multi-stage build optimization, and Notary signing
- Runtime hardening: seccomp profiles (RuntimeDefault and custom), AppArmor policies, rootless container execution, and Linux capability dropping
- Kubernetes Pod Security Standards: enforcing restricted profiles with runAsNonRoot, readOnlyRootFilesystem, and privilege escalation prevention
- Policy-as-code with OPA/Gatekeeper: writing constraint templates in Rego and integrating policy validation into Go services
- Service discovery patterns: client-side vs. Server-side discovery, Consul service registration and health checks, etcd lease-based registration
- Kubernetes DNS-based service discovery: CoreDNS, headless services, SRV records, and DNS-aware load balancing in Go
- Zero-trust microservice communication: SPIFFE/SPIRE workload identity issuance, mTLS configuration, and certificate rotation in Go services

**Why this matters at scale:**
Cloudflare's zero-trust network and Google's BeyondCorp model both rely on workload identity and mTLS rather than network perimeter trust - a pattern that has become the baseline security posture for any organization running microservices after high-profile Kubernetes cluster compromises demonstrated the cost of implicit trust.

**Prerequisites:** Chapter 97 (Docker), Chapter 98 (Kubernetes), Chapter 102C (Terraform & IaC), Chapter 102D (GitOps), Chapter 102E (Helm & Kubernetes Advanced), Chapter 102F (Platform Engineering)

---

### Junior → FAANG: Understanding Why Container Security Is a First-Class Concern

New engineers often treat container security as an ops problem to solve after code ships. FAANG interviewers test whether you understand that the attack surface begins at the Dockerfile, not at the firewall.

The prerequisite gap most juniors have: they know containers isolate processes but do not know that isolation is not security. A container running as root with no seccomp profile and a public base image full of unpatched CVEs is a breach waiting to happen. The distinction between image security, runtime security, and network security is something you need to be able to articulate clearly in a system design interview.

Entry-point framing for interviews: when asked "how would you secure a microservice deployment," start with the image supply chain (where does the base image come from, who scans it), then runtime posture (what capabilities does the container need), then network posture (does every service need to talk to every other service). That top-to-bottom framing signals structured thinking.

First-job habit: before shipping any Dockerfile, run `trivy image` locally. Make it part of your personal definition of done before opening a pull request. This habit, once internalized, is what interviewers mean when they ask about "security culture."

### Senior @ FAANG: Platform Thinking and the Container Security Governance Gap

At the L6/L7 level, container security is not something you implement once for one service. It is a platform problem: how do you ensure that every team in the organization is running containers that meet a baseline security posture, without creating a bottleneck where every Dockerfile needs a manual security review?

The governance pattern that scales is policy-as-code at the admission control layer. OPA/Gatekeeper constraint templates applied at the Kubernetes API server mean that a non-compliant pod spec is rejected before it ever reaches a node. The platform team authors and owns the constraint library. Product teams operate within those constraints without needing to understand the underlying Rego. This is the separation of concerns that makes security scale across hundreds of service teams.

An Architecture Decision Record for this domain needs to address: which pod security standards apply to which namespaces (privileged for system components, restricted for product workloads), how exceptions are granted and tracked, and what the escalation path is when a team claims a security control breaks their workload.

Bar-raiser signal in interviews: candidates who understand that security controls create operational friction and who can articulate how to minimize that friction through automation (golden path Dockerfiles, pre-built compliant base images, automated CVE triage) demonstrate staff-level judgment. The question is never "should we have security controls" but "how do we make secure the path of least resistance."

The zero-trust component intersects with identity governance. SPIFFE/SPIRE workload identities need to be issued by an authority the organization trusts, rotated automatically, and tied to an audit trail. At scale, this means the SPIRE server cluster is itself a critical infrastructure component requiring high availability, backup, and a break-glass procedure for when certificate issuance fails. A senior engineer presenting this architecture needs to address the failure modes of the trust anchor, not just the happy path.

Service discovery at scale also has a governance dimension. When you have hundreds of services, the service registry becomes a source of truth for the entire dependency graph. Changes to that registry (a service deregistering, a health check failing, a DNS TTL change) can cascade. Platform engineers own the observability layer that lets teams understand these cascades, and they own the runbooks that define how to respond. That is the difference between building a feature and owning a platform.
