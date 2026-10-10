## 98.13 Service Mesh Integration

### Istio for Go Services

Istio extends Kubernetes with powerful traffic management primitives that operate entirely at the infrastructure layer, requiring no changes to Go application code. The `VirtualService` defines routing rules, including header-based canary routing and weighted splits between versioned subsets, while the `DestinationRule` configures the connection pool limits, load balancing algorithm, and outlier detection that eject unhealthy hosts from the pool automatically.

```yaml
# istio/virtual-service.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: go-service
spec:
  hosts:
    - go-service
    - go-service.example.com
  gateways:
    - go-service-gateway
  http:
    # Canary routing - 10% to v2
    - match:
        - headers:
            x-canary:
              exact: "true"
      route:
        - destination:
            host: go-service
            subset: v2
    - route:
        - destination:
            host: go-service
            subset: v1
          weight: 90
        - destination:
            host: go-service
            subset: v2
          weight: 10
      timeout: 30s
      retries:
        attempts: 3
        perTryTimeout: 10s
        retryOn: connect-failure,refused-stream,unavailable
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: go-service
spec:
  host: go-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100
      http:
        h2UpgradePolicy: UPGRADE
        http1MaxPendingRequests: 100
        http2MaxRequests: 1000
    loadBalancer:
      simple: LEAST_CONN
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
---
apiVersion: networking.istio.io/v1beta1
kind: Gateway
metadata:
  name: go-service-gateway
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: go-service-tls
      hosts:
        - go-service.example.com
```

### Circuit Breaker with Istio

Istio implements the circuit breaker pattern through the `outlierDetection` stanza of a `DestinationRule`, which monitors each upstream pod individually and ejects any pod that exceeds the consecutive error threshold from the load-balancing pool for the configured ejection duration. Because this logic lives in the Envoy sidecar rather than application code, it works uniformly across all services in the mesh without requiring libraries or code changes in any Go binary.

```yaml
# istio/circuit-breaker.yaml
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: go-service-circuit-breaker
spec:
  host: go-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 50
      http:
        http1MaxPendingRequests: 50
        http2MaxRequests: 100
        maxRequestsPerConnection: 10
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 100
      minHealthPercent: 0
```

### mTLS Configuration

Istio's `PeerAuthentication` resource enforces mutual TLS between all pods in a namespace when set to `STRICT` mode, ensuring that every service-to-service call is encrypted and that both sides present valid SPIFFE certificates automatically provisioned by Istio's certificate authority. The accompanying `AuthorizationPolicy` then restricts which workloads may call the service and which HTTP methods and path prefixes they are permitted to use, providing fine-grained zero-trust access control without any changes to the Go service itself.

```yaml
# istio/peer-authentication.yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: go-service-auth
  namespace: production
spec:
  selector:
    matchLabels:
      app: go-service
  rules:
    - from:
        - source:
            principals:
              - cluster.local/ns/production/sa/api-gateway
              - cluster.local/ns/production/sa/web-frontend
      to:
        - operation:
            methods: ["GET", "POST"]
            paths: ["/api/*"]
```

### Junior → FAANG: Service Mesh From First Principles

A service mesh adds a sidecar proxy (Envoy in Istio and Linkerd2-proxy in Linkerd) to every pod. All network traffic in and out of the pod flows through the sidecar, which enables: mutual TLS between all services (eliminating the need for application-level TLS), fine-grained traffic management (retries, timeouts, circuit breaking at the network layer), and detailed L7 metrics (per-service, per-route request rates, latency, and error rates) without any application code changes.

The benefit for a junior engineer is that most observability and reliability concerns are handled at the infrastructure layer. A service mesh gives you distributed traces, golden signal metrics, and mTLS without instrumenting each service individually. The cost is operational complexity: the mesh is additional infrastructure with its own upgrade path, its own failure modes, and its own operational skills requirement.

For entry-level understanding, the most important concept is that the sidecar intercepts traffic by modifying the pod's iptables rules at startup (via an init container). The application code does not know the sidecar exists. This transparency is the main design goal of a service mesh.

### Senior @ FAANG: Service Mesh Architecture Decision and Operational Maturity

At staff level, the service mesh decision is one of the highest-impact platform choices made. Installing Istio or Linkerd changes how every pod in the cluster operates, adds a sidecar to every container (with its own resource consumption, startup latency, and upgrade cadence), and introduces a new control plane component that can fail.

The architectural questions that belong in the ADR: which mesh (Istio for maximum features and ecosystem, Linkerd for simplicity and lower overhead, Cilium with eBPF for high-performance environments that can absorb the CNI coupling), ambient versus sidecar mode (Istio's ambient mode removes the per-pod sidecar entirely, reducing overhead significantly), and rollout strategy (namespace-by-namespace adoption with clear rollback criteria).

The operational concerns that are frequently underestimated: control plane upgrades (the mesh control plane and data plane must be kept in a compatible version range; mismatches cause subtle connectivity issues), certificate rotation (the mesh issues short-lived certificates for mTLS; the rotation process must work reliably at cluster scale), and resource consumption (at 100 pods per node, each with a sidecar consuming 50-100 MB of memory, the aggregate memory overhead is significant). The staff engineer who proposes a service mesh adoption must include a detailed capacity analysis and an operational runbook before the proposal is credible.

---
