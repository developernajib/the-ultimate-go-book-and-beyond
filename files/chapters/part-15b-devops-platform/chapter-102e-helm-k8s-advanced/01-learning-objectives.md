## Learning Objectives

1. **Master Helm chart development** - chart structure, template functions, named templates, hooks, dependencies, and testing
2. **Use Kustomize with Helm together** - overlays, patches, generators, and the Helm vs Kustomize decision framework
3. **Write Custom Resource Definitions** - CRD design, OpenAPI validation, status subresource, and versioning
4. **Build admission webhooks in Go** - validating and mutating webhooks, cert-manager integration, and OPA/Gatekeeper
5. **Implement advanced autoscaling** - HPA with custom metrics, VPA, KEDA for event-driven scaling
6. **Apply network policies** - zero-trust Kubernetes networking with NetworkPolicy
7. **Manage resources effectively** - quotas, limit ranges, PDBs, QoS classes, and right-sizing

### Junior → FAANG: Using Learning Objectives as an Interview Self-Assessment

Each objective here maps directly to a category of technical interview questions at mid-level and senior hiring bars. Treating this list as a checklist misses the point. The better habit is to ask yourself, for each item: can I explain this to someone who has never seen it, can I implement a minimal version from scratch, and can I describe a failure mode?

For entry-level engineers, the highest-value objectives to drill first are CRD design and admission webhooks. Those are the clearest signals separating candidates who have used Kubernetes from candidates who have extended it. Being able to write a validating webhook handler in Go, even a simple one that rejects pods missing required labels, is a concrete demonstration that goes beyond YAML familiarity.

### Senior @ FAANG: Reading Learning Objectives as a Platform Capability Maturity Map

At staff level, this list is less about personal skill acquisition and more about team capability inventory. The question is which of these capabilities your platform team owns and operates reliably, which are ad-hoc or undocumented, and which are gaps that are currently handled by human process instead of automated enforcement.

A mature platform team has: Helm chart standards documented and enforced via chart testing in CI, CRD versioning policies written down as ADRs, admission webhooks that cover the highest-risk policy categories (image signing, resource limits, network policy enforcement), autoscaling configured and validated against production traffic patterns not just synthetic benchmarks, and resource quotas calibrated per team based on actual utilization data not estimates.

The bar-raiser concern at L6/L7 is not whether you can implement each item but whether you can describe how each item is operated, monitored, and evolved over time as organizational requirements change. Governance of a platform capability is harder than building it, and that distinction is what separates senior individual contributors from staff-level platform engineers.
