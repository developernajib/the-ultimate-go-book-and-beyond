## 102G.11 Company Case Studies

### Google - BeyondProd: Zero Trust for Services

Google's BeyondProd (published 2019) extends their BeyondCorp zero-trust model to production services. The core insight: network location provides no security guarantees in a cloud environment. A compromised VM inside the datacenter has the same network access as legitimate services.

**LOAS (Low Overhead Authentication Service)**: Google's internal predecessor to SPIFFE. Every service binary gets a service account identity signed by Google's internal CA. Service-to-service calls include the caller's service certificate. No service trusts another based on IP - only based on verified identity.

**The impact**: Google can freely move workloads between datacenters, clouds, and regions without changing security policy. A service in us-east can call a service in eu-west because the authorization is based on identity (what you are), not location (where you are). This is why Go services at Google can be deployed anywhere without firewall rule changes.

**Container security**: Google's published Binary Authorization model scans every image and gates deployment on attestations. Critical CVEs block deploys automatically. They run distroless images throughout (they invented distroless).

---

### Netflix - Container Security at Scale

Netflix runs 100,000+ containers across their microservices platform. Their container security evolved from "trust the network" to full zero-trust over 5 years.

**Image scanning evolution**: Netflix started with weekly batch scans (Clair), moved to per-push scanning (Trivy + custom plugins), and now run continuous scanning that re-evaluates images against newly discovered CVEs even after deployment. If a running image is found vulnerable, automated systems create JIRA tickets and, for critical CVEs, page the on-call engineer.

**Metatron - Netflix's SPIFFE**: Before SPIFFE was mature, Netflix built Metatron - short-lived X.509 certificates issued to each service based on their Spinnaker deployment identity. Metatron certificates are issued per-deploy (tied to a deployment ID), not per-IP. This enables: certificate rotation without service restart, audit trails for every service-to-service call, and automatic revocation on deployment rollback.

---

### Cloudflare - Zero-Trust Network Access (ZTNA)

Cloudflare uses their own product (Cloudflare Access / ZTNA) internally, and their Go microservices implement the same zero-trust principles they sell to customers.

**Service authentication**: Cloudflare's internal services use service tokens (short-lived JWT signed by their internal CA) for service-to-service authentication. Each service has a specific set of allowed callers defined as Access policy. Unknown callers are rejected regardless of network location.

**Container security practices**: All Cloudflare Go services run in distroless containers with read-only root filesystem. Seccomp profiles are generated automatically from their internal tooling that profiles each service's syscall usage in staging. Production seccomp profiles block all syscalls not observed in staging.

---

### Junior → FAANG: Mining Case Studies for Interview Narratives

These three case studies are not trivia. They are evidence that the patterns in this chapter are validated at production scale by some of the most sophisticated engineering organizations in the world. In an interview, referencing a specific real-world implementation anchors your answer in operational reality rather than theoretical architecture.

Key extractions for interviews: Google's BeyondProd demonstrates that identity-based authorization (what you are) is more reliable than location-based authorization (where you are). Netflix's evolution from weekly batch scanning to continuous scanning shows that a vulnerability management program matures incrementally, not overnight. Cloudflare's automatic seccomp profile generation from staging profiling is a concrete answer to the interview question "how do you maintain seccomp profiles as applications evolve."

Prerequisite gap: juniors often present security architecture as a binary (either you have mTLS or you do not). The Netflix timeline (5 years to migrate from "trust the network" to full zero trust) is important context: these migrations require incremental adoption paths, not flag-day cutovers. Being able to describe an incremental migration plan is what separates a candidate who understands operations from one who only understands architecture.

First-job habit: read Google's BeyondCorp and BeyondProd papers. They are publicly available and provide the conceptual foundation for zero-trust architecture that most FAANG-adjacent interview processes assume candidates are familiar with.

### Senior @ FAANG: Extracting Organizational Patterns, Not Just Technical Ones

The more important signal in these case studies is organizational, not technical. Google's LOAS predates SPIFFE by years, which means Google had to build and maintain a bespoke identity framework before the ecosystem provided a standard. Netflix built Metatron for the same reason. Both organizations eventually converged on or contributed to the SPIFFE standard once it matured. The lesson is: building bespoke solutions for problems that will eventually have ecosystem solutions creates long-term maintenance debt. The staff-level judgment is knowing when to build versus when to wait for the ecosystem.

The Cloudflare seccomp profile generation approach (profiling in staging, generating production profiles automatically) is the correct scaling solution for a large organization. Manual seccomp profile maintenance does not scale past 20 services. The investment is building the profiling tooling, validating that staging faithfully represents the production syscall set, and handling the exceptions when a service makes a syscall in production that was not observed in staging (typically due to a code path that was not exercised in tests). A staff engineer proposing this approach needs to address the validation problem: how do you know your staging tests are representative enough that you can trust the resulting seccomp profile?

Netflix's continuous scanning that re-evaluates running images against newly published CVEs is the security pattern that closes the gap between "clean at deploy time" and "clean right now." The operational implication is that a service that passed all scans at deploy time may trigger a CRITICAL CVE alert six months later when a new CVE is published against a library in the image. The on-call process for this alert must be defined before it fires: who receives it, what is the SLA, is automated rollback triggered, and what is the escalation path. A staff engineer implementing continuous scanning must also implement the operational process that consumes its output, or the alerts become noise.

The shared pattern across all three case studies: security at FAANG scale is a platform product with governance, automation, and operational processes, not a set of configurations applied once and forgotten. The organizations that do it well invest as much in the operational lifecycle as in the initial implementation.

