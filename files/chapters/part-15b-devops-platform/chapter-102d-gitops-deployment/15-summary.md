## 102D.13 Mid-Chapter Synthesis: Core GitOps Recap

GitOps transforms deployments from fragile manual processes into automated, auditable, and self-healing workflows. The patterns in this chapter - ArgoCD for orchestration, Kustomize for environment management, Argo Rollouts for progressive delivery, and GitHub Actions for CI - form the deployment foundation used by companies deploying thousands of times per day.

**The GitOps maturity model**: Start with basic ArgoCD + Kustomize (Git as config store) → add automated sync with selfHeal → implement canary/blue-green with Argo Rollouts → add DORA metrics tracking → full preview environments and automated compliance.

**Progressive delivery is non-negotiable at scale**: Rolling updates are good enough for most services. Canary deployments become necessary when: your service has millions of users and even a 1% error rate means thousands of failures, you can't test everything in staging (production traffic patterns differ), or you want automated confidence based on real metrics.

**Key takeaways for FAANG interviews**:
1. GitOps = pull-based deployment where Git is the single source of truth - enables drift detection and auditability
2. Canary deployments require automated metric-based promotion/rollback - manual canary defeats the purpose
3. Zero-downtime requires: `maxUnavailable=0`, proper readiness probes, graceful shutdown with preStop, and PDBs
4. ArgoCD's sync waves solve deployment ordering (migrate before deploy, smoke test after) declaratively
5. Sealed Secrets or External Secrets Operator are the correct solutions for GitOps-compatible secret management

### Junior → FAANG: Using Summaries as Self-Assessment Tools

A summary is a compression of the chapter's signal. Read each point and ask whether you can expand it back to a concrete example. For point 1, can you describe what happens when ArgoCD detects drift? For point 2, can you describe what Argo Rollouts does when an AnalysisRun fails? If any point produces a vague answer, return to the specific section and work through the examples again.

The GitOps maturity model mentioned in this summary is a framework worth memorizing for interviews. Interviewers at L4-L5 often ask "how would you introduce GitOps to a team that currently uses kubectl apply in CI?" The maturity model gives you a structured answer: start with ArgoCD watching a static manifests repository (basic), add selfHeal and automated sync (intermediate), add Argo Rollouts with AnalysisTemplates (advanced), then add DORA metrics and preview environments (expert). Frame each step as delivering standalone value before moving to the next.

### Senior @ FAANG: Summary as Investment Prioritization Framework

At staff level, a chapter summary doubles as a prioritization framework for platform investment. These five takeaways translate into specific platform capabilities that have measurable value, and the investment required differs significantly between them.

Point 1 (GitOps fundamentals) has the highest-value per unit of investment. Converting a team from kubectl-in-CI to ArgoCD typically takes two weeks and immediately improves auditability and security posture. This is the highest-priority platform investment for organizations that have not yet adopted GitOps.

Point 2 (automated canary) has the highest complexity per unit of adoption. Metric-based canary requires a functioning observability stack, AnalysisTemplate design, traffic routing infrastructure, and organizational trust in automated rollback. At organizations where the observability stack is immature, the canary investment is blocked until observability is addressed. Plan accordingly.

Point 3 (zero-downtime) is a platform contract concern. The components, `maxUnavailable=0`, readiness probes, graceful shutdown, and PDBs, must all be present simultaneously. A deployment that has three of the four is not zero-downtime: it has a different failure mode. The platform team should treat these as a unit and enforce them together through policy, not as individual guidelines that teams can partially adopt.

The FAANG-facing framing in point 5 (secret management) understates the technical debt risk. Organizations that adopt Sealed Secrets at small scale often do not document the migration path to External Secrets Operator. When the migration becomes necessary (typically when expanding to multi-cluster or implementing secret rotation), the absent migration documentation and the volume of existing sealed secrets create a significant operational event. Document the migration plan before you need it.

---
