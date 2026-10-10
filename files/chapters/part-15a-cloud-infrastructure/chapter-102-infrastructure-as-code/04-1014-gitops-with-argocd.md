## 102.4 GitOps with ArgoCD

### ArgoCD Application Manifest

An ArgoCD `Application` resource declaratively binds a Git path to a cluster namespace, making Git the authoritative source of truth for cluster state. Setting `selfHeal: true` tells ArgoCD to automatically revert any manual `kubectl` changes that drift from Git, this is the core enforcement mechanism of GitOps. The `ignoreDifferences` block is equally important: it prevents ArgoCD from fighting the Horizontal Pod Autoscaler by exempting the live replica count from drift detection, since HPA owns that field at runtime.

```yaml
# argocd/application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: go-service
  namespace: argocd
spec:
  project: default

  source:
    repoURL: https://github.com/myorg/go-service-infra.git
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
      - CreateNamespace=true
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  # Health checks
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # Ignore HPA changes

---
# ApplicationSet for multiple environments
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: go-service-envs
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - env: dev
            cluster: https://dev.k8s.example.com
            branch: develop
          - env: staging
            cluster: https://staging.k8s.example.com
            branch: main
          - env: prod
            cluster: https://prod.k8s.example.com
            branch: main

  template:
    metadata:
      name: 'go-service-{{env}}'
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/go-service-infra.git
        targetRevision: '{{branch}}'
        path: 'k8s/overlays/{{env}}'
      destination:
        server: '{{cluster}}'
        namespace: go-service
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

### Kustomize Structure for GitOps

Kustomize's base/overlay pattern solves environment-specific configuration without templating: the `base/` directory contains the canonical resource definitions shared by every environment, while each overlay in `overlays/<env>/` patches only what differs, image tags, replica counts, resource limits, and environment-specific config. This means a production promotion is a single `newTag` change in `overlays/production/kustomization.yaml`, committed to Git, which ArgoCD detects and applies without any manual `kubectl` invocation.

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml
  - configmap.yaml
  - hpa.yaml

commonLabels:
  app: go-service
  managed-by: argocd

---
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: go-service

resources:
  - ../../base

images:
  - name: go-service
    newName: 123456789.dkr.ecr.us-west-2.amazonaws.com/go-service
    newTag: v1.2.3

replicas:
  - name: go-service
    count: 5

patches:
  - path: patches/deployment-resources.yaml

configMapGenerator:
  - name: go-service-config
    behavior: merge
    literals:
      - LOG_LEVEL=info
      - ENVIRONMENT=production

secretGenerator:
  - name: go-service-secrets
    type: Opaque
    files:
      - secrets/database-url

---
# k8s/overlays/production/patches/deployment-resources.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
spec:
  template:
    spec:
      containers:
        - name: go-service
          resources:
            requests:
              cpu: "500m"
              memory: "512Mi"
            limits:
              cpu: "2"
              memory: "2Gi"
```

---

### Junior → FAANG: GitOps as the Deployment Model That Closes the Loop

GitOps closes the loop between the declared state (in git) and the actual state (in the cluster). Without GitOps, infrastructure is applied from engineers' laptops or CI runners, and the cluster state may diverge from the repository if someone applies a change manually, if CI is skipped, or if a change is made directly with kubectl. With GitOps, the cluster continuously reconciles against the repository, and any divergence is detected and remediated.

The Argo CD application manifest is the declaration of what to watch (which repository, which path, which revision) and where to deploy (which cluster, which namespace). The sync policy determines whether Argo CD applies changes automatically (automated sync) or requires manual approval (manual sync). For production environments, many teams use automated sync with a manual approval gate for promotion from staging, while using automated sync for staging to reduce friction during development.

Understanding the difference between `OutOfSync` (the cluster state does not match the git state) and `Degraded` (the synced resources are not healthy) is important for operational diagnosis. An `OutOfSync` application needs a sync. A `Degraded` application has been synced but the resources are not running correctly.

### Senior @ FAANG: GitOps Governance and the Multi-Cluster Fleet

At staff level, GitOps is the foundation of multi-cluster fleet management. Argo CD's ApplicationSet controller enables a single template to deploy to dozens of clusters simultaneously, with per-cluster parameterization from a cluster inventory. This is the mechanism for fleet-wide updates (security patches, platform version bumps) that would otherwise require manual per-cluster operations.

The governance concerns for GitOps at FAANG scale: who has permission to modify the GitOps repository (not everyone should be able to deploy to production), how are changes promoted between environments (manual PR approval from staging to production, with automated tests as the gate), and how is the GitOps controller itself upgraded safely (the controller upgrade must not disrupt running sync operations). Each of these is a process design problem that requires organizational agreement before implementation.

The drift remediation policy requires explicit design: should Argo CD automatically revert manual changes to production resources (auto-remediate), or should it alert and wait for human review? Auto-remediation is the GitOps purity model, but it can cause disruption during incident response when engineers are making manual changes to recover. A tiered policy (auto-remediate for configuration, alert-and-wait for stateful resources like databases) is a pragmatic compromise that preserves operational flexibility without undermining GitOps for the majority of cases.
