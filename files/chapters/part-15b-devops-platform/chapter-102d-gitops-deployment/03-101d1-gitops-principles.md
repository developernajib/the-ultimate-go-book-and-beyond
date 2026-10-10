## 102D.1 GitOps Principles

### Push vs Pull Deployment

In a push-based pipeline a CI job pushes a new artifact directly to the cluster using `kubectl apply` or `helm upgrade`, which means the cluster state is only correct immediately after a pipeline run. Pull-based GitOps inverts this: an agent running inside the cluster continuously watches the Git repository and reconciles the cluster toward the desired state declared there. The pull model eliminates the need to grant external CI systems direct cluster access, and any manual change to the cluster is automatically reverted on the next reconciliation cycle.

```
Push-based (traditional CI/CD):
  CI pipeline → kubectl apply → cluster

  Problems:
  - CI pipeline needs cluster credentials (security risk)
  - No reconciliation: if someone manually changes a resource, it stays changed
  - Approval gates live in CI, not in Git history
  - Hard to answer "what's running in prod?" without querying the cluster

Pull-based (GitOps):
  Agent in cluster → watches Git → applies changes when Git differs from cluster

  Benefits:
  - No external access to cluster (only outbound Git reads from inside cluster)
  - Self-healing: if someone kubectl-patches a resource, reconciliation reverts it
  - Full audit trail in Git history
  - Single source of truth: Git = what should be running
  - Rollback = revert a Git commit
```

### GitOps Invariants

1. **Declarative**: All system state described in Git as Kubernetes manifests/Helm charts/Kustomize
2. **Versioned and immutable**: Git history is the change log. You can't change the past
3. **Automatically applied**: Approved changes are pulled and applied without manual steps
4. **Continuously reconciled**: Agents detect and correct drift from declared state

### Junior → FAANG: Internalizing the Four Invariants

The four GitOps invariants are not abstract principles. They are practical rules that tell you what to do when something goes wrong. During an incident, "declarative" means the fix must be a manifest change, not a command. "Versioned and immutable" means the audit trail is in Git, so the first question is always "what changed in the last commit?" not "what did someone kubectl apply?" "Automatically applied" means the cluster will converge without manual intervention once the correct state is committed. "Continuously reconciled" means you do not need to trigger a deployment after a fix commit: the operator will apply it.

The push-vs-pull comparison is a standard interview question. Build a concrete answer with specific problems, not abstract ones. Push requires CI to hold cluster credentials, which are typically long-lived and broad-scoped. Pull requires only that the in-cluster agent can read from Git, which is an outbound connection the cluster already needs for image pulls. The credential surface is smaller and the scope is tighter.

### Senior @ FAANG: Reconciliation Loop Failure Modes and Their Governance Implications

The reconciliation loop is the heart of GitOps, and understanding its failure modes is what separates operational maturity from cargo-culting. The loop can fail in at least four ways that each require a different organizational response.

First, the Git source can become unavailable. If ArgoCD cannot reach the manifest repository, it cannot detect drift or apply changes. Production clusters must be designed to be static when Git is down: `selfHeal` should not be disabled, but the existing cluster state should remain stable. This argues for caching the last-known-good manifest state and configuring ArgoCD retry policies with exponential backoff rather than failing fast.

Second, the reconciliation loop can detect drift but fail to apply it due to admission webhook rejections or RBAC denials. This is the most common production failure mode and is often invisible: ArgoCD marks the Application as `SyncFailed`, but no alert fires because the team configured only `Slack` notifications, not `PagerDuty`. Staff-level platform design includes defining what sync failure severity maps to what alerting channel, with explicit escalation paths.

Third, the `ignoreDifferences` configuration can drift from reality. If an HPA is managing replicas but `ignoreDifferences` does not cover `/spec/replicas`, ArgoCD will constantly fight the HPA, triggering rolling updates and wasting cluster resources. Auditing `ignoreDifferences` configurations across all Applications is a recurring platform maintenance task that must be owned and scheduled.

Fourth, `selfHeal: true` in production is a governance trade-off, not a universal best practice. For infrastructure-level resources such as NetworkPolicies or PodSecurityAdmission configurations, selfHeal prevents unauthorized weakening of the security posture. For application-level resources where a hotfix was applied directly and the on-call engineer needs the fix to stay until a proper commit is made, selfHeal is a hazard. The platform team must document which resource types are appropriate for selfHeal and which require selfHeal to be disabled on specific Applications.

---
