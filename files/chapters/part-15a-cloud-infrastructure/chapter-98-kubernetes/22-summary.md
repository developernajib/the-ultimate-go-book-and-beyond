## Summary

- **Pods and deployments**: Pods are the smallest schedulable unit. Deployments manage replica sets and enable rolling updates with zero downtime.
- **Liveness vs readiness probes**: Liveness restarts a broken container. Readiness gates traffic - use different endpoints and never conflate the two.
- **Resource requests and limits**: Requests drive scheduling decisions. Limits cap consumption. Set both to ensure predictable performance and prevent noisy-neighbor problems.
- **ConfigMaps and Secrets**: Externalise configuration from images. mount Secrets as volumes rather than environment variables to avoid accidental logging.
- **Horizontal Pod Autoscaler (HPA)**: Automatically scales replica count based on CPU, memory, or custom metrics - pair with a Pod Disruption Budget to preserve availability during scale-down.
- **RBAC**: Grant service accounts only the verbs and resources they need. Audit with `kubectl auth can-i --list` and rotate credentials regularly.
- **Ingress controllers**: Centralize TLS termination, host/path routing, and rate limiting at the edge. Annotate resources for controller-specific behavior (e.g., NGINX, Traefik).
- **Persistent storage**: Use PersistentVolumeClaims with appropriate StorageClass. Prefer StatefulSets for stateful workloads that require stable network identity and ordered rollouts.
- **Network policies**: Default-deny all ingress/egress and explicitly allow only required paths - this provides container-level micro-segmentation without a service mesh.
- **Debugging workflow**: Start with `kubectl describe pod`, check events and probe failures, then `kubectl logs --previous` for crash loops, and `kubectl exec` for live inspection.

### Junior → FAANG: Using This Summary as a Deployment Readiness Gate

This summary represents the non-negotiable checklist for a Go service in production on Kubernetes. Before any service goes live, every bullet point should be verifiable with a concrete artifact: the manifest that sets resource limits, the probe configuration, the RBAC definitions, the network policies.

The habit of tracing each bullet point to a specific, reviewable configuration artifact turns the abstract summary into a concrete audit trail. In a team code review, any one of these items being missing or misconfigured is a blocking comment, not a suggestion.

### Senior @ FAANG: This Summary as a Platform Contract Checklist

At staff level, this summary is the platform's promise to service teams: if your service configuration satisfies each of these items, the platform will handle the rest (scheduling, self-healing, scaling, networking, observability). If it does not, the behavior is unspecified and the service team owns the consequences.

Making this promise explicit, writing it down as a platform contract document, and building the enforcement mechanisms that verify it across all services is the staff engineer's contribution to Kubernetes platform maturity. The contract evolves over time as the platform gains new capabilities and the organization's risk tolerance changes, and the staff engineer is responsible for managing that evolution with appropriate notice and migration support for all affected teams.
