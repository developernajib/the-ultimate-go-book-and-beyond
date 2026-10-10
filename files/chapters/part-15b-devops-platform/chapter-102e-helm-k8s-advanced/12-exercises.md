## 102E.10 Mid-Chapter Practical Exercises

### Exercise 1: Production Helm Chart for a Go Microservice

Build a complete Helm chart for a Go HTTP service with:
- Deployment with configurable replicas, resource limits, readiness/liveness probes
- Service, Ingress with TLS
- HPA based on CPU (70%) and custom metric (p99 latency > 500ms)
- PodDisruptionBudget (minAvailable: 80%)
- ServiceAccount with IRSA annotation
- Pre-upgrade db-migrate hook
- Post-install smoke test
- NetworkPolicy: allow ingress from ingress-nginx only
- Values for dev (no autoscaling, 1 replica) and production (autoscaling, 3+ replicas)

### Exercise 2: Admission Webhook with OPA Gatekeeper

Deploy OPA Gatekeeper and create ConstraintTemplates for:
1. RequiredLabels: all Deployments must have `team` and `cost-center` labels
2. AllowedRegistries: all Pods must use images from approved registries only
3. ResourceLimitsRequired: all containers must have CPU and memory limits

Test: deploy a Pod without limits, verify it's rejected with a clear error message.

### Exercise 3: KEDA Kafka Consumer with Scale-to-Zero

Deploy a Go Kafka consumer with KEDA:
1. Consumer group reads from `work-queue` topic
2. KEDA ScaledObject: minReplicas=0, maxReplicas=20, lagThreshold=50
3. Demonstrate: produce 0 messages → consumer scales to 0
4. Produce 1000 messages → consumer scales from 0 to 20
5. Process all messages → consumer scales back to 0
6. Metric: measure cold start latency (0→1 pod) vs warm start (1→2 pods)

### Junior → FAANG: Turning Exercises Into Portfolio Evidence

These three exercises are not just practice problems. Done seriously, they produce artifacts you can discuss in interviews. Exercise 1 produces a complete Helm chart with all the patterns that interviewers ask about: the HPA replica guard, the checksum annotation, the pre-upgrade migration hook, and the smoke test. Being able to show the chart and walk through why each decision was made is worth more than any textbook answer.

Exercise 3 (KEDA with scale-to-zero) is particularly valuable because it forces you to measure cold start latency directly. The exercise asks you to measure "cold start latency (0 to 1 pod) vs warm start (1 to 2 pods)." That measurement is something most engineers have never actually done deliberately, and having a concrete number (say, "pod scheduling plus image pull plus application startup averaged 22 seconds in my test environment") is a memorable interview answer.

For Exercise 2 (OPA Gatekeeper), the goal is not just getting it to work but understanding the ConstraintTemplate structure. A ConstraintTemplate contains Rego policy code. Understanding what Rego is and why it is used for policy-as-code (rather than Go webhook code) is an interview question that trips up engineers who have only used Gatekeeper from the outside.

### Senior @ FAANG: Exercises as Platform Design Templates

At staff level, these exercises are templates for organizational decisions, not personal practice problems. Exercise 1 is a foundation for your organization's Helm chart standard. The design choices embedded in it, which probes to use, what the security context looks like, whether autoscaling is on by default, are policy decisions that affect every team that uses the standard.

The OPA Gatekeeper exercise (Exercise 2) frames the policy-as-code decision: RequiredLabels, AllowedRegistries, and ResourceLimitsRequired are the three most common webhook policies. If your organization is implementing these for the first time, the sequencing matters. RequiredLabels first (lowest blast radius, easy to fix violations), AllowedRegistries second (requires image migration work from teams), ResourceLimitsRequired last (requires the most application team coordination). A phased rollout with audit mode before enforce mode is standard practice.

Exercise 3's scale-to-zero pattern should be accompanied by a runbook in a production environment: what to do when the 0-to-1 cold start takes longer than expected, how to identify whether the delay is in pod scheduling, image pull, or application startup, and how to pre-pull images on nodes to eliminate image pull from the critical path. Writing that runbook is a staff-level deliverable that makes the capability operationally sustainable beyond the initial engineer who built it.

---
