## Summary

- **Operator pattern**: Encodes operational knowledge into a Kubernetes controller that watches custom resources and reconciles actual state toward desired state.
- **Custom Resource Definitions (CRDs)**: Extend the Kubernetes API with domain-specific resource types. Define strict OpenAPI validation schemas to catch misconfiguration early.
- **Reconcile loop**: The core of every operator - idempotent logic that reads the current world, computes a diff, and applies only the minimum changes needed to reach the goal state.
- **controller-runtime and kubebuilder**: Standard scaffolding tools that generate boilerplate (main, manager, RBAC markers) and provide cached informers, work queues, and leader election.
- **Finalizers**: Prevent resource deletion until the operator completes cleanup (e.g., removing off-cluster state like S3 backups). Always remove finalizers after cleanup or the resource hangs.
- **Owner references**: Set owner references on child resources (Jobs, Deployments) so that Kubernetes garbage-collects them automatically when the parent custom resource is deleted.
- **Status subresource**: Use `.status` conditions (type, status, reason, message) to communicate reconciliation progress back to users and to drive higher-level automation.
- **Level-triggered reconciliation**: React to the desired state rather than event sequences. re-queue with backoff on transient errors so the operator self-heals without manual intervention.
- **RBAC for operators**: Grant the operator's ServiceAccount only the exact resources and verbs it needs - no `cluster-admin`. Use `ClusterRole` only when cross-namespace access is truly required.
- **Testing operators**: Use `envtest` to run controllers against a real API server in unit tests. Write integration tests that create CRDs, trigger reconciliation, and assert on observed state.

### Junior → FAANG: Operator Summary as a Development Roadmap

This summary maps the skills required to build a production-grade operator in order of dependency: CRD design (API contract) comes before controller implementation (which depends on the types), testing comes before deployment, and observability is built in during development, not added after. Follow this order, and each step is a natural progression from the previous one.

The most underestimated bullet is the testing entry: envtest-based integration tests are complex to set up but provide the highest confidence that the operator behaves correctly across a wide range of Kubernetes lifecycle events.

### Senior @ FAANG: Operator Summary as a Platform Standards Document

At L6/L7, this summary is the foundation of an operator quality standard for the organization. Each bullet is a requirement, not a suggestion. The organizational governance mechanism that enforces these requirements: an operator production readiness review (PRR) checklist that must be completed before any operator is deployed to a production cluster, reviewed by the platform team, and documented as an artifact in the operator's repository.

The PRR covers: CRD schema documentation and versioning plan, controller test coverage (unit, integration, e2e), webhook availability and TLS certificate management, RBAC least-privilege verification, observability (metrics, status conditions, structured logging), and operational runbooks for common failure scenarios. An operator that cannot pass this review is not production-ready, regardless of how well the reconcile logic is implemented. Defining and enforcing this review process is the staff engineer's mechanism for preventing infrastructure debt accumulation in the operator ecosystem.

*Next: [Chapter 102: Infrastructure as Code for Go Services](../chapter-102-infrastructure-as-code/00-introduction.md)*
