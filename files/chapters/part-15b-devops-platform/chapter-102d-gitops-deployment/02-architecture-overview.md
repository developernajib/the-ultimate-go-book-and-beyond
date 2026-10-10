## Architecture Overview

GitOps enforces a strict pull-based deployment model: no CI pipeline ever reaches into a cluster with `kubectl apply`. Instead, a CI job commits the desired state to a Git repository, and an in-cluster operator (ArgoCD) continuously reconciles the live cluster state against that declared state. This separation means Git history becomes the authoritative audit log for every configuration change, and cluster access credentials never need to leave the Kubernetes network boundary.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        GitOps Deployment Flow                            │
└──────────────────────────────────────────────────────────────────────────┘

  Developer
  ┌─────────┐   PR merge    ┌─────────────────┐   image push   ┌──────────┐
  │  Code   │──────────────►│   CI Pipeline   │───────────────►│   ECR    │
  │  Push   │               │ (GitHub Actions)│                │ Registry │
  └─────────┘               └─────────────────┘                └──────────┘
                                     │                               │
                                     │ update image tag              │
                                     ▼                               │
                            ┌─────────────────┐                      │
                            │  Config Repo    │                      │
                            │  (manifests/)   │◄─────────────────────┘
                            │  Kustomize      │  (git commit)
                            └────────┬────────┘
                                     │ watches
                                     ▼
                            ┌─────────────────┐
                            │     ArgoCD      │   Pull model:
                            │  (in-cluster)   │   ArgoCD pulls from Git
                            │                 │   every 3 minutes (or webhook)
                            └────────┬────────┘
                                     │ reconcile
                                     ▼
                            ┌──────────────────────────────┐
                            │      Kubernetes Cluster      │
                            │                              │
                            │  ┌────────────────────────┐  │
                            │  │     Argo Rollouts      │  │
                            │  │     ├── Blue/Green     │  │
                            │  │     └── Canary         │  │
                            │  └────────────────────────┘  │
                            └──────────────────────────────┘

  Deployment Strategies:

  Rolling:    [v1][v1][v1]  →  [v2][v1][v1]  →  [v2][v2][v1]  →  [v2][v2][v2]

  Blue/Green: [v1-blue][v1-blue]  +  [v2-green][v2-green]
              traffic: 100% → blue;   switch → 100% to green;  delete blue

  Canary:     [v1][v1][v1][v1][v1][v1][v1][v1][v1][v1]
              → [v2][v1][v1][v1][v1][v1][v1][v1][v1][v1]  (10%)
              → [v2][v2][v2][v1][v1][v1][v1][v1][v1][v1]  (30%)
              → [v2][v2][v2][v2][v2][v2][v2][v2][v2][v2]  (100%)
```

### Junior → FAANG: Reading Architecture Diagrams Productively

The ASCII diagram above encodes a critical design decision: the only path from a developer commit to the cluster is through Git. CI never holds cluster credentials. This is the security boundary that makes GitOps defensible to a security team. When reading any architecture diagram, identify the trust boundaries first. Where do credentials live? What can reach what? This habit is the difference between understanding a system and merely knowing how to operate it.

The three deployment strategy rows at the bottom are not cosmetic. Rolling is the default and the cheapest. Blue/green trades cost (double infrastructure) for instant rollback. Canary trades complexity (traffic splitting, metric analysis) for minimum blast radius. You will be asked in interviews to choose between them. The right answer is always "it depends on the service": payment processing services warrant canary, internal batch jobs warrant rolling, and services with database migrations that are version-incompatible warrant blue/green.

### Senior @ FAANG: Architecture as a Contract Between Teams

At senior and staff level, an architecture diagram is a contract, not a description. The separation between the CI pipeline and the cluster means the platform team can enforce cluster access controls independently of what the application team does in CI. A CI job cannot accidentally (or maliciously) deploy a rogue image if it has no cluster credentials. This security property must be explicitly documented and defended against erosion over time, because engineers under deadline pressure will propose "just add a kubectl apply step" as a shortcut.

The two-stage separation, CI writes to Git and ArgoCD reads from Git, creates a buffer that enables several staff-level capabilities. First, the deployment cadence is decoupled from the CI cadence: ArgoCD can hold off syncing during a freeze window without changing any CI configuration. Second, the manifest repository becomes the shared interface between application teams and the platform team: a platform team can enforce structural requirements through branch protection and policy checks without gating every application team's development velocity. Third, rollback becomes a Git operation that any authorized engineer can perform without cluster access, which matters for security hardening and compliance.

The diagram also hides a scaling consideration that L6 candidates should name: at high Application counts, ArgoCD's application controller can become memory-bound and its reconciliation loop can introduce latency. This drives the need for sharded ArgoCD deployments, regional ArgoCD instances rather than a single global control plane, and careful tuning of the reconciliation interval per environment tier.

---
