## 102D.11 Core GitOps Interview Questions

**Q1: What is GitOps and how does it differ from traditional CI/CD?**

GitOps is a deployment methodology where Git is the single source of truth for system state, and a reconciliation agent (ArgoCD, FluxCD) continuously ensures the cluster matches what's in Git. Traditional CI/CD is push-based: the pipeline applies changes directly to the cluster, requiring cluster credentials in CI. GitOps is pull-based: the agent inside the cluster pulls desired state from Git and applies it. Key differences: (1) drift detection - GitOps continuously detects and corrects manual changes. (2) security - no cluster credentials in CI pipelines. (3) rollback = git revert. (4) audit trail in Git history. (5) declarative state visible by reading the config repo.

---

**Q2: Explain the difference between blue/green and canary deployments. When would you use each?**

Blue/green: runs two identical environments (blue = current, green = new version), then switches 100% of traffic at once. Instant rollback by switching back to blue. Use for: database migrations requiring schema changes compatible with only one version, compliance requirements for tested-before-live, batch jobs. Canary: gradually shifts traffic percentage from old to new version, monitoring metrics at each step. Use for: web services where gradual rollout catches regressions before full exposure, A/B testing, statistical significance testing. Blue/green doubles infrastructure cost during the switch. Canary requires sophisticated traffic splitting (service mesh or smart load balancer) but has smaller blast radius if new version has bugs.

---

**Q3: What are ArgoCD sync waves and hooks? Give a real use case.**

Sync waves control the order ArgoCD applies resources within a sync operation. Resources annotated with `argocd.argoproj.io/sync-wave: "-1"` apply before wave 0 (default) resources. Negative waves apply first, positive waves apply last. Hooks are special resources (Jobs, Pods) that run at specific sync lifecycle points: PreSync, Sync, PostSync, SyncFail. Real use case: database migration pattern - `PreSync` Job (wave -1) runs `./migrate --up` before any application pods deploy. Main Deployment applies at wave 0. `PostSync` Job runs smoke tests. If smoke tests fail, ArgoCD marks the sync as failed and triggers rollback. This guarantees: migration before deployment, smoke tests after, automatic rollback on failure.

---

**Q4: How does Kustomize work? How is it different from Helm?**

Kustomize applies transformations to base YAML files without templating. A `kustomization.yaml` references a base configuration and specifies patches, image replacements, name prefixes, and label additions. The base YAML is valid Kubernetes YAML - no templating syntax. Kustomize generates the final YAML by applying transformations. Helm uses templating with `{{ .Values.replicas }}` syntax embedded in YAML files, and a `values.yaml` for configuration. Kustomize advantages: base files are plain YAML (readable without tooling), simpler for pure Kubernetes workflows. Helm advantages: package distribution (Helm repositories), versioned releases, pre/post hooks, release history tracking. Most mature organizations use both: Helm for third-party applications (Prometheus, ArgoCD itself), Kustomize for their own services.

---

**Q5: What is a PodDisruptionBudget and why is it important?**

A PodDisruptionBudget (PDB) limits the number of pods that can be simultaneously unavailable during voluntary disruptions: node drains, rolling updates, cluster upgrades. `minAvailable: 80%` ensures at least 80% of pods remain running during disruption. Without PDB: a node drain that hosts 30% of your pods can violate your availability guarantee even if your deployment has `maxUnavailable: 20%`, because the drain and the rolling update can overlap. With PDB: Kubernetes blocks the drain or update if it would violate the budget. Critical for: production services with strict SLAs, stateful services where quorum loss causes issues (etcd, Cassandra), payment processing services.

---

**Q6: How would you implement a zero-downtime deployment for a Go application?**

Zero-downtime requires: (1) `maxUnavailable: 0` in the deployment strategy - never reduce below desired count during rollout. (2) readiness probe that returns 503 until the app is truly ready (database connected, caches warm, dependent services reachable). (3) graceful shutdown - handle SIGTERM, mark readiness probe unhealthy, wait for Kubernetes to stop routing new traffic (preStop sleep of 5-10s), then drain in-flight requests (30s termination grace period). (4) PDB to prevent simultaneous disruption during node operations. (5) correct `/ready` endpoint that returns unhealthy during shutdown phase - Kubernetes removes the pod from service endpoints before sending SIGTERM, but there's a race condition requiring the preStop sleep.

---

**Q7: What is the App of Apps pattern in ArgoCD?**

The App of Apps pattern uses one ArgoCD Application to manage a directory containing other Application CRDs. The "parent" application syncs the Application objects themselves, and ArgoCD then manages each child Application. This solves scale: instead of manually creating hundreds of Applications in ArgoCD, you commit Application CRDs to Git and the parent app deploys them automatically. It also enables: GitOps for ArgoCD configuration itself (meta-GitOps), hierarchical organization (team namespaces have their own set of Applications), and blast radius control (problems in one child app don't affect others). Alternative: ApplicationSet, which generates Applications from a template + generator (list, git directory scan, cluster list) - more dynamic than static App of Apps.

---

**Q8: How do you handle secrets in a GitOps workflow?**

You can't commit plaintext secrets to Git. Solutions: (1) **Sealed Secrets**: encrypt secrets with a cluster-specific public key using `kubeseal`. The sealed (encrypted) YAML can be committed to Git. The sealed-secrets controller in the cluster decrypts it using the private key. Secrets can only be decrypted by that specific cluster. (2) **External Secrets Operator**: stores secrets in AWS Secrets Manager, HashiCorp Vault, or GCP Secret Manager. An `ExternalSecret` CRD references the external secret path - the operator fetches and syncs it to a Kubernetes Secret. Secrets never touch Git. (3) **Vault Agent Sidecar**: injects secrets as files into pods via sidecar. Best for: dynamic secrets (database credentials with short TTL). Most teams use External Secrets Operator for GitOps compatibility with centralized secret management.

---

**Q9: What DORA metrics should you track for your deployment pipeline?**

DORA (DevOps Research and Assessment) metrics: (1) **Deployment Frequency**: how often you deploy to production. Elite teams deploy multiple times per day. Measure: deployments per day/week from ArgoCD sync history. (2) **Lead Time for Changes**: time from code commit to running in production. Measure: `git commit timestamp → ArgoCD sync complete timestamp`. (3) **Mean Time to Recovery (MTTR)**: time from incident detected to service restored. Measure: incident creation time → resolution time from PagerDuty/OpsGenie. (4) **Change Failure Rate**: percentage of deployments causing incidents. Measure: `incidents triggered by deployments / total deployments`. Correlate ArgoCD deployments with incident creation. Target: elite performers have change failure rate < 5%. Use these four metrics to evaluate if your GitOps + deployment strategy improvements are actually helping.

---

**Q10: How would you set up preview environments for pull requests?**

Preview environments deploy each PR to an isolated namespace for testing before merge. Implementation with ArgoCD ApplicationSet: (1) use the **Pull Request generator** in ApplicationSet that queries GitHub API for open PRs. (2) each PR gets an Application named `shopapp-pr-{number}` deploying to namespace `preview-pr-{number}`. (3) the Application is automatically deleted when the PR closes. Requirements: (a) the PR deployment must use a different database (ephemeral, seeded with test data). (b) the PR image tag must be the PR build, not main. (c) ingress with PR-specific hostname: `pr-123.shopapp.com`. Cost concern: preview environments for every PR can be expensive. Mitigation: auto-sleep inactive previews after 1 hour, auto-delete after 24 hours.

---

**Q11: What is the difference between ArgoCD and FluxCD?**

Both are CNCF GitOps tools implementing continuous delivery to Kubernetes. ArgoCD: centralized UI and server, multi-cluster from single control plane, strong RBAC, ApplicationSet for dynamic Application generation, better for teams needing visibility across many clusters from one place. FluxCD: decentralized (each cluster runs its own controllers independently), no central UI (relies on kubectl + CLI), more Kubernetes-native (standard controller-runtime patterns), better at managing many independent clusters, Image Automation Controller for automatic image tag updates. Choose ArgoCD for: enterprise teams, multi-cluster visibility, strong UI. Choose FluxCD for: simple setups, teams preferring CLI, clusters that shouldn't depend on central infrastructure.

---

**Q12: How do you roll back a failed deployment in GitOps?**

GitOps rollback = git revert: `git revert HEAD` creates a new commit that undoes the previous deployment commit, then push - ArgoCD auto-syncs and rolls back. This is better than `kubectl rollout undo` because: (1) the revert is in Git history - auditable. (2) the config repo always reflects actual cluster state. (3) doesn't create hidden divergence between Git and cluster. For emergency rollback when you can't wait for Git PR: `argocd app rollback shopapp-production --revision <git-sha>` rolls back immediately to a previous Git revision. But ALWAYS follow up with a proper git revert to keep Git as source of truth.

---

**Q13: How do you implement multi-cluster deployments with ArgoCD?**

Register clusters in ArgoCD: `argocd cluster add <kubeconfig-context>`. Each cluster has a server URL and credentials stored in ArgoCD's secret store. For multi-cluster deployments: (1) **ApplicationSet with cluster generator**: generates one Application per registered cluster, routing to cluster-specific configs. (2) **Cluster labels**: label clusters with `region`, `environment`, `tier` - ApplicationSet selectors target specific cluster groups. (3) **Deployment order**: ApplicationSet doesn't enforce order between clusters - use multiple ApplicationSets with dependencies or Argo Rollouts multi-cluster analysis. (4) **Secrets per cluster**: each cluster's namespaces have their own sealed secrets encrypted with that cluster's key. Use External Secrets Operator with cluster-specific service accounts for centralized secret management.

---

**Q14: Explain the GitOps reconciliation loop. What happens when drift is detected?**

The reconciliation loop runs every N minutes (default 3 minutes in ArgoCD, configurable) or on webhook from Git: (1) fetch desired state from Git. (2) fetch actual state from Kubernetes API. (3) diff desired vs actual. (4) if `selfHeal: true` and drift detected, apply desired state to cluster - reverting manual changes. (5) if `automated.prune: true`, delete resources present in cluster but absent from Git. When drift is detected without auto-sync: ArgoCD marks the Application as `OutOfSync` and alerts. Engineers investigate why drift occurred (manual hotfix, forgot to commit a change). Best practice: `selfHeal: true` in non-production, manual review-before-sync in production for infrastructure changes.

---

**Q15: How would you design a GitOps workflow for a regulated industry (banking, healthcare)?**

Regulated industries require: (1) **Change management**: every deployment must have an approved change ticket. Solution: ArgoCD webhooks + ServiceNow/Jira integration that automatically creates/closes change tickets on Application sync events. (2) **Separation of duties**: developers cannot deploy to production without a second approver. Solution: Git branch protection requiring 2 reviewers on the manifests repo. ArgoCD production Applications configured with `syncPolicy.automated: null` (manual sync only), requiring ops team member to trigger sync. (3) **Audit trail**: full audit of who changed what, when, and who approved. Solution: Git history + ArgoCD audit log + SIEM integration. (4) **Rollback documentation**: every rollback must be documented. Solution: ArgoCD sync annotations capture rollback reason. (5) **Immutable deployments**: once deployed, a specific version cannot be modified. Solution: OPA policy that blocks changing image tags for already-deployed versions in production.

### Junior → FAANG: Answering Interview Questions at the Right Depth

These 15 questions represent the common GitOps interview space for L3 to L5 roles. For L3, answer correctly and concisely. For L4, add a real-world consideration or trade-off. For L5, demonstrate that you have made the decision in practice and can articulate what you would do differently.

For Q1 (what is GitOps): lead with the problem, not the solution. "GitOps solves configuration drift by making Git the authoritative source of truth and using a reconciliation loop to enforce convergence." Then explain pull vs push. Do not start with "it's a DevOps practice."

For Q6 (zero-downtime deployment): the answer has five components. `maxUnavailable: 0`, readiness probe, graceful shutdown with preStop, PDB, and the race condition between SIGTERM and Endpoints propagation. Missing any of these suggests you have not actually implemented zero-downtime and are reciting documentation.

For Q8 (secrets in GitOps): the answer must include why each option exists, not just that options exist. Sealed Secrets for simplicity, External Secrets Operator for rotation and multi-cluster, Vault for dynamic credentials. If you can explain the rotation failure mode of Sealed Secrets, you demonstrate operational experience beyond the documentation.

### Senior @ FAANG: Interview Questions as Bar-Raiser Signals

At L6 bar-raiser level, these questions are starting points for a conversation, not prompts for memorized answers. The bar-raiser is evaluating how you think about system design under constraints, not whether you know what ArgoCD is.

For Q15 (regulated industry), the bar-raiser follow-up is: "how do you handle a production incident in a regulated environment when the normal PR approval process would take too long?" The expected answer involves a pre-designed break-glass procedure: a documented emergency process with elevated privileges, an automatic security alert triggered when the procedure is invoked, and a mandatory post-incident PR that captures the emergency change in Git within a defined time window. Candidates who have actually implemented this can describe the specific technical and organizational components. Candidates who have not typically describe "a process we would need to define."

Q13 (multi-cluster deployments) at L6 goes into cluster registration management: how do you rotate cluster credentials stored in ArgoCD when a cluster's service account token expires? How do you handle a cluster being temporarily unreachable during a fleet-wide rollout? What is your circuit breaker for preventing a bad ApplicationSet change from propagating to all clusters simultaneously? These operational failure mode questions distinguish platform engineers who have run production systems from those who have only read about the architecture.

---
