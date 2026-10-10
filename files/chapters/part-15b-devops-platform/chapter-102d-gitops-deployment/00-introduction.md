# Chapter 102D: GitOps & Deployment Strategies

*If your deployment process is so complex it requires a runbook, you don't have a deployment process, you have a ritual.*

Traditional deployment pipelines operate on a push model: CI completes, a script runs kubectl apply or deploys a service, and the cluster state diverges silently from what is in source control the moment anyone makes a hotfix directly against the cluster. In organizations with dozens of teams and hundreds of microservices, configuration drift becomes undetectable until something breaks in production - often during an incident when the last thing you need is uncertainty about what is actually running.

GitOps resolves this by inverting the model: Git becomes the single source of truth, and a reconciliation controller running inside the cluster continuously ensures the live state matches the declared state in the repository. For Go engineers, this means understanding how ArgoCD's reconciliation loop works, how to structure Kubernetes manifests for Kustomize-based environment promotion, and how to integrate progressive delivery strategies - canary, blue/green, and rolling - directly into the deployment lifecycle.

This chapter builds a complete GitOps pipeline from GitHub Actions through ArgoCD to Kubernetes, covering deployment strategy implementation with Argo Rollouts, multi-environment management with Kustomize overlays, and the operational practices that make GitOps reliable in production rather than just theoretically elegant.

**What you'll learn in this chapter:**
- GitOps principles: pull-based deployment, reconciliation loops, declarative desired state, and self-healing clusters
- ArgoCD architecture: Application CRDs, sync policies, resource hooks, sync waves, and health assessment
- Blue/green deployments: zero-downtime cutover mechanics, traffic shifting, and automated rollback triggers
- Canary deployments with Argo Rollouts: progressive traffic shifting, metric-based promotion gates, and automatic rollback
- Rolling update tuning: maxSurge, maxUnavailable, readiness gates, and PodDisruptionBudgets for safe rollouts
- Environment management with Kustomize overlays: base manifests, per-environment patches, and preview environments
- Building complete CI/CD+GitOps pipelines: GitHub Actions → image build → manifest update → ArgoCD auto-sync
- ApplicationSet for multi-cluster and multi-tenant GitOps management at organization scale

**Why this matters at scale:**
Uber and Netflix use GitOps-based progressive delivery to deploy thousands of times per day with automated rollback - eliminating the manual intervention that historically made high-frequency deployments too risky to attempt without a dedicated on-call rotation.

**Prerequisites:** Chapter 97 (Docker), Chapter 98 (Kubernetes), Chapter 102C (Terraform & IaC)

### Junior → FAANG: Understanding Why GitOps Exists

When you first encounter GitOps, the natural reaction is to ask why you cannot just run `kubectl apply` from the CI pipeline. That question is worth sitting with. The answer reveals what makes GitOps valuable, and understanding the motivation is required before the tooling makes sense.

The core problem with push-based pipelines is that the cluster becomes an independent source of truth the moment anyone runs a hotfix directly against it. A month later, nobody can answer "what is actually running in production?" without querying the cluster, and that answer might differ from what is in the repository. GitOps makes that divergence structurally impossible: the in-cluster agent is always pulling toward Git, so Git must be correct before the cluster can be correct.

For a first job, two habits matter. First, resist the impulse to patch the cluster directly during an incident. Use `kubectl` to read, not to write. Second, treat every manual `kubectl apply` as technical debt that must be committed to Git before the end of the incident. Organizations that allow direct cluster writes inevitably accumulate invisible configuration that surfaces as unexplained breakage months later.

Entry-level interview framing: when asked "what is GitOps," do not recite the definition. Explain the problem it solves: cluster state diverges from repository state, and GitOps enforces convergence by making the cluster a consumer of Git rather than an independent system.

### Senior @ FAANG: Evaluating GitOps as Organizational Infrastructure

At staff and principal level, GitOps is not a tool choice but an organizational commitment with significant governance and platform implications. The decision to adopt ArgoCD or FluxCD is a multi-year infrastructure contract that shapes how hundreds of engineers ship code, how security teams audit deployments, and how platform engineering exposes deployment capability as a service.

The most important senior concern is the two-repository versus monorepo trade-off for manifest management. The two-repository model (application code separate from GitOps config) gives clean separation of concerns: CI teams own the application repository, platform teams own the config repository, and access control is unambiguous. The monorepo model (manifests alongside application code) reduces coordination overhead for smaller organizations but creates blurry ownership at scale and makes it harder to enforce platform-level policies through branch protection.

At FAANG scale, GitOps tooling must answer governance questions that go beyond "does the cluster match Git." Which team approved this change? What was the blast radius if this commit was wrong? Who has permission to sync production without a human approval? These questions drive the AppProject RBAC design in ArgoCD, the sync window configuration, and the audit notification pipeline. Organizations that treat GitOps as purely a deployment tool without a governance model end up with a more auditable version of the same chaos they had before.

An Architecture Decision Record for GitOps adoption should cover: reconciliation tool selection and reasoning, repo structure (monorepo vs split, overlay strategy), secret management approach and rotation policy, how preview environments are provisioned and deprovisioned, DORA metric collection and ownership, and the break-glass procedure for emergencies. The absence of documented emergency procedures is one of the most common bar-raiser concerns in platform engineering interviews at L6 and above.

---
