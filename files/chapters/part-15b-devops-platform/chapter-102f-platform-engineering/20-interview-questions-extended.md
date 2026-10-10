## 102F.18 Interview Questions (Extended)

**Q9: How do you handle multi-tenant Kubernetes?**

Four isolation layers: (1) **Namespace** - `{team}-{service}-{env}` per service. (2) **NetworkPolicy** - default deny-all ingress/egress, explicit allows for declared dependencies. (3) **ResourceQuota** - prevents one team monopolizing cluster resources (CPU, memory, pod count). (4) **RBAC** - teams get `edit` on their namespaces, `view` on all others. For strong isolation: dedicated node pools per tenant (node affinity + taints). Pod Security Admission enforces `restricted` by default - no privileged containers, no host network. Exception: teams needing `baseline` (e.g., some monitoring agents) submit a security review PR.

---

**Q10: How would you design self-service database provisioning?**

Three layers: (1) **Developer API** - Backstage plugin form or `kubectl apply` of `PostgreSQLInstance` YAML. (2) **Crossplane Composition** - maps developer-facing resource to actual AWS resources: creates VPC security group, parameter group, subnet group, RDS instance, CloudWatch alarms - all as one atomic unit. (3) **External Secrets Operator** - when RDS status becomes `Ready`, ESO writes `DATABASE_URL` as Kubernetes Secret in team namespace. Developer experience: submit YAML → 15 minutes → Secret appears. Platform team maintains Compositions. They never manually provision. Audit trail: every database has a Git commit showing who requested it when.

---

**Q11: What is the SPACE framework?**

SPACE (Satisfaction, Performance, Activity, Communication, Efficiency) from Microsoft Research provides a balanced scorecard for developer productivity. Applied to a platform team: **S** = developer NPS + platform satisfaction quarterly survey. **P** = deployment success rate, production incident rate from platform-managed services. **A** = deployments per day, services onboarded, infrastructure provisioned. **C** = cross-team API reuse, shared library adoption %. **E** = time-to-first-deploy, infrastructure provision latency, manual toil hours. Key insight: optimizing a single metric (e.g., deployment frequency) can degrade others (quality). Use SPACE as a balanced dashboard, not a single KPI.

---

**Q12: How do you detect and prevent configuration drift?**

Prevention: (1) ArgoCD auto-sync - reconciles every 3 minutes, overwrites manual changes. (2) Admission webhook rejects `kubectl apply` in production namespaces from non-ArgoCD service accounts. (3) Crossplane continuously reconciles cloud resources - manual AWS console changes are reverted within minutes. Detection: ArgoCD OutOfSync alerts (PagerDuty if drift persists >5 min). AWS Config rules flag unmanaged resources. Weekly drift report: list all resources not in Git. Response policy: open auto-PR to bring state back to declared configuration. Investigate root cause.

---

**Q13: How would you migrate 200 services to a new golden path version?**

Structured 90-day process: (1) **Identify**: query catalog for `golden-path: v1` services - 200 found. (2) **Automate**: tooling opens migration PR to all 200 repos. CI validates it builds + tests pass. (3) **Communicate**: Slack announcement, office hours, migration guide published to TechDocs. (4) **Soft deadline**: "v1 unsupported after 90 days. Open PRs auto-merged if no objection within 7 days". (5) **Track**: public dashboard showing migration progress (0 → 200). Social pressure accelerates adoption. (6) **Exceptions**: teams with genuine blockers document and get extended timeline. Outcome: 90% migrated within 60 days, remaining 10% by 90 days.

---

**Q14: When should you implement a service mesh?**

Implement when: 50+ services (manual mTLS cert management becomes toil), compliance requires encryption-in-transit audit logs, or advanced traffic management (canary, circuit breaking, retries) is needed without code changes. Skip when: <20 services (overhead > value), team lacks K8s expertise to operate a mesh, or mTLS is handled at the application layer already. In 2026: **Cilium** (eBPF-based, sidecarless) is preferred over Istio for new deployments - 3x lower CPU overhead, no per-pod sidecar, deep Kubernetes network policy integration. Cilium + Hubble covers 80% of service mesh use cases.

---

**Q15: How would you build a platform team from scratch?**

Six-month roadmap: **Month 1**: embed with product teams, observe, don't build. Survey: "What takes the most time that isn't your core product?" **Month 2**: solve the top pain point (typically: CI/CD standardization). Ship a reusable GitHub Actions workflow. **Month 3**: measure adoption, iterate. If >60% adoption: add second capability. **Month 4**: environment provisioning or service catalog - whichever is second-highest pain. **Month 5**: combine working pieces into complete golden path - one command, production-ready service. **Month 6**: Backstage - catalog all services, auto-import TechDocs from existing READMEs. At 6 months: standardized CI/CD (100% adoption), service catalog (80%), golden path (all new services use it). Rule: never announce broadly until it works reliably for 2 pilot teams.

### Junior → FAANG: The Questions That Reveal Platform Engineering Depth

Questions nine through fifteen in this section are the kind that appear at mid-level and senior engineering interviews for platform roles. A junior engineer who can answer these credibly is demonstrating above-level readiness.

Q9 (multi-tenant Kubernetes) requires knowing the four isolation layers in order of enforcement: namespace, NetworkPolicy, ResourceQuota, RBAC. Being able to recite these and explain what each one prevents is a strong signal. Namespace isolation prevents name collisions. NetworkPolicy prevents lateral movement between namespaces. ResourceQuota prevents one team starving shared cluster resources. RBAC prevents teams from modifying each other's workloads.

Q13 (migrating 200 services to a new golden path) is a system design question about coordination. The critical insight is automation: hand-crafting 200 PRs is not feasible, but writing a tool that opens them automatically, verifies they pass CI, and provides a public tracking dashboard is feasible and demonstrates platform engineering maturity. The social pressure element (public dashboard showing migration progress) is a genuine technique used in large organizations to accelerate voluntary migrations.

Q15 (building a platform team from scratch) is the most common senior platform engineering interview question. The six-month roadmap answer is organized around a key principle: never build before you have validated demand, and never announce before you have two pilot teams that can testify to the value. This prevents the most common platform engineering failure (building in a vacuum) from the very first sprint.

### Senior @ FAANG: Bar-Raiser Depth on the Most Important Questions

For L6 and above, the extended interview questions test the ability to design systems that scale beyond what any individual can monitor or maintain manually.

Q12 (configuration drift) at FAANG scale is a governance problem, not just a technical one. ArgoCD auto-sync catches Kubernetes drift, and Crossplane reconciliation catches cloud resource drift. But what catches drift in the build system, the CI pipeline configuration, the developer tooling installed on build agents, and the security scanning rules? A complete drift detection strategy requires inventorying all configuration surfaces, assigning an owner for each, and establishing an automated detection mechanism for each owner. The weekly drift report mentioned in Q12 is the summary. The detection pipeline behind it requires months to build correctly.

Q14 (when to use a service mesh) at the bar-raiser level goes beyond the feature checklist. The question that separates L6 answers from L7 answers is: who will be responsible for debugging mesh-related failures at 2am? If the answer is "the on-call product engineer who deployed a service that has mysterious connectivity failures," then the mesh has made on-call harder, not easier. A mesh is only worth deploying if the platform team has the operational expertise to diagnose mesh-layer failures, has runbooks for common failure modes (certificate expiry, control plane unavailability, policy conflict), and has set up observability that lets a non-expert on-call engineer understand whether a failure is application-layer or mesh-layer. Without that operational infrastructure, a service mesh increases the blast radius of every network-related incident.
