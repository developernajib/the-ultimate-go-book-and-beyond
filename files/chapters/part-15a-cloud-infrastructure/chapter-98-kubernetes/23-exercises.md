## Exercises

1. **Deploying a Go App with Resource Limits and Requests**: Write a `Deployment` manifest for a Go HTTP service that sets CPU requests to `100m`, CPU limits to `500m`, memory requests to `64Mi`, and memory limits to `128Mi`. Apply it to a local cluster (kind or minikube), confirm pods are `Running` with `kubectl get pods`, and then use `kubectl top pods` to verify resource consumption stays within bounds under load.

2. **Configuring HPA Based on Custom Metrics**: Install the Prometheus Adapter in a local cluster and expose a custom metric (`http_requests_per_second`) from a Go service using the `promhttp` handler. Create an `HorizontalPodAutoscaler` that scales between 2 and 10 replicas when the metric exceeds 50 req/s per pod. Generate load with `hey` or `k6` and observe scaling events in `kubectl describe hpa`.

3. **Rolling Update Strategy with Zero Downtime**: Configure a `Deployment` with `strategy.rollingUpdate.maxUnavailable: 0` and `maxSurge: 1`, and add both a `readinessProbe` (HTTP GET `/ready`) and a `livenessProbe` (HTTP GET `/healthz`). Perform a rolling update by changing the image tag and use `kubectl rollout status` to confirm zero-downtime behavior. Capture the timeline with `kubectl get events --watch`.

4. **Implementing Pod Disruption Budgets**: Create a `PodDisruptionBudget` for a stateless Go service that guarantees at least 2 pods remain available at all times (`minAvailable: 2`). Deploy 3 replicas, then simulate a node drain with `kubectl drain --ignore-daemonsets` and confirm that the third pod is blocked until one of the evicted pods reschedules successfully.

5. **Network Policies to Restrict Pod-to-Pod Communication**: In a cluster with a CNI that supports `NetworkPolicy` (e.g., Calico or Cilium), write policies that (a) deny all ingress to a Go API pod by default, and (b) allow ingress only from pods labeled `role=frontend`. Deploy both a frontend and a backend pod, verify the allowed path succeeds with `kubectl exec, curl`, and verify an unlabelled pod is blocked.

6. **Debugging a CrashLoopBackOff**: Intentionally introduce a CrashLoopBackOff by configuring a Go container with an incorrect `command` or a missing required environment variable. Practice the full debugging workflow: `kubectl describe pod`, `kubectl logs --previous`, `kubectl events`, and `kubectl debug` with an ephemeral container. Document each command's output and the root cause identified at each step.

### Junior → FAANG: Kubernetes Exercises as On-Call Training

These exercises double as on-call training scenarios. Each exercise deliberately puts a service in a broken or suboptimal state and asks you to fix it. This is exactly the on-call scenario: something is broken, you need to diagnose and fix it, and the debugging tools are kubectl commands.

Exercise 6 (CrashLoopBackOff debugging) is the most valuable on-call preparation. Run through it multiple times until the debugging workflow is automatic. The goal is to reach a state where seeing "CrashLoopBackOff" triggers an immediate, methodical investigation, not anxiety. The investigation sequence is always the same: exit code from describe, logs from previous, events for context.

### Senior @ FAANG: Exercises as Platform Capability Validation

At senior level, these exercises validate that the platform provides the right tools and APIs for the scenarios service teams encounter in production. Exercise 3 (graceful shutdown) tests whether the platform's default `terminationGracePeriodSeconds` is appropriate for the service tier. Exercise 4 (HPA) tests whether the metrics-server or custom metrics adapter is configured correctly. Exercise 5 (network policies) tests whether the CNI supports NetworkPolicy enforcement.

Running these exercises in a newly provisioned cluster is part of platform acceptance testing. If exercise 4 fails because the metrics-server is not installed, that is a platform gap that needs to be addressed before the cluster is offered to teams. Formalizing this exercise set as a platform acceptance test suite, run automatically after every cluster provisioning or upgrade, is an L6/L7 platform reliability contribution.

---

*Next: [Chapter 99: CI/CD for Go Applications](../chapter-99-cicd/00-introduction.md)*
