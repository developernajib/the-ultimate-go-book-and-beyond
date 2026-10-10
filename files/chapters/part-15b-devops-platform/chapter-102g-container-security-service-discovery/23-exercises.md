## Exercises

### Exercise 4: Kubernetes Admission Webhook for Image Signature Validation

Build a production-grade validating admission webhook in Go:

1. **Webhook server**: implement the admission webhook shown in section 102G.17, with TLS using cert-manager and the `ValidatingWebhookConfiguration`
2. **Policy configuration**: support configuring allowed OIDC issuers and workflow identities via a Kubernetes ConfigMap that the webhook watches for live updates (no restart required)
3. **Bypass mechanism**: implement a `signature-bypass-reason` annotation that allows signed pods to skip validation for break-glass scenarios - log every bypass with structured JSON including the requester identity
4. **Integration test**: write a Go test that spins up an `httptest.Server`, sends mock `AdmissionReview` payloads with both signed and unsigned image references, and verifies the correct `allowed: true/false` responses
5. **Metrics**: expose `/metrics` with Prometheus counters for `webhook_allowed_total`, `webhook_denied_total`, and `webhook_verification_duration_seconds`

### Exercise 5: Falco Rule and Go Alert Handler for Crypto Mining Detection

Crypto mining is one of the most common container runtime attacks. Build a detection and response pipeline:

1. **Falco rule**: write a custom rule detecting crypto mining indicators: unexpected CPU-intensive processes (`xmrig`, `minerd`, high-frequency `clock_gettime` syscalls), connections to known mining pool ports (3333, 4444, 14444), and processes downloading executables via `curl` or `wget` at runtime
2. **Alert handler**: extend the Go Falco webhook handler from section 102G.16 to handle mining-specific alerts: immediately label the pod for quarantine, emit a structured audit log event, and calculate the blast radius (how long was the pod running before detection, which other pods share the namespace)
3. **Automated remediation**: if the same node has multiple mining detections within 10 minutes, cordon the node (`kubectl cordon`) using the Kubernetes client-go API to prevent new pod scheduling while the node is investigated
4. **Test harness**: write a Go test that mocks the Falco webhook payload for a mining alert and verifies that the quarantine label is applied, the node cordoning logic triggers correctly, and the PagerDuty incident call is made - use `httptest` for the PagerDuty mock and a fake Kubernetes client (`k8s.io/client-go/kubernetes/fake`)
5. **Dashboard**: write a brief Prometheus recording rule that tracks `falco_crypto_mining_detections_total` by namespace and node - set a PagerDuty alert at threshold > 0 with zero tolerance

---

### Junior → FAANG: What These Exercises Test Beyond the Code

Exercise 4 and Exercise 5 are both systems, not just programs. They test your ability to integrate multiple components (webhook + cert-manager + ConfigMap watcher + Prometheus metrics) into a coherent, operationally complete solution.

The bypass mechanism in Exercise 4 is often skipped by engineers who think it undermines the security of the webhook. This is the wrong framing. A security control with no bypass is a control that gets disabled entirely when it blocks a critical deployment at 3am. A bypass with a structured audit log, a required justification annotation, and a page to the security team is far more useful than a control that creates an emergency override culture. Building the bypass well is as important as building the enforcement.

The fake Kubernetes client in Exercise 5 (`k8s.io/client-go/kubernetes/fake`) is the correct testing approach for any Go code that interacts with the Kubernetes API. It provides an in-memory API server that responds to the same calls as the real API server. Running your tests against the real Kubernetes API (even a local cluster) makes tests slow, environment-dependent, and hard to run in CI. Know how to use the fake client before any FAANG interview involving Kubernetes tooling.

First-job preparation: for Exercise 5's node cordoning logic, understand the failure mode: if you cordon a node based on a Falco alert and the alert is a false positive, you have taken a node out of service unnecessarily. The production version of this logic needs a human approval step (page the on-call, auto-cordon after 5 minutes with no acknowledgment) rather than immediate automated cordoning. Building this as a design consideration, not just as code, is the judgment that distinguishes a senior-track candidate.

### Senior @ FAANG: Extending These Exercises to Production-Grade Security Products

Exercise 4 as a production product requires additional dimensions that the exercise description intentionally leaves out. The ConfigMap watcher for live policy updates introduces a concurrency concern: the webhook handler and the ConfigMap watcher goroutine both access the policy configuration. A read-write mutex protects concurrent access, but you must also validate new policy before applying it (an invalid ConfigMap should not crash the webhook or leave it in a broken state). The validation-before-apply pattern (parse the ConfigMap, validate the policy, swap atomically if valid, log and retain the old policy if invalid) is the correct operational design.

The Prometheus metrics in Exercise 4 require label cardinality management. If you label `webhook_denied_total` by image reference (the full image name with digest), you have unbounded label cardinality because every unique image creates a new time series. Label by registry, namespace, and severity instead. Label cardinality is a Prometheus operational concern that staff engineers internalize but juniors frequently overlook, leading to Prometheus OOM crashes in production.

Exercise 5's blast radius calculation ("how long was the pod running before detection, which other pods share the namespace") is the seed of an incident response enrichment service. At FAANG scale, when a security event is detected, responders need pre-computed context: pod age, service owner (from label lookups), recent deployments in the namespace (from deployment history), and network connectivity graph (which other pods can this compromised pod reach). Building this enrichment as a platform service that is invoked on every Falco CRITICAL alert, and that populates the PagerDuty incident details automatically, is the operational investment that reduces mean time to respond. A staff engineer proposing this as a product should define its data sources (Kubernetes API, Prometheus metrics, deployment history API), its latency requirement (enrichment must complete before the on-call engineer acknowledges the page, typically under 30 seconds), and its failure mode (if enrichment fails, the raw alert is still delivered with a note that enrichment is unavailable).
