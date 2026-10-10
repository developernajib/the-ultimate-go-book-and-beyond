## Architecture Overview

A service mesh splits its work across two planes: the control plane (Istio Pilot, Linkerd destination) holds policy and distributes configuration, while the data plane (Envoy sidecar proxies) intercepts every packet between services and enforces that policy at runtime. This separation means Go services need no TLS or retry logic in their application code. The sidecar handles mTLS, circuit breaking, and distributed tracing transparently. Understanding this architecture is prerequisite to writing Go services that correctly propagate trace headers and expose gRPC health checks the mesh can query.

```
Service Mesh Deep Dive
======================

Control Plane vs Data Plane:
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CONTROL PLANE                                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         Istiod (or equivalent)                        │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐  │  │
│  │  │    Pilot    │ │   Citadel   │ │   Galley    │ │    Telemetry    │  │  │
│  │  │  (Traffic)  │ │ (Security)  │ │  (Config)   │ │   (Metrics)     │  │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                     Config Push (xDS Protocol)                              │
│           ┌─────────────────────────┼─────────────────────────┐             │
│           │                         │                         │             │
│           ▼                         ▼                         ▼             │
└───────────┼─────────────────────────┼─────────────────────────┼─────────────┘
            │                         │                         │
┌───────────┼─────────────────────────┼─────────────────────────┼─────────────┐
│           │                DATA PLANE                         │             │
│  ┌────────▼────────┐    ┌───────────▼─────────┐    ┌─────────▼──────────┐   │
│  │      Pod A       │    │       Pod B         │    │       Pod C        │  │
│  │  ┌────────────┐  │    │  ┌────────────┐    │    │  ┌────────────┐   │    │
│  │  │   Envoy    │  │    │  │   Envoy    │    │    │  │   Envoy    │   │    │
│  │  │   Proxy    │◄─┼────┼──┤   Proxy    │◄───┼────┼──┤   Proxy    │   │    │
│  │  │  (Sidecar) │  │    │  │  (Sidecar) │    │    │  │  (Sidecar) │   │    │
│  │  └─────┬──────┘  │    │  └─────┬──────┘    │    │  └─────┬──────┘   │    │
│  │        │localhost│    │        │localhost  │    │        │localhost │    │
│  │  ┌─────▼──────┐  │    │  ┌─────▼──────┐    │    │  ┌─────▼──────┐   │    │
│  │  │ Go Service │  │    │  │ Go Service │    │    │  │ Go Service │   │    │
│  │  │    :8080   │  │    │  │    :8080   │    │    │  │    :8080   │   │    │
│  │  └────────────┘  │    │  └────────────┘    │    │  └────────────┘   │    │
│  └──────────────────┘    └────────────────────┘    └───────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘

Traffic Flow with Sidecar:
┌──────────────────────────────────────────────────────────────────────────────┐
│                    INBOUND TRAFFIC FLOW                                      │
│                                                                              │
│  External        Pod A                                    Go Service         │
│  Request    ┌─────────────────────────────────────────┐                      │
│      │      │     ┌─────────────────────────────┐     │                      │
│      ▼      │     │         Envoy Proxy         │     │                      │
│  ┌──────┐   │     │ ┌───────┐ ┌─────┐ ┌───────┐ │     │                      │
│  │ :80  │───┼────►│ │ mTLS  │►│AuthZ│►│Metrics│─┼─────┼───►:8080             │
│  └──────┘   │     │ │Decrypt│ │Check│ │Record │ │     │                      │
│             │     │ └───────┘ └─────┘ └───────┘ │     │                      │
│             │     └─────────────────────────────┘     │                      │
│             └─────────────────────────────────────────┘                      │
├──────────────────────────────────────────────────────────────────────────────┤
│                    OUTBOUND TRAFFIC FLOW                                     │
│                                                                              │
│  Go Service       Pod A                                   External Service   │
│      │      ┌─────────────────────────────────────────┐        │             │
│      │      │     ┌─────────────────────────────┐     │        │             │
│      │      │     │         Envoy Proxy         │     │        │             │
│      │      │     │ ┌───────┐ ┌─────┐ ┌───────┐ │     │        │             │
│   :8080 ────┼────►│ │Metrics│►│mTLS │►│LoadBal│─┼─────┼───────►│             │
│             │     │ │Record │ │Encr │ │ancer  │ │     │        │             │
│             │     │ └───────┘ └─────┘ └───────┘ │     │        │             │
│             │     └─────────────────────────────┘     │        │             │
│             └─────────────────────────────────────────┘        │             │
└──────────────────────────────────────────────────────────────────────────────┘

Mutual TLS (mTLS) Flow:
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Service A Pod                              Service B Pod                    │
│  ┌─────────────────────┐                   ┌─────────────────────┐           │
│  │  ┌─────────────┐    │                   │    ┌─────────────┐  │           │
│  │  │   Envoy A   │    │                   │    │   Envoy B   │  │           │
│  │  │             │    │  mTLS Connection  │    │             │  │           │
│  │  │ ┌─────────┐ │    │                   │    │ ┌─────────┐ │  │           │
│  │  │ │ Client  │─┼────┼───────────────────┼────┼─│ Server  │ │  │           │
│  │  │ │  Cert   │ │    │  1. TLS Handshake │    │ │  Cert   │ │  │           │
│  │  │ └─────────┘ │    │  2. Mutual Verify │    │ └─────────┘ │  │           │
│  │  │             │    │  3. Encrypted     │    │             │  │           │
│  │  └──────┬──────┘    │     Traffic       │    └──────┬──────┘  │           │
│  │         │ plaintext │                   │  plaintext│         │           │
│  │  ┌──────▼──────┐    │                   │    ┌──────▼──────┐  │           │
│  │  │ Go Service  │    │                   │    │ Go Service  │  │           │
│  │  │ (no TLS)    │    │                   │    │ (no TLS)    │  │           │
│  │  └─────────────┘    │                   │    └─────────────┘  │           │
│  └─────────────────────┘                   └─────────────────────┘           │
│                                                                              │
│  Certificate Chain (managed by control plane):                               │
│  Root CA → Intermediate CA → Workload Cert (auto-rotated)                    │
└──────────────────────────────────────────────────────────────────────────────┘

Observability Integration:
┌──────────────────────────────────────────────────────────────────────────────┐
│                         MESH OBSERVABILITY                                   │
│                                                                              │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                                   │
│  │ Service │    │ Service │    │ Service │                                   │
│  │    A    │    │    B    │    │    C    │                                   │
│  └────┬────┘    └────┬────┘    └────┬────┘                                   │
│       │              │              │                                        │
│       └──────────────┼──────────────┘                                        │
│                      │                                                       │
│                      ▼                                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                    Envoy Telemetry                                    │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐  │   │
│  │  │   Metrics   │ │   Traces    │ │ Access Logs │ │   Topology      │  │   │
│  │  │ (Prometheus)│ │  (Jaeger)   │ │ (Fluentd)   │ │   (Kiali)       │  │   │
│  │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └────────┬────────┘  │   │
│  └─────────┼───────────────┼───────────────┼─────────────────┼───────────┘   │
│            │               │               │                 │               │
│            ▼               ▼               ▼                 ▼               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                      Observability Stack                                │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  │ │
│  │  │  Prometheus  │ │    Jaeger    │ │ Elasticsearch│ │     Kiali      │  │ │
│  │  │  + Grafana   │ │              │ │  + Kibana    │ │  (Topology)    │  │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘

Traffic Management:
┌──────────────────────────────────────────────────────────────────────────────┐
│                    CANARY DEPLOYMENT                                         │
│                                                                              │
│  Incoming Traffic                                                            │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────┐                                                         │
│  │   VirtualService│                                                         │
│  │   weight: 90/10 │                                                         │
│  └────────┬────────┘                                                         │
│           │                                                                  │
│     ┌─────┴─────┐                                                            │
│     │           │                                                            │
│     ▼ 90%       ▼ 10%                                                        │
│  ┌──────┐    ┌──────┐                                                        │
│  │ v1.0 │    │ v1.1 │                                                        │
│  │ pods │    │ pods │  ← Monitor error rate, latency                         │
│  └──────┘    └──────┘                                                        │
│                                                                              │
│  Rollout: 10% → 25% → 50% → 100%                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                    A/B TESTING                                               │
│                                                                              │
│  ┌─────────────────┐     Header: x-user-group: beta                          │
│  │   VirtualService│ ─────────────────────────────────►  Version B           │
│  │   match: headers│                                                         │
│  └─────────────────┘     No header                                           │
│           │          ─────────────────────────────────►  Version A           │
├──────────────────────────────────────────────────────────────────────────────┤
│                    CIRCUIT BREAKER                                           │
│                                                                              │
│  DestinationRule:                                                            │
│  ┌─────────────────────────────────────────────────┐                         │
│  │  outlierDetection:                              │                         │
│  │    consecutive5xxErrors: 5                      │                         │
│  │    interval: 10s                                │                         │
│  │    baseEjectionTime: 30s                        │                         │
│  │    maxEjectionPercent: 50                       │                         │
│  └─────────────────────────────────────────────────┘                         │
│                                                                              │
│  If 5+ consecutive 5xx errors → eject for 30s                                │
│  Max 50% of endpoints can be ejected                                         │
└──────────────────────────────────────────────────────────────────────────────┘

Service Mesh Comparison:
┌─────────────────┬───────────────┬───────────────┬───────────────────────────┐
│                 │    Istio      │   Linkerd     │      Consul Connect       │
├─────────────────┼───────────────┼───────────────┼───────────────────────────┤
│ Data Plane      │ Envoy         │ linkerd2-proxy│ Envoy or built-in         │
│ Language        │ C++           │ Rust          │ C++ / Go                  │
│ Resource Usage  │ Higher        │ Lower         │ Medium                    │
│ Complexity      │ High          │ Medium        │ Medium                    │
│ Multi-cluster   │ Yes           │ Yes           │ Yes                       │
│ mTLS           │ Yes           │ Yes (default) │ Yes                        │
│ Protocol Support│ HTTP/gRPC/TCP │ HTTP/gRPC/TCP │ HTTP/gRPC/TCP             │
│ Best For        │ Feature-rich  │ Simplicity    │ HashiCorp ecosystem       │
└─────────────────┴───────────────┴───────────────┴───────────────────────────┘
```

### Junior → FAANG: Reading the Architecture Before Writing Code

The architecture diagrams in this section carry more information than they appear to at first. A common junior mistake is to skip the diagrams and jump to code. Before writing a single line of Go for a mesh-integrated service, you need to be able to answer three questions by looking at these diagrams.

First: where does my code actually run? It runs in the application container, listening on localhost. The sidecar proxy sits beside it and intercepts traffic before it enters or leaves the pod. Your Go HTTP server binds to port 8080 and knows nothing about TLS or retry policy.

Second: what is the iptables rule doing? The init container (or CNI plugin) installs rules that redirect all inbound and outbound TCP traffic through the sidecar on ports 15001 (outbound) and 15006 (inbound). This is why your Go service can use a plain `http.Client` and still get mTLS transparently. If you bypass iptables (for example, by connecting directly to `localhost` on the loopback interface to another container in the same pod), the sidecar does not intercept the traffic.

Third: what travels over xDS? Listener Discovery Service (LDS) tells the proxy what ports to listen on. Route Discovery Service (RDS) tells it how to route those requests to clusters. Cluster Discovery Service (CDS) tells it what backend endpoints exist. Endpoint Discovery Service (EDS) tells it the actual IP addresses. If any of these are stale, routing breaks in predictable ways. `istioctl proxy-config listener <pod>` and `istioctl proxy-config cluster <pod>` let you inspect the proxy's current view of each.

Interview entry point: being able to trace a single request through the inbound flow diagram (mTLS decrypt, AuthZ check, metrics record, forward to localhost:8080) and explain what happens at each step puts you ahead of most candidates at a junior screen.

### Senior @ FAANG: Control Plane Topology, xDS at Scale, and Observability Architecture

The architecture diagram shows the happy path. Staff-level thinking is about the failure modes of each layer and the organizational decisions that determine which topology you operate.

**xDS push latency.** When a new pod starts or a VirtualService changes, Istiod must push updated configuration to every affected proxy in the fleet. At ten thousand pods, a naive full-push is expensive. Istiod uses delta xDS (incremental pushes) and scopes pushes to affected proxies via its Sidecar resource. Without explicit Sidecar scoping, every proxy in the mesh receives every endpoint update. At scale this is a significant control-plane CPU and network cost. The ADR for a large mesh should explicitly address Sidecar scoping strategy: namespace-scoped by default, with explicit export for shared services.

**Observability architecture decisions.** The diagram shows Prometheus, Jaeger, Elasticsearch, and Kiali as separate components. In 2026 most large deployments consolidate: Grafana Alloy (or the OTel Collector) scrapes metrics from Envoy's `/stats/prometheus` endpoint and ships to a central Mimir or Thanos backend. Traces go to Tempo rather than Jaeger for better storage efficiency. The critical architectural decision is the retention and cardinality budget. Envoy emits high-cardinality metrics by default (per-source, per-destination labels) that can explode a Prometheus TSDB. The platform team must decide which labels to keep and drop at the collection layer, not at query time.

**Multi-cluster architecture.** The comparison table shows all three mesh products support multi-cluster, but the implementation models differ significantly. Istio multi-primary (each cluster runs its own Istiod with a shared root CA) provides strong isolation and survives a control-plane partition in one cluster. Istio single-primary (one Istiod manages remote clusters' proxies) is simpler but creates a hard dependency on the primary cluster's control plane. Linkerd multicluster uses a gateway-based model where cross-cluster traffic is always routed through a dedicated gateway pod, making cross-cluster connectivity explicit and auditable. The choice depends on failure isolation requirements, not on which product is "better."

**Bar-raiser framing.** The observability integration diagram is deceptively simple. A bar-raiser question at L6: "Your Prometheus is dropping 30% of mesh metrics samples under load. How do you diagnose and fix this without losing coverage of SLO-critical paths?" The answer involves understanding scrape intervals relative to Envoy's stats flush interval, identifying which metric families are highest-cardinality, using recording rules to pre-aggregate, and potentially moving to remote-write with a dedicated metrics proxy to decouple scrape load from storage load. Candidates who answer "increase Prometheus resources" are not thinking at the right level.

---
