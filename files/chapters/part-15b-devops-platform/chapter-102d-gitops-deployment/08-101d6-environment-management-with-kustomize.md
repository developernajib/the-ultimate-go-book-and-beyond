## 102D.6 Environment Management with Kustomize

### Directory Structure

Kustomize manages environment-specific Kubernetes configuration through a base layer plus overlays. The base directory holds the canonical manifests that are shared across all environments. Each overlay directory adds patches that override specific fields such as replica counts, resource limits, or image tags without duplicating the entire manifest. This structure lets you promote a change through environments by editing only the overlay and leaving the base untouched.

```
k8s/
├── base/                    # shared across all environments
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   └── serviceaccount.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── patches/
    │       ├── replicas.yaml  # 1 replica for dev
    │       └── resources.yaml # smaller CPU/memory
    ├── staging/
    │   ├── kustomization.yaml
    │   └── patches/
    │       └── replicas.yaml  # 2 replicas for staging
    └── production/
        ├── kustomization.yaml
        └── patches/
            ├── replicas.yaml      # 5+ replicas
            ├── resources.yaml     # production sizing
            └── hpa.yaml           # HPA only in production
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - deployment.yaml
  - service.yaml
  - serviceaccount.yaml

commonLabels:
  app: shopapp-api
  managed-by: kustomize
```

```yaml
# base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api  # kustomize will prefix with environment name
spec:
  replicas: 1  # overridden by overlays
  selector:
    matchLabels:
      app: shopapp-api
  template:
    spec:
      serviceAccountName: shopapp-api
      containers:
        - name: api
          image: myorg/shopapp-api:latest  # replaced by image transformer
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          envFrom:
            - configMapRef:
                name: shopapp-api-config
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: shopapp-api-secrets
                  key: db-password
```

```yaml
# overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namePrefix: prod-
nameSuffix: ""
namespace: shopapp-production

bases:
  - ../../base

# Replace image tag (set by CI pipeline)
images:
  - name: myorg/shopapp-api
    newTag: "v1.6.0"  # updated by CI: kustomize edit set image

patchesStrategicMerge:
  - patches/replicas.yaml
  - patches/resources.yaml

resources:
  - patches/hpa.yaml
  - patches/pdb.yaml
  - sealed-secrets.yaml  # encrypted secrets for production
```

```yaml
# overlays/production/patches/replicas.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api
spec:
  replicas: 5
```

### Junior → FAANG: Understanding Kustomize Overlay Structure

The directory structure in this file is the most important thing to understand before writing any Kustomize configuration. The base directory contains valid, standalone Kubernetes YAML that can be applied as-is. Overlays do not modify the base files: they reference the base and layer additional patches on top. This means you can always run `kubectl apply -f base/` in a dev environment without any overlay machinery.

The common beginner mistake is putting environment-specific values in the base. If a value needs to differ between dev and production, it belongs in the overlay patch, not the base. Values that are identical across all environments, such as the container port or the service type, belong in the base. When in doubt, start with the base containing the production-realistic values, then patch down for dev.

For a first project, the `kustomize edit set image` command in CI is the most important thing to understand: it is how image tags flow from the CI build into the Kubernetes manifests without string manipulation. The command updates the `images` transformer in `kustomization.yaml` to pin the specific digest or tag that CI just pushed.

### Senior @ FAANG: Kustomize as a Platform API Surface

At staff level, the Kustomize overlay structure is not just a file organization convention. It is the API surface that application teams use to configure how their services run in each environment. The shape of this structure determines the cognitive load on application teams, the blast radius of platform-level changes, and the ability to enforce organizational standards through automation.

The key design decision is the boundary between what application teams control and what the platform team controls. Application teams should own the overlay patches that configure their service: replica counts, resource limits, environment variables. The platform team should own the base manifests for cross-cutting concerns: security contexts, network policies, service account configuration. A common failure mode is allowing application teams to patch base resources that contain security-sensitive fields, such as adding `securityContext.privileged: true` via an overlay patch that silently bypasses the base's non-root requirement.

The `namePrefix` pattern in the production overlay serves a purpose beyond naming convention: it makes resource names unique across namespaces and makes it immediately clear from any `kubectl get` output which environment a resource belongs to. At scale, with multiple environments sharing a cluster for cost reasons, unique name prefixes are essential for debugging and auditing.

Sealed Secrets in the production overlay highlights the GitOps secret problem. The correct long-term answer is External Secrets Operator, not Sealed Secrets, because Sealed Secrets creates a single-point-of-failure in the cluster's decryption key. If that key is lost without a backup, every sealed secret in every environment must be re-sealed from the original plaintext values, which requires access to those values at a time when the systems that hold them may also be unavailable. Document this risk explicitly in the platform's secret management ADR.

---
