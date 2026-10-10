## 98.7 Complete Kustomize Example

### Directory Structure

Kustomize organizes manifests into a `base` directory containing environment-agnostic resources and an `overlays` directory with per-environment customizations. Each overlay references the base and applies targeted patches, meaning you never duplicate YAML, environment-specific differences are expressed as small strategic merge or JSON 6902 patches layered on top of a single source of truth.

```
k8s/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── hpa.yaml
├── overlays/
│   ├── development/
│   │   ├── kustomization.yaml
│   │   └── patches/
│   └── production/
│       ├── kustomization.yaml
│       └── patches/
```

### Base Kustomization

The base `kustomization.yaml` is intentionally minimal, it simply declares which resource files Kustomize should include when building this layer. No environment-specific values appear here. All customization is deferred to overlays, keeping the base shareable across development, staging, and production without modification.

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
  - hpa.yaml
```

### Production Overlay

The production overlay inherits all base resources and then applies production-specific overrides: it pins the image to a concrete release tag, sets the target namespace, and patches the replica count to five via a JSON 6902 operation. Running `kubectl apply -k k8s/overlays/production` merges the base and overlay in memory, so no intermediate YAML files are written and the base remains unchanged.

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
namespace: production
images:
  - name: myapp
    newTag: v1.2.3
patches:
  - patch: |-
      - op: replace
        path: /spec/replicas
        value: 5
    target:
      kind: Deployment
      name: myapp
```

### Junior → FAANG: Kustomize as the Solution to "Copy-and-Paste YAML"

Before Kustomize and Helm, managing Kubernetes configuration across multiple environments (dev, staging, production) meant either copying the entire YAML tree and editing it per environment (error-prone, drift-guaranteed) or using sed/envsubst substitutions (fragile, no validation). Kustomize solves this with a base-and-overlay model: the base has the common configuration, and each environment overlay specifies only what differs.

The practical first-job benefit: when you need to change a resource limit, you change it in one place (the base) and all environments inherit the change. When production needs a different replica count than staging, that difference is expressed explicitly in the production overlay, not silently embedded in a copied file.

The `kustomize build` command renders the final YAML for inspection before applying. Always run `kustomize build overlays/production | kubectl diff -f -` before applying to production. Seeing the exact diff between the live state and what you are about to apply prevents surprises.

### Senior @ FAANG: Configuration Management Strategy: Kustomize Versus Helm Versus Both

At staff level, the Kustomize versus Helm decision is an organizational choice with long-term maintenance implications. Kustomize is patch-based and part of kubectl: zero external dependencies, YAML-in, YAML-out. Helm is template-based and adds the concept of a chart (a versioned, distributable package): powerful parameterization, but templates that become complex quickly and a release management layer that requires operational understanding.

The common pattern at mature organizations is to use both: Helm charts for third-party software (databases, observability tools, ingress controllers) where the chart maintainers provide a tested packaging, and Kustomize for first-party services where the team owns the configuration directly. This separation keeps first-party configuration easy to reason about while still benefiting from the Helm ecosystem for external software.

The staff engineer concern is configuration drift detection. Even with Kustomize and Helm, the live cluster state can diverge from the repository if manual `kubectl apply` or `kubectl edit` is used. GitOps with Argo CD or Flux solves this by making the repository the authoritative state and continuously reconciling the cluster against it. Any manual change is detected and reported, and a configurable policy decides whether to auto-remediate or alert. Adopting GitOps is an organizational change that affects how every team interacts with Kubernetes, and it requires careful rollout planning with the platform team owning the migration strategy.

---
