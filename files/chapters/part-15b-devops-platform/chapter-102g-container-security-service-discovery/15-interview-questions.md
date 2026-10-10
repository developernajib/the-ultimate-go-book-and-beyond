## 102G.13 Interview Questions

**Q1: What is the container threat model? What are the main attack surfaces?**

Container security has 6 main attack surfaces: (1) **Image vulnerabilities** - outdated OS packages or app dependencies with CVEs (mitigate: Trivy scanning, minimal base images, regular rebuilds). (2) **Supply chain** - compromised base image or dependency (mitigate: image signing with Cosign, trusted registries, SBOM). (3) **Privilege escalation** - container running as root or with excessive capabilities (mitigate: runAsNonRoot, drop ALL capabilities, read-only filesystem). (4) **Container escape** - exploiting kernel syscall vulnerabilities to break out of container isolation (mitigate: seccomp, gVisor, avoid hostPath mounts). (5) **Lateral movement** - compromised container reaches other services (mitigate: network policies, mTLS, least-privilege service accounts). (6) **Secrets exposure** - credentials in environment variables, image layers, or container logs (mitigate: Secrets Manager, never COPY secrets into images).

---

**Q2: What is a distroless image and why is it more secure than alpine?**

Distroless images (from Google) contain only the application and its runtime dependencies - no shell, no package manager, no OS utilities. Alpine adds a minimal OS (~7MB) with a shell and package manager. Distroless: (1) smaller attack surface - no shell means no `bash` for attackers to execute. (2) no package manager - can't install additional tools after compromise. (3) smaller size (2-3MB base) - faster pulls. (4) fewer CVEs - OS utilities aren't present to have vulnerabilities. Trade-off: debugging is harder (no shell to exec into). Solution: use debug variant of distroless during development (`gcr.io/distroless/static-debian12:debug` has busybox shell). Production uses nonroot.

---

**Q3: What is seccomp and how does it improve container security?**

Seccomp (Secure Computing Mode) restricts which Linux kernel syscalls a process can make. A Go HTTP server needs maybe 50 syscalls out of 300+. Blocking the other 250 prevents exploitation of kernel vulnerabilities that require those syscalls. Kubernetes supports three seccomp modes: (1) `Unconfined` - no restrictions (default, don't use). (2) `RuntimeDefault` - Docker/containerd default profile, blocks ~300 risky syscalls. (3) `Localhost` - custom profile from node filesystem. Using `RuntimeDefault` adds negligible overhead and prevents exploitation of many kernel CVEs. Custom profiles (tighter) require profiling the application's syscall usage first - use `strace` or `perf` in staging.

---

**Q4: Explain the difference between client-side and server-side service discovery.**

Client-side: the service client queries the registry (Consul, etcd, Eureka) directly, gets a list of healthy instances, and chooses one using its own load balancing logic (round-robin, least-connections, consistent hashing). The client library handles registry communication, health filtering, and load balancing. Pro: client controls load balancing algorithm. Con: every language needs a registry client library. Server-side: the client sends requests to a well-known endpoint (DNS name, load balancer), and the routing infrastructure (DNS, HAProxy, Envoy) performs service lookup and load balancing. Pro: language-agnostic. Con: extra hop, proxy can be a bottleneck. In Kubernetes: server-side via CoreDNS + kube-proxy (ClusterIP services). Consul can do both: DNS interface (server-side) or API (client-side).

---

**Q5: What is SPIFFE and why is it important for zero-trust architectures?**

SPIFFE (Secure Production Identity Framework for Everyone) is an open standard for workload identity. It defines: (1) SPIFFE ID - a URI identifying a workload: `spiffe://trust-domain/path` (e.g., `spiffe://myorg.com/ns/production/sa/shopapp-api`). (2) SVID (SPIFFE Verifiable Identity Document) - a short-lived X.509 certificate or JWT containing the SPIFFE ID. (3) Workload API - how workloads obtain and renew SVIDs. SPIFFE enables zero-trust because: network location is irrelevant - authorization is based on verified cryptographic identity. A service in us-east-1 calling eu-west-1 presents its SVID. The remote service verifies it against the trust domain CA, not against IP allowlists. SPIRE is the reference implementation of SPIFFE.

---

**Q6: How does OPA/Gatekeeper enforce policies in Kubernetes?**

OPA (Open Policy Agent) is a general-purpose policy engine using the Rego policy language. Gatekeeper deploys OPA as an admission webhook. Policies are written as ConstraintTemplates (the policy logic in Rego) and Constraints (the specific rules applied to resource types). When a resource is created/updated: (1) Kubernetes API server calls Gatekeeper's webhook. (2) Gatekeeper evaluates the resource against all matching Constraints. (3) any Constraint violation causes the request to be denied with the violation message. Benefits over Go webhooks: declarative policy in Rego (no compilation), policies stored as Kubernetes resources (GitOps-compatible), audit mode shows existing violations without blocking new creates.

---

**Q7: What is the difference between image scanning and runtime security?**

Image scanning (Trivy, Snyk, Grype): analyzes container images before deployment, detecting known vulnerabilities (CVEs) in OS packages and application dependencies. It's a static analysis - finds what's wrong before it runs. Runtime security (Falco, eBPF-based agents): monitors running containers for suspicious behavior - unexpected network connections, file writes to sensitive paths, shell executions, privilege escalations. It's dynamic - detects attacks in progress. Both are necessary: image scanning prevents deploying known-vulnerable images. Runtime security detects zero-days, misconfigurations, and post-deployment attacks. Production-grade security requires both.

---

**Q8: How do you implement health checks for Consul service registration?**

Consul supports multiple health check types: (1) **HTTP**: Consul polls `GET /health` on your service every N seconds - 200 = passing, anything else = critical. (2) **TCP**: Consul opens a TCP connection to the port - connection success = passing. (3) **Script**: runs a command on the Consul agent node - exit 0 = passing (requires shell access, avoid in containers). (4) **TTL**: service must call `consul/v1/agent/check/pass/service:id` within TTL - service does its own health logic and reports. (5) **gRPC**: for gRPC health protocol. Best practice: use HTTP health check that verifies the app is actually healthy (database connected, critical dependencies available) - not just that the process is running. Set `DeregisterCriticalServiceAfter` to prevent accumulation of dead instances.

---

**Q9: What are Kubernetes service accounts and how do they relate to cloud IAM?**

Kubernetes service accounts are identities for pods - a pod uses its service account to authenticate to the Kubernetes API. By default, every pod gets the `default` service account with minimal permissions. Best practice: create per-service service accounts with minimal RBAC. For cloud access: IRSA (IAM Roles for Service Accounts) on AWS links a Kubernetes service account to an AWS IAM role via OIDC federation. The pod gets temporary AWS credentials scoped to the IAM role, without needing static access keys. This enables: Go services to call AWS APIs (S3, DynamoDB, SQS) using `aws.NewConfig()` with no credentials hardcoded - the AWS SDK automatically uses the projected service account token. GKE has Workload Identity (similar mechanism). This is the correct way to give pods cloud permissions in 2026.

---

**Q10: How would you design a zero-trust network for 100 microservices?**

Zero-trust for 100 microservices: (1) **Identity**: deploy SPIRE for SVID issuance, configure each service with its own SPIFFE ID tied to Kubernetes service account. (2) **mTLS everywhere**: all service-to-service calls use mTLS with SPIRE-issued certificates. Use Istio ambient mesh or Cilium to handle mTLS at the infrastructure level (no code changes needed). (3) **Authorization policies**: define which services can call which - Istio AuthorizationPolicy or Cilium NetworkPolicy using SPIFFE identity (not IP). (4) **Network policies**: default-deny-all NetworkPolicy per namespace, explicit allow per service pair. (5) **Secrets**: External Secrets Operator + vault, never static credentials. (6) **Runtime monitoring**: Falco for anomaly detection, eBPF-based network monitoring with Hubble. The key: make zero-trust the default. New services get zero network access until policies are explicitly defined.

---

**Q11: Explain the difference between Consul's service mesh and just using Consul for service discovery.**

Consul service discovery: services register themselves with health checks, clients query the Consul API or DNS to find instances. Just discovery - no traffic management. Consul service mesh (Connect): adds a sidecar proxy (Envoy) to each service that handles mTLS, traffic management, observability, and authorization. With Connect: (1) mTLS is automatic between all services. (2) intentions define which services can communicate (policy-as-code). (3) traffic metrics per service pair. (4) circuit breaking and retries at the proxy level. Cost: Envoy sidecar adds ~50MB memory and 1-2ms latency per hop. For 100 services, this is usually worth it. For latency-critical paths, Cilium eBPF provides similar features with significantly lower overhead.

---

**Q12: What is SBOM and why does it matter for container security?**

SBOM (Software Bill of Materials) is a machine-readable inventory of all components in a software artifact - including OS packages, language libraries, and their versions and licenses. For containers: the SBOM lists every package in the image layer. Why it matters: (1) vulnerability response - when a new CVE is published (e.g., CVE-2021-44228 Log4Shell), you can query your SBOM database to find all images containing log4j in seconds, rather than scanning everything. (2) license compliance - identify copyleft licenses (GPL) that may impose obligations. (3) supply chain audit - prove what's in production for compliance. (4) air-gapped environments - know exactly what to mirror. Generate: `syft image:tag -o cyclonedx-json` or `docker sbom image:tag`. Attach SBOM as image attestation with Cosign.

---

**Q13: How do you handle certificate rotation for mTLS in production?**

SPIRE handles this automatically: SVIDs have short TTLs (1 hour by default). The SPIRE agent renews certificates before expiry and notifies the workload via the Workload API. Go applications using `go-spiffe/v2` automatically receive new certificates without restart - the `X509Source` watches for updates and rotates the TLS config in the running server. For manual certificate management (not SPIRE): (1) use cert-manager in Kubernetes for automatic Let's Encrypt or internal CA certificate renewal. (2) Go's `crypto/tls` can reload certificates without restart using `GetCertificate` and `GetClientCertificate` callbacks that read fresh certificates on each TLS handshake. (3) monitor certificate expiry as a metric (`ssl_certificate_expiry_seconds`) and alert at 14 days remaining.

---

**Q14: What is a Kubernetes admission controller and how is it different from a network policy?**

Admission controllers intercept API requests to create/update/delete Kubernetes objects BEFORE they're stored in etcd. They can validate (reject invalid configs) or mutate (add labels, inject sidecars). They work at the control plane level - you never see the rejected requests in the cluster. Network policies work at the data plane level - they allow or block network traffic between running pods. An admission controller can prevent a pod from being CREATED without required security context. A network policy prevents that running pod from CONNECTING to unauthorized services. Use both: admission webhooks for shift-left security (catch at deploy time), network policies for runtime isolation.

---

**Q15: How does Falco detect runtime security incidents?**

Falco is a CNCF runtime security tool that uses eBPF (or kernel modules) to monitor Linux system calls made by containers in real-time. It compares observed behavior against a rules engine: if a container suddenly executes a shell (`bash` or `sh`), writes to `/etc`, makes an outbound connection on an unexpected port, or reads SSH keys - Falco fires an alert. Falco outputs to: stdout (for Kubernetes log aggregation), gRPC (for real-time alerting), Slack/PagerDuty (via Falco Sidekick). Key rules for Go services: shell spawned in container (possible RCE), write to sensitive directory (persistence attempt), unexpected network connection (C2 communication), container reading cloud metadata endpoint (credential theft). Alert on CRITICAL severity - investigate within minutes.

---

### Junior → FAANG: Using These Questions as a Study Framework

These 15 questions cover the full scope of what a senior-track interview tests in this domain. The study approach that works: for each question, practice the answer out loud (not just in your head), time yourself (a good answer takes 90-120 seconds, not 30 seconds and not 5 minutes), and end each answer with a trade-off or failure mode you are aware of. That last step is the signal that you have operated these systems, not just read about them.

The questions most likely to appear at mid-level screens (L4/L5) are Q1, Q2, Q3, Q4, and Q7. These test foundational understanding. The questions that appear at senior screens (L5/L6) are Q5, Q6, Q10, Q13, and Q14. These test system design and operational depth.

First-job preparation: before any interview involving Kubernetes security, be able to whiteboard the answer to Q10 (zero-trust for 100 microservices) in 5 minutes. That question touches every component in this chapter and tests whether you can compose them into a coherent system rather than reciting isolated facts.

Prerequisite gap: Q9 (Kubernetes service accounts and cloud IAM) is frequently underestimated. Engineers who have used AWS but not IRSA often answer "we use an IAM user with an access key in a Kubernetes Secret." That answer is a red flag in any senior interview. Know IRSA and Workload Identity by name and be able to explain why they are superior to static credentials.

### Senior @ FAANG: What Bar-Raisers Test Beyond These Questions

At the L6 bar-raiser level, these 15 questions are baseline. The follow-up questions test operational judgment and organizational thinking, not just technical knowledge.

After Q1 (threat model), a bar-raiser asks: "how do you keep the threat model current as the system evolves?" The expected answer describes a process: threat model review as part of design review, a threat model owner for each service, and a quarterly audit against current CVE and attack pattern databases. Candidates who answer "we update the document when the system changes" are describing a process that does not exist in practice.

After Q6 (OPA/Gatekeeper), a bar-raiser asks: "what is your policy testing strategy?" The expected answer covers: unit testing Rego with `opa test`, integration testing constraints with `gator test`, canary deployment in warn mode before deny mode, and a rollback plan if a policy change breaks existing workloads. Candidates who answer "we test it by applying it and seeing if it works" have not owned a policy system in production.

After Q10 (zero-trust for 100 services), a bar-raiser asks: "walk me through the migration from the current state (no mTLS) to the target state (mTLS everywhere)." The expected answer describes the migration in phases: permissive mode (log but do not enforce), per-namespace rollout starting with new services, gradual migration of existing services with traffic shadowing, enforcement mode after all services are migrated, and a rollback procedure. Candidates who describe the target state without the migration path have not migrated a production system.

The meta-pattern in bar-raiser follow-ups: every technical answer is followed by a question about operational lifecycle (how do you keep this working over time), organizational scale (how do you enforce this across 200 teams), and failure modes (what happens when this component is unavailable). Preparing for those follow-ups is what distinguishes L6 candidates from L5 candidates who know the technology.

