## 48.1 Service Mesh Fundamentals

### What is a Service Mesh?

A service mesh intercepts all inter-service traffic through proxies on the data path, transparently adding mutual TLS, observability, and traffic management without changes to application code. The mesh splits into two layers: a control plane that holds configuration and policy, and a data plane of proxies that enforce those policies at the network level. As of 2026, there are three dominant data-plane topologies: (1) classic sidecar (Istio default mode, Linkerd) with an Envoy or linkerd2-proxy inside every pod. (2) Istio ambient mode (GA in 1.24, Nov 2024) using a per-node Rust `ztunnel` for L4 + mTLS and optional per-namespace `waypoint` proxies for L7. And (3) eBPF-based (Cilium Service Mesh) with no user-space proxy at all for L3/L4, pushing policy into kernel programs attached to sockets. All three share the same control-plane/data-plane split the diagram below illustrates.

```go
package main

/*
Service Mesh Capabilities:

1. Traffic Management
   - Load balancing
   - Traffic splitting (canary/blue-green)
   - Retries and timeouts
   - Circuit breaking

2. Security
   - Mutual TLS (mTLS)
   - Authorization policies
   - Certificate management
   - Encryption in transit

3. Observability
   - Distributed tracing
   - Metrics collection
   - Access logging
   - Service topology

4. Resilience
   - Fault injection
   - Rate limiting
   - Health checking
   - Outlier detection

Architecture:
┌─────────────────────────────────────────┐
│              Control Plane              │
│  (Istiod, Linkerd-control-plane, etc.)  │
└─────────────────┬───────────────────────┘
                  │ Config
    ┌─────────────┼─────────────┐
    │             │             │
    ▼             ▼             ▼
┌───────┐    ┌───────┐    ┌───────┐
│ Proxy │    │ Proxy │    │ Proxy │  Data Plane
│(Envoy)│◄──►│(Envoy)│◄──►│(Envoy)│
└───┬───┘    └───┬───┘    └───┬───┘
    │            │            │
┌───┴───┐    ┌───┴───┐    ┌───┴───┐
│Service│    │Service│    │Service│
│   A   │    │   B   │    │   C   │
└───────┘    └───────┘    └───────┘
*/
```

### Sidecar Pattern

In the sidecar pattern, each Kubernetes pod runs two containers: the Go application and an Envoy or linkerd2-proxy sidecar. The sidecar intercepts all inbound and outbound TCP traffic on the pod's network namespace (via `iptables` REDIRECT rules installed by an init container, or via the CNI plugin in newer Istio versions), applying mTLS, retry policies, and telemetry collection entirely outside the Go process. This design means the application code remains unmodified when mesh policies change, and all inter-service traffic is encrypted and traced without any Go library dependencies on the mesh implementation. The downside is linear cost: a 500-pod deployment runs 500 Envoy copies, each consuming 50-150MB of RAM and a fraction of a CPU, even when most pods never need L7 features.

### Ambient Mode (Istio 1.24+, GA since Nov 2024)

Ambient mode eliminates per-pod sidecars and splits the data plane into two tiers. A `ztunnel` DaemonSet runs one Rust proxy per node and handles L4 concerns: mTLS (HBONE tunnel on port 15008), L4 authorization, and telemetry. When an application namespace needs L7 features (HTTP retries, header-based routing, path-level authorization, weighted traffic splitting), a `waypoint` proxy - a standard Envoy - is deployed per namespace or per service account and traffic is transparently routed through it. Applications are onboarded to ambient by labeling the namespace with `istio.io/dataplane-mode=ambient`: no pod restart, no sidecar injection, no application change. Ambient dramatically reduces overhead at scale (fewer proxy instances, no per-pod memory tax for workloads that only need mTLS), but debugging now spans two proxy layers instead of one, and some features (WASM filters on every call, strict L7 mTLS termination inside the pod) require the waypoint tier.

### eBPF Mesh (Cilium Service Mesh)

Cilium takes a different approach: instead of a user-space proxy, it attaches eBPF programs to Linux kernel hooks (sockets, tc, XDP) and implements L3/L4 routing, identity-based policy, and load balancing entirely in kernel space. Cilium still deploys an Envoy per node for L7 features (HTTP routing, gRPC awareness) but avoids the sidecar tax for the large majority of traffic. The trade-off: eBPF requires a reasonably new kernel (5.10+ recommended), and operating it requires kernel-level debugging skill when things go wrong.

```go
package sidecar

/*
Sidecar Pattern:

Each service pod contains:
1. Application container (your Go service)
2. Sidecar proxy (Envoy, Linkerd-proxy)

Benefits:
- Application code remains simple
- Consistent networking behavior
- Language-agnostic
- Centralized policy management

Pod Structure:
┌────────────────────────────────────┐
│                Pod                 │
│  ┌─────────────┐ ┌───────────────┐ │
│  │   Sidecar   │ │  Application  │ │
│  │    Proxy    │ │   Container   │ │
│  │   (Envoy)   │ │  (Go Service) │ │
│  └──────┬──────┘ └───────┬───────┘ │
│         │                │         │
│         │    localhost   │         │
│         └───────────────►│         │
│                          │         │
└──────────────────────────┼─────────┘
                           │
                    Service Traffic
*/

// Application doesn't need special handling
// Traffic flows through sidecar automatically

type SimpleService struct {
    // No special mesh code needed
    db     *sql.DB
    logger *slog.Logger
}

func (s *SimpleService) HandleRequest(w http.ResponseWriter, r *http.Request) {
    // Just write normal code
    // Sidecar handles:
    // - mTLS encryption
    // - Retries
    // - Metrics
    // - Tracing headers
    data, err := s.db.Query("SELECT * FROM users")
    // ...
}
```

### Junior → FAANG: Internalizing the Three Topology Trade-offs

The three data-plane topologies (classic sidecar, ambient, eBPF) are the most common point of confusion for engineers new to service meshes, because the external behavior is nearly identical while the cost and debugging model differ substantially.

Classic sidecar is the safest first choice for a junior engineer: the proxy is co-located with the pod, logs are accessible via `kubectl logs <pod> -c istio-proxy`, and the blast radius of a misconfigured proxy is limited to one pod. The downside is linear memory and CPU cost: every pod pays the sidecar tax whether it needs L7 features or not.

Ambient mode is worth understanding even if you do not operate it, because it is the direction Istio is moving and most large clusters will adopt it over the next few years. The key operational shift is that debugging no longer lives in the pod. When traffic is broken in ambient mode, you look at ztunnel logs on the node first, then waypoint logs in the namespace if L7 is involved. This is a different mental model from sidecar debugging.

eBPF via Cilium is the most technically distinct. The policy is enforced in the kernel, not in a user-space process. This means there is no proxy log to read when something breaks: you use `cilium monitor`, `hubble observe`, or eBPF-specific tooling. Junior engineers should know this exists and understand the trade-off (lowest latency overhead, steepest debugging curve) without being expected to operate it independently.

First-job interview pattern: "Which mesh topology would you choose for a new Kubernetes cluster, and why?" A strong answer picks one, names the reason (for example, sidecar because the team is already familiar with Envoy debugging and needs WASM filter support), and names the condition under which you would revisit (for example, migrate to ambient when pod density crosses 300 per node and sidecar memory becomes a significant fraction of available RAM).

### Senior @ FAANG: Topology Selection as an Organizational Commitment and eBPF Operational Maturity

Selecting a mesh topology at staff level is an organizational decision, not a technical preference. The choice constrains the debugging tooling your SRE team must learn, the kernel version floor for the cluster, the upgrade strategy for the next three to five years, and the feature set available to application teams.

**Sidecar to ambient migration planning.** Organizations running classic sidecar Istio at large scale have accumulated WASM filter chains, Envoy access log formats, and per-pod resource tuning configurations that do not all translate directly to ambient mode. The staff-level migration plan has four phases: (1) audit which namespaces use WASM filters and which L7 features require waypoints, (2) pilot ambient enrollment on a low-risk namespace without L7 requirements, (3) measure CPU and memory delta at the node level (not pod level, since the unit of overhead shifts), (4) establish a waypoint deployment policy for namespaces that need L7 features and document the per-namespace cost model. Rushing phase 2 without phase 1 is how you discover that a critical security WASM filter silently stopped applying.

**eBPF operational maturity model.** Running Cilium Service Mesh requires the platform team to have kernel-level debugging competency. When a Hubble flow is missing or a network policy is not enforcing correctly, the debugging path goes through `bpftool prog list`, `bpftool map dump`, and reading eBPF map entries. This is qualitatively different from reading Envoy access logs. The organizational requirement is at least one engineer with eBPF familiarity on the platform team before you adopt Cilium as your primary mesh. Without that, incidents have no path to root cause.

**SPIFFE trust domain architecture.** The three topologies all use SPIFFE for workload identity, but the trust domain boundary decision has long-term consequences. A single trust domain (`cluster.local`) spanning all environments (dev, staging, prod) means a compromised staging workload has a valid SPIFFE identity in a trust domain that prod workloads also trust. The correct architecture is separate trust domains per environment with explicit federation for the services that legitimately need to cross that boundary. Implementing this correctly requires either SPIRE (which can issue SVIDs to workloads across Kubernetes clusters and VMs under a single root CA) or Istio's multi-cluster root CA sharing with per-cluster intermediate CAs. Candidates who understand this distinction are operating at the security architecture level, not the feature configuration level.

**Governance question for bar-raiser interviews.** "Your organization wants to adopt ambient mode to reduce sidecar costs. What are the three things you must verify before enrolling the first production namespace?" A strong answer covers: (1) whether any namespaces use WASM filters (those require sidecar mode or a waypoint with WASM support, which is still experimental in 2026), (2) whether the CNI plugin on the cluster is compatible with ztunnel (Cilium and some older flannel configurations have known conflicts), and (3) whether the team has updated their incident runbooks to include ztunnel log collection on the relevant node, not just pod logs.

---
