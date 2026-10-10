## 48.2 Istio Integration

### Sidecar vs Ambient: Choosing an Onboarding Model

Istio supports two onboarding models in 2026. In **sidecar mode** (the historical default), pods opt in via the `sidecar.istio.io/inject: "true"` annotation and Envoy is added by the mutating admission webhook. In **ambient mode** (GA since 1.24), onboarding is a namespace label:

```bash
kubectl label namespace production istio.io/dataplane-mode=ambient
```

No pod restart is required for L4 features. ztunnel on each node begins tunneling traffic over HBONE (HTTP-Based Overlay Network Environment, port 15008) with mTLS immediately. When the namespace needs L7 routing, you deploy a waypoint proxy:

```bash
istioctl waypoint apply -n production --for service
```

For the rest of this section we show classic sidecar manifests (still the most common deployment shape in 2026) and note ambient-mode equivalents inline. The critical Go-side observation is that **neither mode requires application changes** - the manifests below work unchanged in either topology, because Istio translates them into the appropriate xDS config for whichever proxy is in the path.

### Kubernetes Deployment with Istio (Sidecar Mode)

A Kubernetes Deployment manifest specifies the desired replica count, container image, resource requests and limits, and liveness/readiness probes. The `sidecar.istio.io/inject: "true"` annotation enables automatic Envoy sidecar injection for the pod, and the `proxyCPU` and `proxyMemory` annotations set resource limits on the injected sidecar container. The Service resource exposes both the HTTP and gRPC ports so the mesh can route traffic to either protocol. In ambient mode this annotation is omitted entirely - the namespace label drives enrollment and the pod spec stays untouched.

```yaml
# kubernetes/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service
  labels:
    app: user-service
    version: v1
spec:
  replicas: 3
  selector:
    matchLabels:
      app: user-service
      version: v1
  template:
    metadata:
      labels:
        app: user-service
        version: v1
      annotations:
        # Istio sidecar injection
        sidecar.istio.io/inject: "true"
        # Resource limits for sidecar
        sidecar.istio.io/proxyCPU: "100m"
        sidecar.istio.io/proxyMemory: "128Mi"
    spec:
      containers:
      - name: user-service
        image: myapp/user-service:v1.0.0
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: grpc
        env:
        - name: PORT
          value: "8080"
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"
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
---
apiVersion: v1
kind: Service
metadata:
  name: user-service
  labels:
    app: user-service
spec:
  ports:
  - port: 80
    targetPort: 8080
    name: http
  - port: 9090
    targetPort: 9090
    name: grpc
  selector:
    app: user-service
```

### Istio Traffic Management

Istio's `VirtualService` resource lets operators route traffic by percentage between service versions without touching Go code. Here, 10% of requests go to `v2` for a canary deployment while 90% remain on `v1`. The `DestinationRule` defines the two subsets and can add per-subset circuit-breaker settings like connection pool limits and outlier detection. Because routing is declared in Kubernetes CRDs and enforced by Envoy, Go developers can ship the same binary for both versions and let the platform control exposure.

```yaml
# istio/virtual-service.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: user-service
spec:
  hosts:
  - user-service
  http:
  # Canary deployment - 10% traffic to v2
  - match:
    - headers:
        x-canary:
          exact: "true"
    route:
    - destination:
        host: user-service
        subset: v2
  - route:
    - destination:
        host: user-service
        subset: v1
      weight: 90
    - destination:
        host: user-service
        subset: v2
      weight: 10
    # Retry configuration
    retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: 5xx,reset,connect-failure
    # Timeout
    timeout: 10s
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: user-service
spec:
  host: user-service
  trafficPolicy:
    # Connection pool settings
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    # Circuit breaker
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
    # Load balancing
    loadBalancer:
      simple: ROUND_ROBIN
  subsets:
  - name: v1
    labels:
      version: v1
  - name: v2
    labels:
      version: v2
```

### Gateway API for North-South Traffic

For ingress traffic entering the mesh from outside the cluster, Istio in 2026 recommends the Kubernetes Gateway API (SIG-Network, GA since v1.0 in October 2023 and the official successor to `Ingress`) over the legacy `Gateway` + `VirtualService` combination. Gateway API separates concerns into three resources: `GatewayClass` (who implements it - `istio` in our case), `Gateway` (listeners and TLS config, owned by the platform team), and `HTTPRoute` (route rules, owned by application teams). The same `HTTPRoute` object is used for east-west mesh traffic when a waypoint proxy is present, so ambient-mode Istio unifies ingress and mesh routing under one API.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: istio-system
spec:
  gatewayClassName: istio
  listeners:
  - name: https
    protocol: HTTPS
    port: 443
    tls:
      mode: Terminate
      certificateRefs:
      - name: prod-tls
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: user-service-route
  namespace: production
spec:
  parentRefs:
  - name: prod-gateway
    namespace: istio-system
  hostnames: ["api.example.com"]
  rules:
  - matches:
    - path: { type: PathPrefix, value: /api/v1/users }
    backendRefs:
    - name: user-service
      port: 80
```

### Istio Authorization Policy and SPIFFE Workload Identity

Istio's `AuthorizationPolicy` CRD controls which services can communicate with each other based on the mTLS identity of the caller. Every workload in an Istio mesh gets a SPIFFE-compliant X.509-SVID (Secure Verifiable Identity Document) of the form `spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>`, issued and rotated automatically by Istiod's built-in CA (or by an external SPIRE server if the organization standardizes workload identity across non-Kubernetes systems). The policy below restricts `user-service` so that only the `order-service` and `api-gateway` SPIFFE identities can reach its API endpoints, while health check paths remain open to the kubelet. A `PeerAuthentication` resource set to `STRICT` mode enforces that all traffic in the namespace must use mTLS - plaintext connections are rejected. The same CRDs apply in ambient mode, enforced at ztunnel (L4 identity and port-level policy) and at the waypoint (L7 method and path matching).

```yaml
# istio/authorization-policy.yaml
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: user-service
  namespace: production
spec:
  selector:
    matchLabels:
      app: user-service
  action: ALLOW
  rules:
  # Allow traffic from specific services
  - from:
    - source:
        principals:
        - "cluster.local/ns/production/sa/order-service"
        - "cluster.local/ns/production/sa/api-gateway"
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/v1/users/*"]
  # Allow health checks
  - to:
    - operation:
        methods: ["GET"]
        paths: ["/health", "/ready"]
---
# Peer authentication (mTLS)
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
```

### Junior → FAANG: Deploying Your First Istio-Integrated Go Service

The gap between reading this section and getting a mesh-integrated service running is mainly a gap in Kubernetes fundamentals rather than in Go code. The Go service itself is almost identical to any other HTTP service. The work is in the manifests.

Key habits for a first deployment:

The port naming convention matters more than most documentation emphasizes. Istio uses the `name` field on `Service` ports to detect protocol: a port named `http` or starting with `http-` gets HTTP/1.1 L7 routing. A port named `grpc` or `grpc-` gets gRPC routing with proper trailer handling. A port named `tcp` gets passthrough. Naming a gRPC port `http` is a frequent mistake that produces subtle failures because Istio sends gRPC traffic over HTTP/1.1 instead of HTTP/2, which breaks streaming RPCs.

The `sidecar.istio.io/inject: "true"` annotation is redundant if the namespace has the `istio-injection: enabled` label, but it is harmless and makes intent explicit. During debugging, being explicit avoids the confusion of "is injection on or off for this pod."

For `VirtualService` retries, the `retryOn` field values are Envoy retry condition strings. `5xx` retries on any 5xx response, which is dangerous for non-idempotent writes. `connect-failure,reset,retriable-4xx` is safer for most internal services. Know the difference before setting retry policy.

For the `AuthorizationPolicy`, the `principals` field takes SPIFFE URI fragments. The prefix `cluster.local/ns/production/sa/order-service` is shorthand for the full SPIFFE URI `spiffe://cluster.local/ns/production/sa/order-service`. Always test authorization policies with `istioctl x describe pod <pod>` which shows the effective policies after all sources are merged.

### Senior @ FAANG: Gateway API Migration, Authorization Policy at Scale, and Upgrade Governance

**Gateway API as the authoritative routing layer.** The Kubernetes Gateway API (v1 GA since October 2023) is the path forward for both north-south and east-west mesh routing. For Go service teams this means two practical changes: (1) `HTTPRoute` is owned by the application team and lives in the application namespace, while `Gateway` is owned by the platform team and lives in `istio-system`. This separation of concerns eliminates the namespace-crossing VirtualService patterns that cause RBAC headaches in large organizations. (2) The same `HTTPRoute` object that handles ingress from outside the cluster handles east-west mesh routing when a waypoint is present, so ambient mode and ingress share one routing API instead of two.

The migration from `VirtualService` to `HTTPRoute` is a compatibility break at the CRD level. Istio supports both simultaneously, but a team running both for the same service risks precedence conflicts. The ADR for migration should specify a cutover date per namespace, not a gradual coexistence period that extends indefinitely.

**AuthorizationPolicy at fleet scale.** When a fleet has two hundred services, maintaining per-service AuthorizationPolicy objects becomes unmanageable without tooling. The pattern used at FAANG-scale organizations is a policy-as-code approach: a Git repository contains the source of truth for which SPIFFE identities may call which services, a CI pipeline generates the AuthorizationPolicy objects from that source, and a GitOps controller (Flux or Argo CD) applies them. Deviation from the generated state triggers an alert. This is not optional at the compliance maturity level that SOC 2 Type II and PCI-DSS require.

**Upgrade governance for Istio.** Istio supports each minor release only until six weeks after the N+2 minor ships, which at the quarterly release cadence works out to roughly six to eight months. A cluster that falls behind by two minor versions is running on an unsupported control plane with no security patches, and the short window means upgrades must be a standing quarterly process rather than an annual project. The platform team's upgrade process should: (1) track Istio CVEs on the `istio-announce` mailing list, (2) maintain a staging cluster running the next minor version at all times, (3) use in-place upgrades for patch releases and canary control plane upgrades (running two Istiod versions simultaneously during the transition) for minor releases. The canary control plane pattern in Istio uses a revision label (`istio.io/rev: 1-21`) to allow individual namespaces to opt in to the new version before the fleet-wide cutover.

**SPIRE integration for multi-environment identity.** When workloads span Kubernetes clusters and EC2 instances (a common pattern during lift-and-shift migrations), the SPIFFE trust domain cannot be cluster-local. SPIRE's server federation capability allows two clusters to share a root CA and mutually trust each other's SVIDs. The Go service code changes nothing: it still uses plain HTTP and the sidecar handles SVID validation. The platform team change is significant: deploying SPIRE server as a highly available component with its own storage backend, and integrating the node attestors for both Kubernetes (projected service account tokens) and EC2 (instance identity documents). This is a multi-quarter platform project, not a configuration change.

---
