## 102D.20 Advanced GitOps Patterns

Modern GitOps at scale requires more than a single ArgoCD Application syncing to a single cluster. When organizations operate dozens of clusters across regions, manage hundreds of microservices, and need progressive delivery guarantees, the baseline patterns break down. This section covers production-grade patterns used by organizations deploying across global infrastructure.

### Multi-Cluster GitOps with Fleet Management

Fleet management treats clusters as cattle - each cluster is an instance of a cluster class, not a hand-crafted snowflake. The Git repository structure becomes the source of truth for the entire fleet.

**Fleet Repository Structure:**

```
fleet-config/
├── clusters/
│   ├── us-east-1-prod-01/
│   │   ├── cluster.yaml          # cluster metadata + labels
│   │   └── applications.yaml     # which apps run on this cluster
│   ├── us-west-2-prod-01/
│   │   ├── cluster.yaml
│   │   └── applications.yaml
│   ├── eu-west-1-prod-01/
│   │   ├── cluster.yaml
│   │   └── applications.yaml
│   └── us-east-1-staging-01/
│       ├── cluster.yaml
│       └── applications.yaml
├── cluster-classes/
│   ├── production/
│   │   ├── addons/               # mandatory addons for all prod clusters
│   │   │   ├── monitoring.yaml
│   │   │   ├── policy-engine.yaml
│   │   │   └── secrets-operator.yaml
│   │   └── policies/             # OPA policies enforced on prod
│   └── staging/
│       └── addons/
├── applications/
│   ├── shopapp/
│   │   ├── base/
│   │   ├── overlays/
│   │   │   ├── production/
│   │   │   └── staging/
│   │   └── appset.yaml           # ApplicationSet generating per-cluster apps
│   └── paymentservice/
└── argocd/
    ├── projects.yaml
    └── rbac.yaml
```

**Cluster Registration with Labels:**

```yaml
# clusters/us-east-1-prod-01/cluster.yaml
apiVersion: v1
kind: Secret
metadata:
  name: us-east-1-prod-01
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    environment: production
    region: us-east-1
    tier: primary
    cluster-class: production
    canary-enabled: "true"
type: Opaque
stringData:
  name: us-east-1-prod-01
  server: https://k8s.us-east-1.prod.example.com
  config: |
    {
      "execProviderConfig": {
        "command": "argocd-k8s-auth",
        "args": ["aws", "--cluster-name", "us-east-1-prod-01"],
        "apiVersion": "client.authentication.k8s.io/v1beta1"
      },
      "tlsClientConfig": {
        "insecure": false,
        "caData": "<base64-encoded-ca>"
      }
    }
```

### Argo CD ApplicationSet Controller

The ApplicationSet controller is the fleet management engine within ArgoCD. It generates `Application` objects from templates combined with generators - eliminating manual Application creation for every service/cluster combination.

**Cluster Generator - Deploy to All Production Clusters:**

```yaml
# applications/shopapp/appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shopapp-fleet
  namespace: argocd
spec:
  # RollingSync propagates changes to clusters in ordered stages
  strategy:
    type: RollingSync
    rollingSync:
      steps:
        # Step 1: deploy to staging clusters first
        - matchExpressions:
            - key: environment
              operator: In
              values: [staging]
        # Step 2: deploy to one canary production cluster
        - matchExpressions:
            - key: environment
              operator: In
              values: [production]
            - key: tier
              operator: In
              values: [canary]
          maxUpdate: 1
        # Step 3: roll out remaining production clusters 20% at a time
        - matchExpressions:
            - key: environment
              operator: In
              values: [production]
            - key: tier
              operator: NotIn
              values: [canary]
          maxUpdate: "20%"
  generators:
    - clusters:
        selector:
          matchLabels:
            argocd.argoproj.io/secret-type: cluster
  template:
    metadata:
      name: "shopapp-{{name}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-failed.slack: deployments-alerts
        notifications.argoproj.io/subscribe.on-health-degraded.slack: deployments-alerts
    spec:
      project: shopapp
      source:
        repoURL: https://github.com/org/fleet-config
        targetRevision: HEAD
        path: "applications/shopapp/overlays/{{metadata.labels.environment}}"
        kustomize:
          images:
            - "shopapp=registry.example.com/shopapp:{{metadata.labels.environment}}-latest"
      destination:
        server: "{{server}}"
        namespace: shopapp
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
          allowEmpty: false
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - RespectIgnoreDifferences=true
        managedNamespaceMetadata:
          labels:
            team: platform
            environment: "{{metadata.labels.environment}}"
        retry:
          limit: 3
          backoff:
            duration: 30s
            factor: 2
            maxDuration: 3m
      ignoreDifferences:
        - group: apps
          kind: Deployment
          jsonPointers:
            - /spec/replicas   # managed by HPA, not GitOps
      revisionHistoryLimit: 5
```

**Git Generator - Dynamic App Discovery:**

The Git generator scans a directory in a repository and creates one Application per directory found, enabling teams to self-service onboard new applications without modifying the ApplicationSet.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: team-platform-apps
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          # Axis 1: discover all application directories automatically
          - git:
              repoURL: https://github.com/org/platform-apps
              revision: HEAD
              directories:
                - path: "apps/*/overlays/production"
              exclude:
                - path: "apps/legacy-*/overlays/production"
          # Axis 2: all production clusters
          - clusters:
              selector:
                matchLabels:
                  environment: production
  template:
    metadata:
      name: "{{path.basenameNormalized}}-{{name}}"
    spec:
      project: platform
      source:
        repoURL: https://github.com/org/platform-apps
        targetRevision: HEAD
        path: "{{path}}"
      destination:
        server: "{{server}}"
        namespace: "{{path.basename}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

**Pull Request Generator - Ephemeral Preview Environments:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shopapp-previews
  namespace: argocd
spec:
  generators:
    - pullRequest:
        github:
          owner: org
          repo: shopapp
          tokenRef:
            secretName: github-token
            key: token
          labels:
            - preview          # only PRs with this label get environments
        requeueAfterSeconds: 60
  template:
    metadata:
      name: "shopapp-pr-{{number}}"
    spec:
      project: previews
      source:
        repoURL: https://github.com/org/fleet-config
        targetRevision: HEAD
        path: applications/shopapp/overlays/preview
        kustomize:
          images:
            - "shopapp=registry.example.com/shopapp:pr-{{number}}-{{head_sha}}"
          namePrefix: "pr-{{number}}-"
          commonLabels:
            preview-pr: "{{number}}"
          patches:
            - target:
                kind: Ingress
              patch: |
                - op: replace
                  path: /spec/rules/0/host
                  value: pr-{{number}}.preview.shopapp.example.com
      destination:
        server: https://k8s.staging.example.com
        namespace: "preview-pr-{{number}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
      info:
        - name: "PR Link"
          value: "https://github.com/org/shopapp/pull/{{number}}"
        - name: "Preview URL"
          value: "https://pr-{{number}}.preview.shopapp.example.com"
```

### Progressive Delivery with Argo Rollouts

Argo Rollouts extends Kubernetes `Deployment` with progressive delivery primitives: canary, blue-green, and experiment strategies with automated metric-based promotion and rollback.

**Production-Grade Canary with Prometheus Analysis:**

The `AnalysisTemplate` defines what "success" means for each canary increment. If the analysis fails, the rollout automatically aborts and restores the previous stable version.

```yaml
# analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: shopapp-canary-analysis
  namespace: shopapp
spec:
  args:
    - name: service-name
    - name: canary-hash
    - name: baseline-hash
  metrics:
    # Metric 1: canary error rate must stay below 1%
    - name: error-rate
      interval: 1m
      count: 5
      failureLimit: 1
      successCondition: result[0] <= 0.01
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(http_requests_total{
              job="{{args.service-name}}",
              pod_template_hash="{{args.canary-hash}}",
              status=~"5.."
            }[2m])) /
            sum(rate(http_requests_total{
              job="{{args.service-name}}",
              pod_template_hash="{{args.canary-hash}}"
            }[2m]))

    # Metric 2: p99 latency must stay within 20% of baseline
    - name: latency-comparison
      interval: 1m
      count: 5
      failureLimit: 1
      successCondition: result[0] <= 1.20
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            histogram_quantile(0.99, sum(rate(
              http_request_duration_seconds_bucket{
                job="{{args.service-name}}",
                pod_template_hash="{{args.canary-hash}}"
              }[2m]
            )) by (le))
            /
            histogram_quantile(0.99, sum(rate(
              http_request_duration_seconds_bucket{
                job="{{args.service-name}}",
                pod_template_hash="{{args.baseline-hash}}"
              }[2m]
            )) by (le))

    # Metric 3: business metric - checkout success rate (zero tolerance)
    - name: checkout-success-rate
      interval: 2m
      count: 3
      failureLimit: 0
      successCondition: result[0] >= 0.995
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc.cluster.local:9090
          query: |
            sum(rate(checkout_completed_total{
              pod_template_hash="{{args.canary-hash}}"
            }[4m])) /
            sum(rate(checkout_attempted_total{
              pod_template_hash="{{args.canary-hash}}"
            }[4m]))
```

```yaml
# rollout.yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: shopapp
  namespace: shopapp
spec:
  replicas: 20
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: shopapp
  template:
    metadata:
      labels:
        app: shopapp
    spec:
      containers:
        - name: shopapp
          image: registry.example.com/shopapp:latest
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz/ready
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
  strategy:
    canary:
      canaryService: shopapp-canary
      stableService: shopapp-stable
      trafficRouting:
        istio:
          virtualService:
            name: shopapp-vsvc
            routes:
              - primary
      steps:
        - setWeight: 5
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: shopapp-canary-analysis
            args:
              - name: service-name
                value: shopapp
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
              - name: baseline-hash
                valueFrom:
                  podTemplateHashValue: Stable
        - setWeight: 20
        - pause: {duration: 2m}
        - analysis:
            templates:
              - templateName: shopapp-canary-analysis
            args:
              - name: service-name
                value: shopapp
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
              - name: baseline-hash
                valueFrom:
                  podTemplateHashValue: Stable
        - setWeight: 50
        - pause: {duration: 5m}
        - analysis:
            templates:
              - templateName: shopapp-canary-analysis
            args:
              - name: service-name
                value: shopapp
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
              - name: baseline-hash
                valueFrom:
                  podTemplateHashValue: Stable
        - setWeight: 100
      abortScaleDownDelaySeconds: 30
      scaleDownDelaySeconds: 30
```

**Blue-Green with Pre-Promotion Analysis:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: paymentservice
  namespace: payments
spec:
  replicas: 10
  selector:
    matchLabels:
      app: paymentservice
  template:
    metadata:
      labels:
        app: paymentservice
    spec:
      containers:
        - name: paymentservice
          image: registry.example.com/paymentservice:latest
  strategy:
    blueGreen:
      activeService: paymentservice-active
      previewService: paymentservice-preview
      autoPromotionEnabled: false   # require manual approval for payments
      scaleDownDelaySeconds: 60
      prePromotionAnalysis:
        templates:
          - templateName: payment-smoke-test
        args:
          - name: preview-service
            value: paymentservice-preview
      postPromotionAnalysis:
        templates:
          - templateName: payment-error-rate
        args:
          - name: service
            value: paymentservice-active
```

### Junior → FAANG: Advanced Patterns as Career Preparation

The patterns in this file represent the tooling used by platform engineering teams at L5 and above. Encountering them in a smaller organization context may feel premature, but understanding why they exist is the preparation for moving into roles where they are the baseline expectation.

The fleet repository structure with `cluster-classes/` is the answer to the question "how do you ensure all production clusters have the same security addons and policies?" Without a cluster-class model, each cluster accretes its own configuration over time and consistency is enforced through documentation and hope. With a cluster-class model, adding a new mandatory addon to all production clusters is a single commit to `cluster-classes/production/addons/`, and the ApplicationSet generator propagates it automatically.

The Pull Request generator for preview environments is the pattern that most directly improves developer productivity. When a developer opens a PR, they want to test it before merging. If setting up a test environment requires filing a ticket with the platform team, adoption is low. When the preview environment appears automatically within 5 minutes of pushing the PR and is accessible at a predictable URL, adoption is high. This is platform as a product: the platform team builds a capability that developers adopt without being told to.

### Senior @ FAANG: Fleet Management as a Reliability Engineering Discipline

At L6, fleet management is not a tooling problem but a reliability engineering discipline. The RollingSync strategy in the ApplicationSet is a risk control mechanism: by deploying to staging clusters first, then a single canary production cluster, then the remaining production clusters in 20% batches, the blast radius of a bad release is bounded at each stage. If the canary production cluster shows elevated error rates, the RollingSync can be paused before the rest of the fleet is affected.

The cluster label model (`environment: production`, `tier: primary`, `canary-enabled: "true"`) is a fleet topology encoding that enables fine-grained deployment policies. Labels are the selection mechanism for ApplicationSet generators, sync window policies, and monitoring dashboards. The label schema is an organizational decision that must be defined once and maintained consistently: inconsistent labels across clusters make generator selectors unreliable and monitoring views inaccurate. Define the label schema as part of the cluster onboarding process and enforce it with an admission webhook that rejects cluster Secret objects missing required labels.

The business metric in the canary AnalysisTemplate (`checkout_completed_total / checkout_attempted_total`) represents the maturity level where technical metrics and business metrics are unified. Error rate and latency are necessary but not sufficient: a deployment that maintains 99% HTTP success rate but introduces a bug in the checkout flow that causes silent failures will pass all technical analysis gates. The checkout success rate metric catches this. Designing AnalysisTemplates that include business-critical counters requires collaboration between platform engineering, product engineering, and data engineering, and it is one of the clearest examples of platform work delivering direct business value.

The multi-metric comparison Prometheus query (canary p99 latency divided by stable p99 latency) is the normalized analysis approach that addresses variance from traffic pattern differences. An absolute threshold of 200ms is violated by both canary and stable during traffic spikes, causing false positive aborts. A normalized threshold of 1.20 (canary must not be more than 20% worse than stable) is robust to traffic pattern variance because both are affected equally. This design is the operationally mature approach and should be the default in the platform's AnalysisTemplate library.

---
