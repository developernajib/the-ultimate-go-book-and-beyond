## 102D.2 ArgoCD Deep Dive

### Installation

ArgoCD is installed as a set of Kubernetes resources. CRDs, deployments, and RBAC. Into a dedicated `argocd` namespace. The stable manifest installs the ArgoCD server, application controller, repository server, and Redis cache. After installation, the CLI tool `argocd` is used to manage applications, synchronize state, and manage access control.

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# Get admin password
argocd admin initial-password -n argocd

# Login
argocd login argocd.internal --username admin --password <password>
```

### Application CRD

The ArgoCD `Application` custom resource is the central declaration that connects a Git repository path to a Kubernetes cluster and namespace. The `automated` sync policy enables self-healing. ArgoCD continuously reconciles the cluster toward the Git state and reverts any manual changes. The `ignoreDifferences` section is essential for HPA-managed deployments: without it ArgoCD would constantly try to override the replica count that the HPA is adjusting at runtime.

```yaml
# application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: shopapp-api
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io  # cascade delete app resources on app deletion
spec:
  project: production  # ArgoCD project for RBAC

  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: apps/shopapp/overlays/production

  destination:
    server: https://kubernetes.default.svc  # in-cluster
    namespace: shopapp-production

  syncPolicy:
    automated:
      prune: true       # delete resources removed from Git
      selfHeal: true    # revert manual changes (drift)
      allowEmpty: false # don't sync if would result in empty cluster
    syncOptions:
      - CreateNamespace=true
      - PruneLast=true  # delete old resources AFTER new ones are healthy
      - ApplyOutOfSyncOnly=true  # only sync resources that differ
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  # Health assessment
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas  # managed by HPA, don't track in Git
```

### Sync Waves and Hooks

Sync waves control the ORDER resources are applied. Lower waves apply first.

```yaml
# Database migrations before app deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync          # runs BEFORE sync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded  # delete after success
    argocd.argoproj.io/sync-wave: "-1"        # runs before wave 0 (default)
spec:
  template:
    spec:
      containers:
        - name: migrate
          image: myapp:latest
          command: ["./migrate", "--direction=up"]
      restartPolicy: Never
  backoffLimit: 3
---
# Main application (wave 0 = default)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: shopapp-api
  annotations:
    argocd.argoproj.io/sync-wave: "0"
---
# Smoke test after deployment
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-test
  annotations:
    argocd.argoproj.io/hook: PostSync         # runs AFTER sync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      containers:
        - name: test
          image: myapp:latest
          command: ["./smoke-test", "--endpoint=http://shopapp-api"]
      restartPolicy: Never
```

### ApplicationSet - Multi-Cluster/Multi-Environment

`ApplicationSet` is an ArgoCD controller that generates multiple `Application` resources from a single template and a set of parameters. Rather than writing a separate Application manifest for every environment, you define the pattern once and let the list or git-directory generator expand it. This is the standard pattern for managing dozens of microservices across multiple environments without copy-paste proliferation in your GitOps repository.

```yaml
# applicationset.yaml - generate one Application per environment
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shopapp
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - environment: dev
            cluster: dev-cluster
            namespace: shopapp-dev
            replicaCount: "1"
          - environment: staging
            cluster: staging-cluster
            namespace: shopapp-staging
            replicaCount: "2"
          - environment: production
            cluster: prod-cluster
            namespace: shopapp-production
            replicaCount: "5"

  template:
    metadata:
      name: "shopapp-{{environment}}"
      namespace: argocd
    spec:
      project: default
      source:
        repoURL: https://github.com/myorg/k8s-manifests
        targetRevision: main
        path: "apps/shopapp/overlays/{{environment}}"
      destination:
        server: "https://{{cluster}}.k8s.internal"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{environment}}" != "production"  # manual sync in prod
```

### Junior → FAANG: Using ArgoCD Sync Waves in Your First Real Deployment

Sync waves solve a practical problem that every new Kubernetes engineer hits: you update a Deployment that depends on a ConfigMap or database migration, and sometimes the Deployment starts before the dependency is ready. Waves eliminate that race condition by making the ordering declarative.

The worked pattern to memorize: database migration Job at wave `-1` with `hook: PreSync`, application Deployment at wave `0`, smoke test Job at wave `1` with `hook: PostSync`. If the migration Job fails, ArgoCD aborts before touching the Deployment. If the smoke test Job fails, ArgoCD marks the sync failed and you get an alert. This is a better safety net than any startup check you can write inside the application.

First-job mistake to avoid: setting `automated.prune: true` without understanding what it deletes. Before enabling prune on a new Application, run `argocd app diff <name>` and read every resource in the diff. Prune will delete anything present in the cluster but absent from Git, which includes resources you may have manually created for debugging.

### Senior @ FAANG: ArgoCD at Organizational Scale: Sharding, HA, and AppProject Governance

The `Application` CRD and `ApplicationSet` are tools. The organizational model that governs their use is what makes GitOps work at scale. Three concerns dominate at L6.

The first is controller capacity planning. Each ArgoCD Application object adds memory pressure to the application controller. At 500 Applications, the default single-controller deployment begins to show reconciliation lag. The solution is application controller sharding: ArgoCD supports horizontal controller scaling by assigning Application objects to specific controller instances via label-based partitioning. Planning for sharding before you need it is significantly easier than migrating under load.

The second is AppProject as the unit of governance. Every team that owns services should own an AppProject. The AppProject defines which source repositories, which destination clusters and namespaces, and which resource types that team can deploy. This is the GitOps equivalent of IAM: teams cannot deploy to namespaces they do not own, cannot use image registries not in their allowed list, and cannot create cluster-scoped resources unless the AppProject grants it. Designing the AppProject model before teams onboard is essential: retrofitting it to 30 teams with existing Applications is painful and politically fraught.

The third is sync window design. Sync windows are the platform-level deployment freeze mechanism. A `deny` window that covers Friday 16:00 UTC through Monday 09:00 UTC prevents all automated syncs outside business hours, regardless of what individual teams configure on their Applications. This is a compliance requirement in many financial services organizations, and it must be enforced at the AppProject level, not at the Application level, so that teams cannot accidentally or intentionally bypass it.

The `ignoreDifferences` pattern shown for HPA-managed replicas is a common footgun at organizations adopting GitOps with existing HPA configurations. The correct mental model: `ignoreDifferences` declares which fields ArgoCD is not the authority for. Document these exceptions explicitly in the AppProject or Application manifest, because they represent cases where cluster reality intentionally diverges from Git, which is otherwise the definition of a problem.

---
