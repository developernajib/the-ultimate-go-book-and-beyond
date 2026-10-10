## 102.5 GitOps with Flux

### Flux Configuration

Flux implements GitOps by running a set of controllers inside the cluster that continuously reconcile live Kubernetes state against manifests stored in a Git repository, the cluster pulls its own desired state rather than being pushed to by an external CI system, which eliminates the need to grant CI pipelines cluster credentials. The `ImageUpdateAutomation` resource closes the deployment loop entirely: when a new image tag matching the semver policy lands in ECR, Flux rewrites the manifest in Git and commits the change, making the image tag promotion itself an auditable, reviewable git commit.

```yaml
# flux-system/gotk-sync.yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: go-service
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/myorg/go-service-infra
  ref:
    branch: main
  secretRef:
    name: github-token

---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: go-service
  namespace: flux-system
spec:
  interval: 10m
  targetNamespace: go-service
  sourceRef:
    kind: GitRepository
    name: go-service
  path: ./k8s/overlays/production
  prune: true
  healthChecks:
    - apiVersion: apps/v1
      kind: Deployment
      name: go-service
      namespace: go-service
  timeout: 2m

---
# Image automation
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageRepository
metadata:
  name: go-service
  namespace: flux-system
spec:
  image: 123456789.dkr.ecr.us-west-2.amazonaws.com/go-service
  interval: 1m
  secretRef:
    name: ecr-credentials

---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImagePolicy
metadata:
  name: go-service
  namespace: flux-system
spec:
  imageRepositoryRef:
    name: go-service
  policy:
    semver:
      range: '>=1.0.0'

---
apiVersion: image.toolkit.fluxcd.io/v1beta1
kind: ImageUpdateAutomation
metadata:
  name: go-service
  namespace: flux-system
spec:
  interval: 1m
  sourceRef:
    kind: GitRepository
    name: go-service
  git:
    checkout:
      ref:
        branch: main
    commit:
      author:
        email: flux@example.com
        name: Flux
      messageTemplate: 'Update go-service to {{.NewTag}}'
    push:
      branch: main
  update:
    path: ./k8s/overlays/production
    strategy: Setters
```

---

### Junior → FAANG: Flux Versus Argo CD and Choosing the Right Tool

Flux and Argo CD solve the same problem (GitOps for Kubernetes) with different designs. Flux is controller-based (each Flux concept is a Kubernetes CRD with its own controller), more modular (you install only the controllers you need), and has native support for Helm, Kustomize, and OCI artifact repositories. Argo CD is application-centric (the Application CRD is the primary concept), has a richer UI for visualization, and is simpler to get started with for teams new to GitOps.

The practical selection criteria: if your organization already uses one, use that one. If starting fresh, prefer Argo CD for teams that value the UI and the centralized application view, and prefer Flux for teams that prefer a more Kubernetes-native, controller-composable approach. Both are CNCF graduated projects with strong production track records.

For first-job engineers, the more important skill is understanding the GitOps mental model (git as the source of truth, continuous reconciliation, no direct cluster access) rather than the specific tool's YAML configuration. The mental model transfers. The YAML syntax requires 30 minutes to re-learn.

### Senior @ FAANG: GitOps Tool Governance and the Source of Truth Hierarchy

At staff level, the GitOps tool choice has architectural implications that become visible only at scale. Argo CD's centralized architecture (one Argo CD instance manages many clusters) requires high availability for the Argo CD control plane: if Argo CD is unavailable, sync operations cannot proceed, and deployments block. Flux's decentralized architecture (Flux controllers run in each managed cluster) means each cluster is self-managing and not dependent on a central control plane.

The source of truth hierarchy in a GitOps deployment requires explicit design. For application configuration, the application's repository is the source of truth. For infrastructure configuration, the infrastructure repository is the source of truth. For cross-cutting configuration (platform defaults, security policies), the platform repository is the source of truth. When these conflict (a service team's configuration overrides a platform default), the conflict resolution rule must be explicit and enforced by the GitOps controllers' merge strategy.

The staff engineer's organizational contribution to GitOps adoption is designing the repository structure, the promotion model, and the access control model before the organization has committed to a specific tool. Getting these design decisions right is more important than the tool selection, because the repository structure and access model are harder to change later than the tool.
