## 48.8 Interview Questions

### Question 1: What problems does a service mesh solve?

**Answer:**

A service mesh addresses cross-cutting concerns that are common across all microservices:

```go
// Problems solved by service mesh:

// 1. SECURITY - mTLS without application changes
// Without mesh:
func insecureClient() *http.Client {
    // Each service must implement TLS
    cert, _ := tls.LoadX509KeyPair("cert.pem", "key.pem")
    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: &tls.Config{
                Certificates: []tls.Certificate{cert},
                // Manual certificate management
            },
        },
    }
}

// With mesh:
func meshClient() *http.Client {
    // Plain HTTP - mesh handles encryption
    return &http.Client{}
}

// 2. OBSERVABILITY - Automatic metrics, traces, logs
// Without mesh: Manual instrumentation in every service
// With mesh: Envoy automatically collects:
// - Request count, latency, error rate
// - Distributed traces
// - Access logs

// 3. TRAFFIC MANAGEMENT - Without code changes
// Canary deployments, A/B testing, circuit breakers
// All configured via CRDs, not code

// 4. RELIABILITY - Automatic retries, timeouts
// Without mesh:
func unreliableCall(ctx context.Context) error {
    var lastErr error
    for i := 0; i < 3; i++ {
        ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
        defer cancel()

        if err := s.client.Call(ctx); err == nil {
            return nil
        } else {
            lastErr = err
        }
    }
    return lastErr
}

// With mesh: Retries configured in VirtualService
// Application code is simple:
func reliableCall(ctx context.Context) error {
    return s.client.Call(ctx) // Mesh handles retries
}
```

**What FAANG expects:** Mention the operational leverage (one policy change updates the whole fleet) and the failure modes it removes (per-service re-implementation of retries / circuit breakers drifts in subtle ways). Top candidates also name what a mesh does *not* solve: it cannot fix application-level bugs, slow database queries, or incorrect retry idempotency (retrying a non-idempotent write at the mesh layer is a bug multiplier, not a reliability win).

**Follow-ups:**
- *When would you **not** adopt a service mesh?* Small fleets (under 10 services) where library-based solutions (gRPC interceptors, OpenTelemetry) are cheaper than a mesh's operational overhead. regulated environments where the mesh control plane itself is a compliance scope you cannot absorb.
- *Mesh vs gRPC interceptors - what's the boundary?* Meshes are language-agnostic and enforce policy centrally. interceptors are in-process and can access business context (user ID, tenant) that the mesh cannot see. Production systems often use both: mesh for identity/mTLS/observability, interceptors for domain-specific logic.
- *How does adopting a mesh change your on-call surface?* You now own a control plane (Istiod) whose outage can stall config pushes, and two proxy layers of logs/metrics. Candidates who have operated meshes mention the debugging cost, not just the benefits.

### Question 2: How does mTLS work in a service mesh?

**Answer:**

Mutual TLS in a service mesh works transparently to application code. The control plane issues short-lived certificates to each workload, the sidecar proxy handles the TLS handshake on both sides, and the application communicates over plain HTTP on localhost. The key insight is that the application never touches certificates. The mesh manages the entire lifecycle from issuance through rotation to revocation.

```go
// mTLS in service mesh explained

/*
1. Certificate Provisioning (by control plane):
   - Each workload gets a unique certificate
   - Certificates include SPIFFE identity
   - Automatic rotation (typically 24h)

2. Connection Flow:
   App A → Envoy A → (mTLS) → Envoy B → App B

3. What happens at each step:
*/

type MTLSFlow struct{}

func (f *MTLSFlow) OutboundFromAppA() {
    // App A makes plain HTTP request to localhost
    // Envoy intercepts via iptables redirect
}

func (f *MTLSFlow) EnvoyAProcessing() {
    // 1. Envoy A looks up destination in service registry
    // 2. Gets routing rules from control plane
    // 3. Initiates mTLS handshake with Envoy B:
    //    - Presents its certificate (signed by mesh CA)
    //    - Validates Envoy B's certificate
    //    - Establishes encrypted connection
}

func (f *MTLSFlow) EnvoyBProcessing() {
    // 1. Validates client certificate
    // 2. Extracts identity (SPIFFE URI)
    // 3. Checks authorization policy
    // 4. If allowed, forwards to local app (plain HTTP)
}

// Certificate identity format (SPIFFE):
// spiffe://cluster.local/ns/production/sa/user-service

// Authorization policy example:
/*
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: allow-order-to-user
spec:
  selector:
    matchLabels:
      app: user-service
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/production/sa/order-service"]
*/
```

**What FAANG expects:** Name the standard (SPIFFE), the cert type (X.509-SVID), the rotation cadence (24h default in Istio, often shorter), and the identity binding (Kubernetes ServiceAccount to SPIFFE URI). Top candidates distinguish the trust domain (`cluster.local`), the namespace, and the workload identity and note that SPIFFE is vendor-neutral - SPIRE can issue identities to VMs and bare metal so workloads outside Kubernetes join the same trust boundary.

**Follow-ups:**
- *What happens during certificate rotation?* The node agent (istio-agent) pulls a new cert from Istiod before the old one expires and hot-reloads it into Envoy via SDS (Secret Discovery Service). Connections in flight are not broken because the rotation is near-zero-downtime.
- *How does ambient mode handle mTLS differently?* The L4 `ztunnel` terminates mTLS at the node boundary using HBONE (HTTP CONNECT tunnels over port 15008), while pod-to-ztunnel traffic stays on the node's network namespace. The cryptographic guarantee is the same, but the enforcement point moves from the pod to the node.
- *Can an attacker who compromises one pod forge another workload's identity?* No - the private key is generated on the node agent and never leaves it. The attacker inherits only the compromised pod's SPIFFE identity, which is why RBAC at the SPIFFE-ID level matters.

### Question 3: What's the overhead of a service mesh?

**Answer:**

A service mesh adds latency (typically 1-3ms per hop), memory (50-100MB per Envoy sidecar), and CPU overhead to every pod. The control plane itself requires dedicated resources. Whether this cost is justified depends on the number of services, compliance requirements, and operational complexity that the mesh eliminates. The numbers below reflect typical Istio deployments.

```go
// Service mesh overhead breakdown

type MeshOverhead struct {
    // 1. Latency overhead
    LatencyPerHop time.Duration // ~1-3ms per hop

    // 2. Memory overhead per pod
    EnvoyMemory int // ~50-100MB base, can grow

    // 3. CPU overhead
    EnvoyCPU float64 // ~0.1-0.5 CPU per pod

    // 4. Control plane resources
    ControlPlaneCPU    float64 // 1-4 CPU for Istiod
    ControlPlaneMemory int     // 1-4GB for Istiod
}

// When overhead is acceptable:
func shouldUseMesh() bool {
    considerations := []string{
        "More than 10 services",
        "Multiple teams needing consistent policies",
        "Compliance requirements (mTLS, audit)",
        "Complex traffic management needs",
        "Debugging distributed systems",
    }
    // If 3+ apply, mesh overhead is usually worth it
}

// Minimizing overhead:
/*
1. Right-size Envoy resources:
   sidecar.istio.io/proxyCPU: "100m"
   sidecar.istio.io/proxyMemory: "128Mi"

2. Disable unnecessary features:
   - If not using tracing: disable it
   - If not using access logs: disable them

3. Use protocol detection carefully:
   - Explicit protocol declaration is faster
   - ports:
     - name: grpc  # Explicit protocol
       port: 9090

4. Consider ambient mesh (Istio):
   - No sidecar per pod
   - Shared proxy per node
   - Lower overhead, some feature limitations
*/

// Benchmark results (typical):
// Without mesh:
//   Request latency p50: 5ms
//   Request latency p99: 20ms

// With mesh:
//   Request latency p50: 6-8ms (+1-3ms)
//   Request latency p99: 23-28ms (+3-8ms)
```

**What FAANG expects:** Quantify per-hop, per-pod, and control-plane cost separately, and know that ambient mode (GA Nov 2024) and eBPF meshes (Cilium) cut the per-pod cost to near zero by removing sidecars. Top candidates also mention the hidden cost: two extra proxies in the request path mean two more places a request can be misrouted or delayed during incidents, and debugging that takes engineer-hours that budget-comparison tables never capture.

**Follow-ups:**
- *Where does the 1-3ms per-hop latency actually come from?* Userspace context switches (pod -> Envoy), iptables redirect, TLS handshake (amortized by connection reuse), and Envoy's filter chain. HBONE/ambient keeps the TLS but removes the per-pod hop for the common L4 case.
- *How would you measure mesh overhead on your own workload?* Deploy the same service with and without injection (or in namespaces with/without ambient enrollment), run identical load tests, compare p50/p99 latency and CPU/memory. Do not trust generic benchmarks - Envoy overhead scales with filter-chain complexity, not with traffic volume alone.
- *What's the failure mode if you tune Envoy too tightly?* OOMKilled pods under bursty traffic, dropped connections at connection-pool limits, missed spans in telemetry. Right-sizing is per-workload, not a fleet-wide default.

### Question 4: How do you debug issues in a service mesh?

**Answer:**

Debugging mesh issues requires working at three layers: the Envoy proxy (checking its admin endpoints and logs), the Istio control plane (using `istioctl` diagnostics), and the distributed trace data (correlating latency across spans). Most mesh problems (503 errors, connection refused, mTLS failures) have specific diagnostic commands that pinpoint the root cause.

```go
// Debugging service mesh issues

// 1. Check Envoy proxy status
func checkEnvoyHealth(podName, namespace string) error {
    // kubectl exec -n <ns> <pod> -c istio-proxy -- pilot-agent request GET /ready

    // Key endpoints:
    // /ready - Is proxy ready?
    // /stats - Detailed metrics
    // /clusters - Upstream cluster status
    // /config_dump - Full configuration
    return nil
}

// 2. Analyze Envoy logs
func enableDebugLogging() {
    // kubectl exec <pod> -c istio-proxy -- \
    //   curl -X POST localhost:15000/logging?level=debug

    // Check logs:
    // kubectl logs <pod> -c istio-proxy
}

// 3. Use istioctl for diagnostics
func istioDebugCommands() []string {
    return []string{
        // Analyze configuration issues
        "istioctl analyze -n production",

        // Check proxy sync status
        "istioctl proxy-status",

        // Debug specific pod
        "istioctl proxy-config cluster <pod>",
        "istioctl proxy-config route <pod>",
        "istioctl proxy-config listener <pod>",

        // Describe how traffic flows
        "istioctl x describe pod <pod>",
    }
}

// 4. Check trace data
type TraceDebugger struct {
    jaegerURL string
}

func (d *TraceDebugger) FindSlowSpans(traceID string) []SlowSpan {
    // Query Jaeger for trace
    // Find spans with high latency
    // Check if latency is in:
    // - Application code (app span)
    // - Network (gap between spans)
    // - Proxy (envoy spans)
    return nil
}

// 5. Common issues and solutions
var commonIssues = map[string]string{
    "503 errors":       "Check DestinationRule, circuit breaker, or no healthy endpoints",
    "Connection refused": "Service not running or port mismatch",
    "mTLS errors":      "Check PeerAuthentication mode and certificate validity",
    "Timeout":          "Check VirtualService timeout, adjust or investigate slow service",
    "No route":         "Missing VirtualService or wrong host in request",
}
```

**What FAANG expects:** A systematic three-layer mental model (app -> proxy -> control plane) and familiarity with `istioctl proxy-status`, `istioctl analyze`, and the Envoy admin port (15000). Top candidates also mention correlation IDs and the need to trace one request's path across both sidecars (caller Envoy out, callee Envoy in) before blaming application code.

**Follow-ups:**
- *How do you debug in ambient mode where there's no per-pod proxy?* Two new places to look: `kubectl logs` on the ztunnel DaemonSet pod on the affected node, and the waypoint pod in the namespace. `istioctl ztunnel-config` and `istioctl waypoint status` are the ambient-mode equivalents of `istioctl proxy-config`.
- *A service works in curl-from-inside-the-pod but fails through the mesh - what's your first hypothesis?* Missing `PeerAuthentication`, wrong port naming (Istio uses the port name prefix to detect protocol: `http-`, `grpc-`, `tcp-`), or a `DestinationRule` that sends traffic to a `subset` with no matching pods.
- *How do you find the bad pod in a 500-replica deployment?* Jaeger trace filtered by 5xx status reveals the pod label. `istioctl proxy-status` shows which pods are out of sync with the control plane (a common cause of stale routes).

### Question 5: How would you implement canary deployments with a service mesh?

**Answer:**

A canary deployment with Istio involves three steps: deploy the canary version as a separate Kubernetes Deployment with a distinct `version` label, create a `VirtualService` that splits traffic by weight between the stable and canary subsets, and progressively increase the canary's weight while monitoring error rates and latency. If metrics exceed thresholds, the controller sets canary weight to 0, routing all traffic back to stable.

```go
// Canary deployment with Istio

// Step 1: Deploy canary version
// kubernetes/deployment-canary.yaml
/*
apiVersion: apps/v1
kind: Deployment
metadata:
  name: user-service-canary
spec:
  replicas: 1
  template:
    metadata:
      labels:
        app: user-service
        version: canary
*/

// Step 2: Configure traffic splitting
type CanaryController struct {
    istioClient dynamic.Interface
    metrics     MetricsClient
}

func (c *CanaryController) CreateCanaryRouting(canaryPercent int) error {
    vs := &unstructured.Unstructured{
        Object: map[string]any{
            "apiVersion": "networking.istio.io/v1beta1",
            "kind":       "VirtualService",
            "metadata": map[string]any{
                "name": "user-service",
            },
            "spec": map[string]any{
                "hosts": []string{"user-service"},
                "http": []map[string]any{
                    {
                        "route": []map[string]any{
                            {
                                "destination": map[string]any{
                                    "host":   "user-service",
                                    "subset": "stable",
                                },
                                "weight": 100 - canaryPercent,
                            },
                            {
                                "destination": map[string]any{
                                    "host":   "user-service",
                                    "subset": "canary",
                                },
                                "weight": canaryPercent,
                            },
                        },
                    },
                },
            },
        },
    }

    _, err := c.istioClient.Resource(virtualServiceGVR).
        Namespace("production").
        Apply(context.Background(), "user-service", vs, metav1.ApplyOptions{})
    return err
}

// Step 3: Progressive rollout with monitoring
func (c *CanaryController) ProgressiveRollout(ctx context.Context) error {
    stages := []int{10, 25, 50, 75, 100}

    for _, percent := range stages {
        // Update traffic split
        if err := c.CreateCanaryRouting(percent); err != nil {
            return err
        }

        slog.Info("canary at", "percent", percent)

        // Monitor for 5 minutes
        ticker := time.NewTicker(30 * time.Second)
        deadline := time.After(5 * time.Minute)

        for {
            select {
            case <-ctx.Done():
                return ctx.Err()

            case <-deadline:
                goto nextStage

            case <-ticker.C:
                // Check metrics
                canaryMetrics, err := c.metrics.GetCanaryMetrics(ctx)
                if err != nil {
                    continue
                }

                // Automatic rollback if error rate too high
                if canaryMetrics.ErrorRate > 0.05 { // 5% threshold
                    slog.Error("canary error rate too high, rolling back",
                        "error_rate", canaryMetrics.ErrorRate)
                    return c.Rollback(ctx)
                }

                // Rollback if latency too high
                if canaryMetrics.LatencyP99 > 500*time.Millisecond {
                    slog.Error("canary latency too high, rolling back",
                        "latency_p99", canaryMetrics.LatencyP99)
                    return c.Rollback(ctx)
                }
            }
        }
    nextStage:
    }

    // Canary successful - promote
    return c.Promote(ctx)
}

func (c *CanaryController) Rollback(ctx context.Context) error {
    return c.CreateCanaryRouting(0) // All traffic to stable
}

func (c *CanaryController) Promote(ctx context.Context) error {
    // Scale down canary, scale up stable with new version
    // Then remove canary traffic rules
    return nil
}
```

**What FAANG expects:** Progressive weights (1% -> 5% -> 25% -> 50% -> 100%) guarded by automated rollback on SLO regression (error rate, latency p99, saturation), plus a bake time at each stage long enough to observe real user traffic patterns. Top candidates mention Flagger or Argo Rollouts as declarative controllers that implement exactly this loop on top of Istio, so you don't hand-roll the state machine in production. They also distinguish canary (weight-based) from blue-green (instantaneous cutover) and header-based routing (targeted internal rollout) and explain when each fits.

**Follow-ups:**
- *How do you canary a non-idempotent write endpoint?* Either route by deterministic hash (same user always sees the same version, preventing inconsistent state across retries) or route by internal header until confidence is established, then flip to weighted.
- *What metrics trigger automated rollback?* Error rate delta vs baseline (not absolute threshold - a 0.5% baseline error rate spiking to 2% is worse than a constant 1%), latency p99 regression, and domain-specific signals (checkout success rate, login rate). Generic thresholds cause false rollbacks during legitimate traffic surges.
- *How does this differ on Gateway API / ambient mode?* `HTTPRoute` supports weighted `backendRefs` natively, so the same pattern is expressed without Istio-specific CRDs. In ambient mode, a waypoint proxy is required because weight-based L7 routing needs the L7 tier.

### Junior → FAANG: Interview Preparation Strategy for Service Mesh Questions

Service mesh interview questions at FAANG screen for three things in increasing order of difficulty: comprehension of what the mesh does, understanding of why it exists, and operational awareness of what can go wrong.

For a junior screening, the questions you are most likely to encounter are variants of Questions 1 and 2 in this section. Prepare by being able to draw the control plane / data plane split from memory and narrate a single request's path through it (app makes plaintext call, sidecar intercepts, encrypts with mTLS, sends to peer sidecar, peer decrypts, checks AuthorizationPolicy, forwards to app). Being able to explain this fluently from a diagram signals that you have operated the technology, not just read about it.

For mTLS specifically, know the three key facts: (1) the certificate format is SPIFFE X.509-SVID, (2) the certificate is issued and rotated by Istiod automatically, (3) the application never sees or touches the certificate. Interviewers check whether you confuse "the app uses mTLS" (wrong) with "the sidecar handles mTLS transparently" (correct).

For the overhead question (Question 3), do not memorize numbers without context. The honest answer is "1-3ms per hop in sidecar mode, lower in ambient mode, and the per-pod memory cost is eliminated in ambient." Following up with "the hidden cost is debugging complexity, not compute" is the signal that separates candidates who have operated a mesh from those who have only read benchmarks.

Practice answering each question in two minutes or less, then offering a deeper follow-up. Interviewers probe depth by asking follow-ups. A shallow first answer followed by accurate detail on the follow-up is a stronger signal than an over-rehearsed first answer with no depth behind it.

### Senior @ FAANG: Bar-Raiser Interview Depth and L6/L7 Signal Patterns

At senior and staff level, these five questions are starting points. The bar-raiser interview probes for three qualities that distinguish L6/L7 candidates: the ability to reason about failure modes, the ability to make organizational trade-offs, and the ability to explain not just what but why.

**Reasoning about failure modes.** Question 1's follow-up "how does adopting a mesh change your on-call surface" is a bar-raiser question because it has no single right answer. It requires the candidate to reason forward: if Istiod goes down, existing proxies continue with stale config but no new config pushes land. If the stale config has a routing rule that sends traffic to a subset that no longer exists (because a deployment deleted those pods), that traffic gets 503s. The candidate who can trace this failure chain without prompting is demonstrating operational maturity.

**Making organizational trade-offs.** Question 3 about overhead is a setup for the trade-off question: "at what point does the mesh overhead justify the operational cost of running a control plane?" The L6 answer is not a number. It is a framework: the mesh earns its keep when the cost of inconsistent per-service networking implementations (security drift, observability gaps, incident response friction) exceeds the cost of operating the mesh control plane. In practice this threshold is around ten services with two or more teams. Below that, a well-maintained library is cheaper.

**Explaining why, not just what.** Question 5 (canary deployments) is where L7 candidates distinguish themselves. The what is: deploy two versions, split traffic by weight, monitor, promote or rollback. The why is more interesting: progressive delivery is a risk mitigation strategy. It reduces the blast radius of a bad deployment from 100% of users to a small percentage, and it creates a time window during which the signal-to-noise ratio of your metrics is high enough to detect regression before it becomes an incident. The candidate who can articulate that progressive delivery is fundamentally about controlling information flow (you learn whether the change is safe before committing to it) is thinking at the right level of abstraction.

**Staff-level question the section does not include:** "You have 800 microservices. The CTO asks for a plan to achieve zero-trust networking within 18 months. What does the plan look like?" This requires: phased namespace enrollment (starting with highest-risk services), PERMISSIVE to STRICT mTLS migration per namespace with automated verification, AuthorizationPolicy generation tooling, SPIRE for non-Kubernetes workloads, and a compliance dashboard that gives auditors a real-time view of enforcement coverage. Answering this question well is what L7/principal engineer-level candidates do.

---
