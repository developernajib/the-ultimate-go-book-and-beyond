## Summary

Service mesh in 2026:

1. **Architecture**: Control plane (Istiod, Linkerd destination, Cilium operator) pushes config via xDS to a data plane that enforces policy on every call.
2. **Three data-plane topologies**: classic sidecar (Envoy per pod), **Istio ambient mode** (ztunnel per node + optional waypoint per namespace, GA since v1.24 in Nov 2024), and **eBPF** (Cilium, L3/L4 in kernel with Envoy only for L7). Pick based on scale, kernel version, and operational appetite.
3. **mTLS + SPIFFE**: Automatic encryption and X.509-SVID identity between services without application code. rotation is handled by the node agent and SDS. SPIRE extends the same trust domain to VMs and bare metal.
4. **Traffic management**: Canary deployments, A/B testing, circuit breakers expressed declaratively via `VirtualService`/`DestinationRule` or, increasingly, Kubernetes **Gateway API** `HTTPRoute`.
5. **Observability**: Proxies emit RED metrics and spans automatically. Application code must still propagate W3C `traceparent` and emit business-context spans the mesh cannot see.
6. **Fault injection**: Staging-only by default. Use header-scoped matches if touching production, and remember L7 faults require a waypoint proxy in ambient mode.
7. **Trade-offs**: A mesh adds a control plane you must operate, a proxy layer (or two) in every call's path, and real debugging complexity. For small fleets, library-based solutions are usually cheaper. The mesh earns its keep at 10+ services with multiple teams and compliance needs.

### Junior → FAANG: Seven Things to Know Before Your Next Interview

This chapter covers a lot of ground. For an interview, compress it to seven concrete things you can explain with confidence.

1. The control plane (Istiod) pushes configuration to the data plane (Envoy proxies) via xDS. When Istiod is unreachable, proxies continue with the last known config.

2. Your Go service writes plain HTTP. The sidecar handles mTLS, retries, timeouts, and metrics. You do not add TLS code to a mesh-enrolled service.

3. Header propagation is the one thing you must do in Go. Extract `traceparent` from inbound requests and inject it into every outbound call. Use `otel.GetTextMapPropagator().Inject(ctx, ...)`.

4. Readiness probes must check real dependencies. A probe that returns 200 unconditionally is a reliability bug that keeps broken pods in rotation.

5. Ambient mode (GA since Istio 1.24) removes per-pod sidecars. L4 features use ztunnel on the node. L7 features require a waypoint proxy in the namespace.

6. Retry amplification is the most dangerous misconfiguration. In a chain of four services each retrying three times, one failed request becomes 81 attempts. Set retries only at the mesh edge.

7. `istioctl proxy-status` and `istioctl analyze` are your two most important debugging commands. Run them before concluding that the problem is in application code.

These seven points cover the most common interview questions and the most common first-year operational problems.

### Senior @ FAANG: The Staff-Level Mental Model for Service Mesh

At staff and principal level, the summary of this chapter is not a list of features. It is a framework for organizational decision-making about a shared platform component.

**The mesh is a shared dependency with platform-team SLOs.** Istiod is not a developer tool. It is infrastructure that every service in the fleet depends on for security and observability. The platform team that operates it must publish an SLO (for example, xDS push latency p99 below two seconds for 99.9% of configuration changes) and have an on-call rotation that responds to Istiod incidents with the same urgency as a database outage.

**Topology is a multi-year architectural commitment.** Choosing sidecar, ambient, or eBPF is not a configuration preference. It determines what debugging tooling your SRE team must learn, what kernel version floor you accept, what WASM filters you can use, and how your observability pipeline is structured. Revisiting this decision after deploying at scale is expensive. Make it deliberately, document the reasoning, and review it annually.

**Policy as code is non-negotiable above compliance threshold.** Any organization that needs to demonstrate zero-trust enforcement to an auditor cannot manage AuthorizationPolicy objects by hand. The policy-as-code pattern (Git as source of truth, CI generates CRDs, GitOps applies them, deviation triggers alerts) is a prerequisite for SOC 2 Type II compliance, not a nice-to-have.

**The mesh solves coordination problems, not correctness problems.** A mesh enforces policy uniformly across the fleet and provides consistent observability. It does not prevent a service from having a bug, writing duplicate records under retry, or returning incorrect business logic. Engineers who understand this boundary use the mesh for what it is good at and do not expect it to compensate for application-layer problems.

**The real cost of a mesh is engineering attention, not compute.** The compute cost of Envoy sidecars is real and measurable. The cost of debugging proxy misconfigurations, operating the control plane upgrade cadence, maintaining policy-as-code tooling, and training engineers to reason at both the application and proxy layers is larger and harder to measure. Budget for both when making the adoption case.
