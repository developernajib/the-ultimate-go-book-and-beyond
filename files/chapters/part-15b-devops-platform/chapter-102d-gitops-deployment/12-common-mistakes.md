## 102D.10 Mid-Chapter Synthesis: GitOps & Deployment Anti-Patterns

### 1. Push-Based CI/CD with kubectl in Pipelines

Storing long-lived `KUBECONFIG` credentials in CI secrets and running `kubectl apply` directly from pipelines creates a persistent, broad attack surface and leaves no reconciliation loop to detect or correct configuration drift. The GitOps model inverts this: CI's only job is to update the desired state in Git, and a cluster-side operator like ArgoCD continuously reconciles the live cluster toward what Git declares. Eliminating the need for CI to hold cluster credentials at all.

```yaml
# WRONG: CI pipeline applies directly to cluster
- run: kubectl apply -f kubernetes/ --kubeconfig=${{ secrets.KUBECONFIG }}
# Problems: credentials in CI, no reconciliation, no drift detection

# CORRECT: CI updates Git, ArgoCD applies to cluster
- run: |
    kustomize edit set image myorg/app:${{ github.sha }}
    git commit -am "deploy: ${{ github.sha }}"
    git push
```

### 2. No PodDisruptionBudget During Deployments

Without a PodDisruptionBudget, Kubernetes node maintenance or cluster upgrades can drain a node and evict all pods simultaneously, causing complete service downtime even when a rolling update policy is in place. A PDB enforces a cluster-wide minimum availability constraint independent of the Deployment's own rolling update settings, guaranteeing that at least 80% of pods remain running even when multiple voluntary disruptions happen concurrently.

```yaml
# WRONG: node drain during rolling update can kill all pods simultaneously
# if maxUnavailable=25% and all pods happen to be on drained node

# CORRECT: PDB ensures minimum availability
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shopapp-api-pdb
spec:
  selector:
    matchLabels:
      app: shopapp-api
  minAvailable: "80%"
```

### 3. Not Setting Readiness Probes Correctly

A missing readiness probe causes Kubernetes to route live traffic to pods the moment their container process starts, before the application has finished initializing connections, loading caches, or warming up JIT-compiled code paths. The correctly tuned probe shown here uses `initialDelaySeconds` to absorb startup time, a `failureThreshold` of 3 to tolerate transient blips without premature removal from load balancing, and a dedicated `/ready` endpoint that gates on application-level readiness rather than simple process liveness.

```yaml
# WRONG: no readiness probe = service receives traffic before ready
# OR: readiness probe too aggressive = unnecessary restarts

# CORRECT: readiness probe with appropriate timing
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 10  # wait for app startup
  periodSeconds: 5          # check every 5s
  failureThreshold: 3       # 3 failures = not ready
  successThreshold: 1       # 1 success = ready
```

### 4. Auto-Sync Without Prune in Production

When ArgoCD's `prune` option is disabled, resources that are removed from Git continue running in the cluster indefinitely, leading to ghost services, stale ConfigMaps, and security exposure from resources that operators believe have been deleted. Enabling `prune: true` alongside `selfHeal: true` gives you a truly declarative cluster where Git is the authoritative source of truth. Both adding what is present and removing what is absent.

```yaml
# WRONG: auto-sync without prune can leave orphaned resources
syncPolicy:
  automated:
    selfHeal: true
    # prune: false (default) - deleted resources stay in cluster

# CORRECT for production: enable prune but audit what gets deleted
syncPolicy:
  automated:
    prune: true     # delete resources removed from Git
    selfHeal: true  # revert manual changes
```

### 5. Not Annotating Deployments with Change Metadata

Deployment annotations embed the audit trail. Commit SHA, triggering actor, and timestamp. Directly into the pod spec, making it trivially fast to answer "what changed and who deployed it?" during an incident without digging through CI logs. Because these annotations live in `spec.template.metadata`, any change to them also triggers a rolling update, ensuring the running pods always match the exact metadata of the most recent deployment.

```yaml
# WRONG: no context in deployment history, hard to trace incidents
spec:
  template:
    metadata:
      labels:
        app: shopapp-api

# CORRECT: annotate with deployment metadata
spec:
  template:
    metadata:
      labels:
        app: shopapp-api
      annotations:
        deployment.github.com/sha: "abc123"
        deployment.github.com/actor: "john.doe"
        deployment.github.com/timestamp: "2026-03-13T10:00:00Z"
```

### 6. Ignoring Canary Analysis Failures

A canary deployment that always progresses to 100% regardless of observed metrics offers no protection against bad releases. It is purely cosmetic staged rollout with no automated safety gate. By inserting an `analysis` step that references a metric template such as `success-rate`, Argo Rollouts will automatically abort and roll back if the canary traffic produces error rates or latency above the defined threshold before promotion continues.

```yaml
# WRONG: canary progresses regardless of metrics
steps:
  - setWeight: 10
  - pause: {duration: 5m}
  - setWeight: 100  # always progresses

# CORRECT: gate progression on metric analysis
steps:
  - setWeight: 10
  - pause: {duration: 5m}
  - analysis:
      templates:
        - templateName: success-rate  # abort rollout if this fails
  - setWeight: 100
```

### Junior → FAANG: Building a Checklist from Common Mistakes

Common mistakes sections are worth converting into a deployment checklist that you verify before every production change. For this chapter, the checklist is: does the Deployment have a readiness probe with appropriate timing? Is there a PodDisruptionBudget? Is ArgoCD configured with `prune: true`? Does the canary have an analysis step between each weight increment? Are deployment annotations including commit SHA and actor?

The annotation pattern for deployment metadata (mistake 5) is undervalued by junior engineers and essential for senior engineers. During an incident at 3 AM, the first question is always "what changed?" If every pod has a `deployment.github.com/sha` annotation, the answer is one `kubectl describe pod` away. Without it, you are comparing CI logs and cluster events manually under pressure.

The "CI pipeline needs cluster credentials" mistake (mistake 1) is the entry point for most Kubernetes security conversations. When an interviewer asks about supply chain security for Kubernetes deployments, this is where to start: eliminating cluster credentials from CI is the single most impactful security improvement available to most organizations.

### Senior @ FAANG: Common Mistakes as Organizational Failure Modes

At staff level, these six mistakes are not individual engineer errors. They are organizational failure modes that recur across companies because the correct defaults are not enforced by the platform. Each mistake maps to a specific platform capability that can prevent it at scale.

Mistake 1 (kubectl in CI) requires the platform team to make the GitOps model the path of least resistance. If the only CI template available to application teams commits to the manifests repository and triggers ArgoCD, teams cannot accidentally use the anti-pattern. This is platform as guardrail, not platform as documentation.

Mistake 2 (missing PDB) requires a Conftest policy that fails any PR adding a production Deployment without a matching PodDisruptionBudget. The policy should also validate that the PDB's `minAvailable` value is consistent with the Deployment's replica count, catching cases where a PDB of `minAvailable: 3` is applied to a Deployment with 2 replicas (which would permanently block all voluntary disruptions).

Mistake 4 (auto-sync without prune) represents a category of partial GitOps adoption. Organizations that enable auto-sync but disable prune are implicitly acknowledging that their Git repository is not actually the source of truth: some resources in the cluster are managed outside GitOps and must not be deleted. The correct solution is to bring those resources under GitOps control, not to leave prune disabled. Platform teams should track which Applications have prune disabled and drive that number toward zero as a quarterly platform health metric.

Mistake 6 (ignored canary analysis failures) is the most dangerous because it is invisible. A canary that always promotes regardless of metrics provides false confidence. Organizations in this state believe they have progressive delivery but actually have slow rolling updates with extra infrastructure cost. The platform team should audit all Rollout manifests in the fleet config repository quarterly to verify that every canary step that should have an analysis step actually has one, and that the referenced AnalysisTemplate exists and is correctly configured.

---
