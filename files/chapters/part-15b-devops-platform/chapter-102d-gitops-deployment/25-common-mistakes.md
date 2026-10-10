## 102D.23 Production GitOps & Deployment Pitfalls

GitOps sounds simple - "Git is the source of truth" - but production deployments expose subtle failure modes. These are the five most common mistakes teams make when adopting GitOps, with before/after code examples showing the correct approach.

### Mistake 1: Using `latest` Tag in Production Manifests

`latest` is mutable. Two syncs of the same Git commit can deploy different images if the image was rebuilt between syncs. This silently breaks GitOps' core guarantee: the same Git SHA must always produce the same deployment.

**Before (broken):**

```yaml
spec:
  containers:
    - name: shopapp
      image: registry.example.com/shopapp:latest   # different bits on different days
```

**After (correct - immutable digest):**

```yaml
spec:
  containers:
    - name: shopapp
      image: registry.example.com/shopapp:v1.4.2@sha256:a3b8c9d4e5f601234...
```

In CI, resolve and commit the digest immediately after pushing:

```bash
# After docker build and push
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/shopapp:v1.4.2)
cd infra/overlays/production
kustomize edit set image "shopapp=${IMAGE_DIGEST}"
git commit -m "chore: update shopapp to v1.4.2"
git push
```

### Mistake 2: Mixing Application Code and Deployment Manifests in One Repository

When manifests live inside the application repository, every code commit triggers ArgoCD reconciliation. Over time, Git history mixes application concerns with infrastructure concerns, access control becomes coarse-grained, and PR reviewers cannot tell which changes are code and which are deployments.

**Before (anti-pattern - mixed repository):**

```
shopapp/
├── cmd/
├── internal/
├── go.mod
├── Dockerfile
└── deploy/          # manifests inside the app repo
    ├── base/
    └── overlays/
```

**After (correct - two-repository model):**

```
# Repository 1: shopapp (application code only)
# CI builds the image, then opens a PR in Repository 2

# Repository 2: fleet-config (deployment manifests only)
# Separate branch protection, separate reviewer groups
fleet-config/
└── applications/shopapp/
    ├── base/
    └── overlays/
        ├── staging/
        └── production/
```

Developers own the application code repository. The platform team reviews infrastructure changes. Neither group can accidentally grant themselves access to the other's domain.

### Mistake 3: No Self-Heal - Treating ArgoCD as a One-Shot Deployer

Without `selfHeal: true`, emergency `kubectl` patches accumulate silently. The cluster drifts from Git. The next sync either overwrites the patches unexpectedly or creates conflicts that require manual resolution.

**Before (broken - ArgoCD as manual deployer only):**

```yaml
spec:
  syncPolicy: {}   # no automation - drift accumulates invisibly
```

**After (correct - automated drift correction):**

```yaml
spec:
  syncPolicy:
    automated:
      prune: true
      selfHeal: true      # revert unauthorized changes within 3 minutes
    syncOptions:
      - RespectIgnoreDifferences=true
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # managed by HPA - legitimately out of GitOps scope
```

The discipline required: if a change is worth making, it is worth committing to Git first. Emergency patches must be followed immediately by a Git commit, not left as untracked divergence.

### Mistake 4: Committing Plain-Text Secrets to the Manifests Repository

Even a secret committed and immediately reverted persists in `git log`, `git reflog`, and every clone made before the revert. Once in Git, the only safe assumption is that the secret is compromised.

**Before (catastrophically broken):**

```yaml
apiVersion: v1
kind: Secret
type: Opaque
stringData:
  DATABASE_PASSWORD: "superSecretPass123"  # now in every clone, forever
  STRIPE_SECRET_KEY: "sk_live_abc123"
```

**After (correct - External Secrets Operator):**

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: shopapp-secrets
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: shopapp-secrets
  data:
    - secretKey: DATABASE_PASSWORD
      remoteRef:
        key: "production/shopapp/database"
        property: password
    - secretKey: STRIPE_SECRET_KEY
      remoteRef:
        key: "production/shopapp/stripe"
        property: secret_key
```

Only the path reference lives in Git. The secret value lives exclusively in AWS Secrets Manager. Rotation happens in the secret store. The `ExternalSecret` refreshes automatically on its configured interval.

### Mistake 5: Missing PodDisruptionBudgets Causes Outages During Syncs

ArgoCD syncs trigger rolling updates. Without a PodDisruptionBudget and `maxUnavailable: 0`, a sync combined with concurrent node maintenance can remove all replicas simultaneously.

**Before (vulnerable to outage):**

```yaml
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1   # 1 pod removed; node drain removes another = 2/3 pods gone
      maxSurge: 1
  # No PodDisruptionBudget
```

**After (zero-downtime syncs with quorum protection):**

```yaml
# deployment.yaml
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0   # never remove a pod until its replacement is Ready
      maxSurge: 1
---
# pdb.yaml - must be committed alongside every production Deployment
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: shopapp-pdb
spec:
  minAvailable: 2         # always keep at least 2/3 pods available
  selector:
    matchLabels:
      app: shopapp
```

Enforce this with a Conftest policy that fails any production Deployment directory that does not also contain a `PodDisruptionBudget` for the same `app` label.

### Junior → FAANG: Turning Mistakes into Interview Answers

Common-mistakes sections are underused by most learners. The right way to study them is to build a concrete mental model of the failure scenario before reading the fix, so the fix lands as a solution to a real problem rather than a rule to memorize.

Take Mistake 1 (the `latest` tag). The failure is: two syncs of the same Git commit SHA produce different running binaries, because the image registry rebuilt `latest` between syncs. The GitOps guarantee, "Git SHA determines cluster state," is silently broken. The interview answer writes itself from that framing: `latest` is mutable, immutable tags or digest pins are required because GitOps requires a deterministic mapping from commit to artifact.

Take Mistake 4 (plaintext secrets). The failure is: Git history is permanent and distributed. Every `git clone` made before the revert already contains the secret. The fix is not "use a private repo" or "revert immediately." The fix is a structural constraint: the system makes committing a secret value technically impossible or immediately detected, through pre-commit hooks with `gitleaks` and a CI required check that fails if a Secret manifest contains plaintext values under `stringData` or `data` that match entropy heuristics.

The first-job habit these five mistakes encode: before committing any change to a manifests repository, run through the five mistake categories as a checklist. Is this image pinned to a digest? Is this manifest in the correct repository? Is `selfHeal` configured? Am I introducing a plaintext credential? Does this Deployment have a PDB?

### Senior @ FAANG: Using Common Mistakes to Define Platform Invariants

At staff level, common mistakes become the specification for platform enforcement. Each mistake in this chapter represents a class of error that individual teams will make independently and repeatedly unless the platform makes it structurally impossible. The platform team's job is to convert "common mistake" into "impossible action."

Mistake 1 (`latest` tag) becomes a Conftest policy required in CI that rejects any `image` field not matching the pattern `registry/name:tag@sha256:digest`, with `endswith(image, ":latest")` as an explicit denial rule. The policy runs on every PR modifying `applications/`, is a required status check, and cannot be bypassed by individual teams.

Mistake 2 (mixed repository) becomes an onboarding prerequisite. New services are provisioned through a platform self-service workflow that creates the two-repository structure from a template, with branch protection already configured and CODEOWNERS already pointing to the platform team for the manifests repository. Teams that attempt to add a `deploy/` directory to their application repository get a pre-commit hook failure with a link to the provisioning workflow.

Mistake 3 (no self-heal) becomes a CRD admission webhook. Any ArgoCD Application created without `syncPolicy.automated.selfHeal: true` in a production AppProject is rejected at creation time with an explanatory error. Dev and staging environments allow opt-out with a documented annotation.

Mistake 5 (missing PDB) becomes a Conftest policy that checks for a PodDisruptionBudget with a matching label selector in the same directory as any Deployment with `metadata.labels.environment: production`. This policy is enforced in CI before the change reaches ArgoCD.

The maturity model for a platform team: level 1 is documentation ("don't do X"). Level 2 is code review guidance ("our checklist includes X"). Level 3 is automated detection ("CI fails if X"). Level 4 is structural prevention ("X is technically impossible"). Most organizations plateau at level 2. Level 4 is the FAANG standard for security-relevant policies, because at scale, relying on human reviewers to catch every instance is statistically guaranteed to fail.

---
