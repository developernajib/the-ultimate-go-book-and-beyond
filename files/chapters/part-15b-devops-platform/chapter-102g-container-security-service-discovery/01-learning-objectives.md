## Learning Objectives

1. **Understand the container threat model** - attack surface from image to runtime, supply chain risks, and OWASP container top 10
2. **Implement image security** - Trivy scanning in CI, distroless images, scratch-based builds, and multi-stage optimization
3. **Harden containers at runtime** - seccomp profiles, AppArmor, rootless containers, and Linux capabilities
4. **Enforce policy-as-code** - OPA/Gatekeeper constraint templates and Go integration
5. **Master service discovery** - client-side vs server-side, Consul service mesh, etcd registration, and DNS-based discovery
6. **Implement zero-trust microservices** - mTLS, SPIFFE/SPIRE workload identity, and complete zero-trust setup in Go

---

### Junior → FAANG: Mapping Objectives to Interview Topics

Each learning objective here maps to a category of interview question you will encounter at mid-level and senior screens. Knowing the shape of each topic helps you study with intent rather than covering material randomly.

"Understand the container threat model" translates to: can you describe the attack surface of a containerized workload end to end? Interviewers at FAANG-adjacent companies ask this as a warm-up to test baseline security literacy. Practice articulating image layer risks, runtime risks, and network risks as distinct layers rather than a single undifferentiated "security" concern.

"Implement image security" maps to CI/CD design questions. Know how Trivy integrates into a pipeline, what a CRITICAL-severity CVE finding should trigger, and why distroless images reduce the attack surface (no shell, no package manager, minimal attack surface at runtime).

First-job habit: use these six objectives as a self-assessment checklist after every sprint. If your work touched containers that week, ask yourself which of these six dimensions you engaged with and which you skipped.

### Senior @ FAANG: Using Objectives as a Maturity Model for Platform Teams

At the staff level, these six objectives are not personal learning goals. They are dimensions along which you assess the maturity of an organization's container platform and identify where to invest engineering effort.

A useful framing: map each objective to a maturity level (ad hoc, repeatable, defined, measured, optimizing). A team that runs Trivy manually sometimes is at ad hoc. A team with automated scanning in CI that blocks on CRITICAL CVEs is at repeatable. A team with a CVE SLA policy, automated triage, and a CVE exception approval workflow is at defined. A team with dashboards tracking CVE age and resolution time is at measured. Most organizations are between ad hoc and repeatable on most of these dimensions.

The governance implication: a staff engineer entering a new organization should be able to assess where each of these six dimensions sits on the maturity scale within the first 30 days, and produce an ADR or roadmap proposal that sequences improvements by risk impact and implementation cost. That sequencing judgment, knowing that runtime seccomp profiles are more effective than a new service discovery library because they reduce blast radius for all workloads, is the bar-raiser signal that separates L6 from L5.

Zero-trust microservices (objective 6) is frequently the last dimension organizations invest in because it requires cross-team coordination for certificate issuance and mTLS rollout. A senior engineer owns the migration plan: how do you add mTLS to an existing mesh of 50 services without a flag-day cutover? The answer involves permissive mode (log but do not enforce), per-namespace rollout, and automated certificate health monitoring. That level of operational planning detail is what L7 thinking looks like.
