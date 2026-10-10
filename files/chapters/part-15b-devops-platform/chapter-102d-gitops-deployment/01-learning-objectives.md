## Learning Objectives

1. **Understand GitOps principles** - git as source of truth, pull-based deployment, reconciliation loops, and why GitOps beats push-based CI/CD
2. **Master ArgoCD** - Application CRDs, sync policies, waves/hooks, rollback, and ApplicationSet for multi-cluster management
3. **Implement blue/green deployments** - zero-downtime cutover using Kubernetes and Argo Rollouts
4. **Implement canary deployments** - progressive delivery with metric-based promotion and automatic rollback
5. **Understand rolling updates** - maxSurge/maxUnavailable, readiness gates, and PodDisruptionBudgets
6. **Design environment management** - Kustomize overlays, preview environments, and GitOps workflow integration
7. **Build complete CI/CD+GitOps pipelines** - GitHub Actions → image build → manifest update → ArgoCD auto-sync

### Junior → FAANG: Reading Learning Objectives Actively

Learning objectives are not decoration. Before working through any chapter, read each objective and ask yourself whether you can already explain it. For this chapter, if you cannot define what "reconciliation loop" means in one sentence, that is where to start. If you are fuzzy on the difference between a Deployment and a Rollout CRD, that gap will make the canary sections harder to follow.

Entry-level interview signal: candidates who understand the purpose of a learning objective can answer "why do we do X" questions, not just "what is X." Interviewers at FAANG test motivation and reasoning, not just recall.

A concrete self-check: after finishing the chapter, return to this list and explain each objective as if teaching it to a colleague who uses Kubernetes but has never heard of GitOps. If you cannot teach it, you do not yet own it.

### Senior @ FAANG: Mapping Objectives to Staff-Level Concerns

At L6 and above, these seven objectives map to platform decisions with organization-wide consequences. "Master ArgoCD" at senior level means understanding the operational cost of running ArgoCD at scale: controller memory footprint per Application object, API server load from frequent reconciliation, the failure mode when ArgoCD's own database becomes a single point of failure, and the organizational impact of an ArgoCD outage on deployment velocity across all teams.

"Design environment management" at staff level means designing the Kustomize overlay structure as a platform API: the shape of the overlay hierarchy determines how easy it is for application teams to onboard new services, how safely platform changes can be rolled out without affecting application overlays, and whether the structure supports future requirements such as multi-region deployment or compliance-driven environment segregation.

The "build complete CI/CD+GitOps pipelines" objective touches the promotion model, which is a governance question at senior level. Who approves staging-to-production promotion? Is the gate human, automated, or hybrid? What evidence is required before promotion is allowed? These are organizational design questions that the tooling must support, not answer.

---
