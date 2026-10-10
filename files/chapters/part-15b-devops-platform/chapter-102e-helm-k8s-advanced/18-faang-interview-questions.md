## 102E.16 FAANG Senior Platform Interview Questions

### Q1 (Amazon, L6): Helm vs Kustomize vs raw manifests for a 200-service platform.

Helm for third-party charts you consume, Kustomize for internal services you own. The reasoning: Helm templating is powerful but opaque. Kustomize overlays compose cleanly and review well in PRs. For a platform team, offer both via a golden-path generator rather than forcing one choice on every tenant.

### Q2 (Google, L5): Design a CRD and controller for a Database abstraction.

Declarative spec with desired engine, version, size, and backup policy. Status subresource reports phase, endpoint, and last-backup time. Reconciler is idempotent, uses owner references for cascading delete, and has a finalizer that drains connections before teardown. Level-triggered, never edge-triggered. Expose metrics and use a workqueue with exponential backoff.

### Q3 (Meta, E6): HPA vs VPA vs KEDA. Choose and justify.

HPA for stateless web traffic on CPU or RPS. VPA in recommendation mode for right-sizing, rarely in auto mode due to pod churn. KEDA for event-driven workloads where the signal is queue depth or Kafka lag. Combine HPA plus KEDA via the external metrics API. Never run HPA and VPA auto on the same deployment.

### Q4 (Netflix, Senior): Admission webhook that mutates every pod without becoming a SPOF.

Run two or more replicas behind a Service, set `failurePolicy: Ignore` for non-critical mutations and `Fail` for security gates with a strict timeout of 2 to 3 seconds. Exclude `kube-system` via `namespaceSelector`. Fronted by a readiness probe that fails before the pod is added to endpoints.

### Q5 (Apple, ICT5): Zero-trust NetworkPolicy baseline.

Default deny ingress and egress in every namespace. Explicit allow to kube-dns, to required platform services (metrics, logs), and to specific peer namespaces via labels. Combine with Cilium or Calico for L7 policy where needed. Test policies with `kubectl exec` probes in CI before promoting.

### Junior → FAANG: FAANG Interview Questions as a Difficulty Calibration Tool

These five questions are calibrated to L5/L6 system design and architecture hiring bars. Reading them as a junior engineer is useful not to memorize the answers but to understand the depth of reasoning that these companies expect. Q2 (database CRD and controller design) in particular shows how much an interview question can pack in: the answer touches CRD schema design, status subresource, idempotency, owner references, finalizers, metrics, and workqueue configuration. That is six distinct concepts in one question.

Use these questions to identify which concepts you can explain fluently and which you can only describe superficially. The difference matters in an interview: "the reconcile loop is idempotent" is a superficial answer. "The reconcile loop is idempotent because it may be called multiple times for the same event, so creating a resource that already exists must be handled gracefully by checking for existence first and only calling Create if the resource is absent" is a fluent answer. Practice converting your superficial knowledge into fluent explanations.

Q4 (admission webhook without becoming a SPOF) is the most interview-dense question in this set. It packs in: availability (multiple replicas), failure mode design (`failurePolicy`), latency constraints (timeout of 2 to 3 seconds), blast radius reduction (namespace exclusion), and availability signaling (readiness probe before endpoints). Being able to answer this question fluently, with all five considerations, at a senior hiring bar is a strong signal.

### Senior @ FAANG: FAANG Questions as an Architectural Bar Calibration

Q1 (Helm vs Kustomize vs raw manifests for a 200-service platform) is a staff-level question because the right answer is not about the tools but about the governance model. The choice of tooling is secondary to the choice of how standards are defined, enforced, and evolved across 200 services. A golden-path generator that produces charts from a template is a platform product decision: who maintains the generator, how are breaking changes communicated, and what is the process for teams that need to deviate from the generated output? The technical tools (Helm, Kustomize) are implementation details of that product.

Q3 (HPA vs VPA vs KEDA) at L6/L7 includes a constraint the question does not state explicitly: your answer should reflect how these tools interact with the cluster autoscaler. HPA adds pods, which may trigger node provisioning. VPA evicts pods for resize, which causes temporary unavailability. KEDA's scale-to-zero removes all pods, which returns nodes to the autoscaler pool. The aggregate effect of these interactions across 200 services determines cluster cost efficiency and the tail latency of scale-out events. Reasoning about the aggregate effect, not just the per-service behavior, is what L6/L7 interviewers are probing for.

Q5 (zero-trust NetworkPolicy baseline) at the bar-raiser level includes the organizational rollout question: how do you migrate a cluster from no NetworkPolicy to default-deny-all without causing production outages? The answer requires an audit phase (apply policies in audit mode with Cilium's `action: Audit` or equivalent), a validation phase (verify no legitimate traffic is being denied by the new policy), and a cutover phase (convert from audit to enforce per namespace in order of criticality). This phased approach, rather than "apply default-deny and fix what breaks," is the operationally sound answer that distinguishes senior from staff-level thinking on policy rollout.
