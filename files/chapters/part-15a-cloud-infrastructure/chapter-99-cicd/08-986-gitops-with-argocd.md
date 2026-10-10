## 99.8 GitOps with ArgoCD

### Understanding GitOps

GitOps treats Git as the single source of truth for both application code and infrastructure configuration. Rather than pushing changes directly into a cluster, operators commit declarative manifests to a repository and let an in-cluster agent continuously reconcile the live state against that desired state. This model gives every deployment a full audit trail and makes rollback as simple as reverting a commit.

```
┌──────────────────────────────────────────────────────────────────┐
│                      GITOPS PRINCIPLES                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. DECLARATIVE                                                  │
│     └── All infrastructure defined as code in Git                │
│                                                                  │
│  2. VERSIONED AND IMMUTABLE                                      │
│     └── Git history = deployment history                         │
│                                                                  │
│  3. PULLED AUTOMATICALLY                                         │
│     └── Cluster pulls desired state from Git                     │
│                                                                  │
│  4. CONTINUOUSLY RECONCILED                                      │
│     └── Actual state always matches Git state                    │
│                                                                  │
│  TRADITIONAL CD:                                                 │
│  CI/CD Server ──push──► Kubernetes Cluster                       │
│                                                                  │
│  GITOPS:                                                         │
│  Developer ──push──► Git ◄──pull── ArgoCD/Flux ──► Cluster       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Complete ArgoCD Setup for Go Services

An ArgoCD `Application` resource wires together a source repository path and a destination cluster namespace, then drives the entire sync lifecycle. The `syncPolicy.automated` block shown here enables pruning of removed resources and self-healing so that any out-of-band manual change is automatically reverted to the Git-declared state.

```yaml
# argocd/base/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: go-service
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/go-service-config
    targetRevision: HEAD
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: go-service
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
      allowEmpty: false
    syncOptions:
      - Validate=true
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### Kustomize Overlays for Environments

Kustomize lets you define a single base manifest set and apply environment-specific patches without duplicating YAML. The base `deployment.yaml` below declares resource limits, health probes, and a container port that every environment inherits, while per-environment `kustomization.yaml` overlays override only the fields that differ, such as replica count, image tag, and namespace prefix.

```yaml
# k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: go-service
  template:
    metadata:
      labels:
        app: go-service
    spec:
      containers:
        - name: go-service
          image: go-service:latest
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
```

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - configmap.yaml
```

```yaml
# k8s/overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
namespace: staging
namePrefix: staging-
commonLabels:
  environment: staging
replicas:
  - name: go-service
    count: 2
images:
  - name: go-service
    newName: ghcr.io/myorg/go-service
    newTag: staging
patches:
  - patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/cpu
        value: "50m"
      - op: replace
        path: /spec/template/spec/containers/0/resources/requests/memory
        value: "64Mi"
    target:
      kind: Deployment
      name: go-service
```

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
namespace: production
namePrefix: prod-
commonLabels:
  environment: production
replicas:
  - name: go-service
    count: 5
images:
  - name: go-service
    newName: ghcr.io/myorg/go-service
    newTag: v1.2.3  # Updated by CI
patches:
  - patch: |-
      - op: add
        path: /spec/template/spec/containers/0/env
        value:
          - name: LOG_LEVEL
            value: "info"
          - name: ENVIRONMENT
            value: "production"
    target:
      kind: Deployment
      name: go-service
```

### Image Updater Automation

ArgoCD Image Updater monitors a container registry and automatically writes new image tags back to the Git repository, keeping the GitOps loop fully closed without manual intervention. The annotations below instruct it to watch `ghcr.io/myorg/go-service`, accept only semver-formatted tags, and commit updates via the `git` write-back method rather than patching the cluster directly.

```yaml
# argocd/image-updater.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: go-service
  annotations:
    argocd-image-updater.argoproj.io/image-list: myapp=ghcr.io/myorg/go-service
    argocd-image-updater.argoproj.io/myapp.update-strategy: semver
    argocd-image-updater.argoproj.io/myapp.allow-tags: regexp:^v[0-9]+\.[0-9]+\.[0-9]+$
    argocd-image-updater.argoproj.io/write-back-method: git
spec:
  # ... application spec
```

### GitHub Actions with ArgoCD

This workflow separates the build pipeline from the deployment concern: the `build` job compiles the Go binary, pushes a versioned container image, and exports the tag as an output. The `update-manifests` job then checks out the separate config repository, calls `kustomize edit set image` to stamp in that tag, and commits the change. ArgoCD detects the new commit and reconciles the production cluster automatically, so no direct `kubectl` or ArgoCD API calls are needed from CI.

```yaml
# .github/workflows/gitops.yaml
name: GitOps Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - name: Generate version
        id: meta
        run: |
          VERSION=v$(date +%Y%m%d)-${{ github.run_number }}-$(git rev-parse --short HEAD)
          echo "version=$VERSION" >> $GITHUB_OUTPUT

      - name: Build and push
        run: |
          docker build -t ghcr.io/myorg/go-service:${{ steps.meta.outputs.version }} .
          docker push ghcr.io/myorg/go-service:${{ steps.meta.outputs.version }}

  update-manifests:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout config repo
        uses: actions/checkout@v4
        with:
          repository: myorg/go-service-config
          token: ${{ secrets.CONFIG_REPO_TOKEN }}

      - name: Update image tag
        run: |
          cd k8s/overlays/production
          kustomize edit set image go-service=ghcr.io/myorg/go-service:${{ needs.build.outputs.image-tag }}

      - name: Commit and push
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git add .
          git commit -m "Deploy go-service ${{ needs.build.outputs.image-tag }}"
          git push

      # ArgoCD will automatically detect the change and sync
```

---

### Junior → FAANG: GitOps as a Mental Model Shift

Traditional CI/CD: push code, run pipeline, pipeline executes deployment commands, cluster state changes. GitOps: push config to a git repository, a controller continuously reconciles the cluster against that repository, cluster state is always the git state. The shift is from imperative deployment commands to declarative state management.

The practical benefit for junior engineers: the cluster state is always auditable via git history, rollback is a git revert, and manual changes to the cluster are detected and remediated automatically. The debugging process for a config change is `git log` and `git diff`, not digging through deployment logs.

Understanding Argo CD's sync phases (desired state from git, live state from cluster, diff computed, sync action applies the diff) and sync waves (a mechanism for ordering resource creation within a sync) is the foundational knowledge for using it effectively.

### Senior @ FAANG: GitOps at Scale and Multi-Cluster Fleet Management

At staff level, GitOps is the foundation of multi-cluster fleet management. With Argo CD's ApplicationSet controller, a single set of configuration templates can drive deployments across dozens of clusters (regional clusters, environment clusters, tenant clusters) with per-cluster parameterization. This is the pattern that makes fleet-wide rollouts (security patches, platform version upgrades) manageable rather than manually applied per cluster.

The GitOps repository structure is a design decision with significant operational implications. A flat structure (one directory per application) is simple but becomes unwieldy at scale. An environment-per-branch model (main for production, staging branch for staging) mixes deployment state with application code in a way that makes git history confusing. The app-of-apps pattern (an Argo CD Application that manages other Argo CD Applications) with a separate "deployment config" repository decoupled from the application source repository is the mature pattern for large-scale GitOps.

The admission control layer for GitOps is an important security design: the Argo CD service account in each cluster needs sufficient permissions to apply the desired resources. Scoping these permissions correctly (namespace-scoped rather than cluster-scoped where possible, specific resource types rather than wildcard verbs) is a least-privilege requirement that needs to be designed alongside the GitOps architecture, not as an afterthought.
