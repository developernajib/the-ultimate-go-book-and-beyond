## 102E.15 Advanced Kubernetes Interview Questions

**Q16: What is the difference between a Helm chart and a Kubernetes Operator?**

A Helm chart is a package of YAML templates that installs/upgrades/deletes Kubernetes resources. It handles Day-1 operations: deploy the app, configure it, expose it. An operator is a controller that extends Kubernetes with custom resources and encodes Day-2 operational knowledge: how to back up a database, how to perform a rolling upgrade of a Redis cluster with zero data loss, how to auto-failover when the master goes down. Helm is declarative install. An operator is declarative lifecycle management. For stateless apps, Helm is almost always sufficient. For stateful systems (databases, message brokers), an operator handles operations that no YAML template can express - because they require observing real-time state (replication lag, disk usage) and acting on it.

---

**Q17: How do you manage Helm chart secrets securely?**

Never store plaintext secrets in `values.yaml` or Helm releases (stored in Kubernetes Secrets - base64, not encrypted). The three production approaches are: (1) **External Secrets Operator** - ESO syncs secrets from AWS Secrets Manager / HashiCorp Vault / GCP Secret Manager into Kubernetes Secrets. Your chart references the Secret by name, never containing the value. (2) **Sealed Secrets** - encrypt secrets with the cluster's public key, commit the `SealedSecret` CRD to git, the in-cluster controller decrypts it. Safe for GitOps. (3) **Helm Secrets plugin** - wraps `helm` commands with `sops` encryption/decryption, secrets stored as `sops`-encrypted files in git. In all approaches, the Helm chart only references a `secretKeyRef` - the actual secret value is never in the chart.

---

**Q18: Explain Pod Disruption Budgets and when they are critical.**

A PDB defines the minimum availability guarantee for a pod group during voluntary disruptions - node drains, cluster upgrades, evictions by cluster autoscaler. Without a PDB, `kubectl drain` evicts all pods from a node immediately. With `minAvailable: 2` on a 3-replica Deployment, Kubernetes guarantees that at least 2 pods are always running during drain. It will block eviction if it would drop below 2. PDBs are critical for: (1) payment and checkout services - losing all replicas during a node upgrade causes a customer-facing outage. (2) stateful quorum-based systems - evicting too many pods breaks Raft quorum (etcd, Zookeeper, Kafka controllers). (3) SLA-bound services - PDB + Rolling Update strategy together ensures zero-downtime deploys. Always pair PDB with `maxUnavailable: 0` rolling update for services requiring continuous availability.

---

**Q19: How does the Kubernetes scheduler work?**

The scheduler watches the API server for unscheduled pods (pods with no `.spec.nodeName`). For each pod, it runs a two-phase process: (1) **Filtering** - eliminate nodes that cannot run the pod: insufficient CPU/memory, node affinity/anti-affinity mismatches, taint/toleration mismatches, pod topology spread violations, volume node affinity constraints. (2) **Scoring** - rank remaining nodes: `LeastAllocated` (prefer nodes with more free resources), `InterPodAffinity` (prefer nodes near affine pods), `ImageLocality` (prefer nodes already having the container image), `NodeAffinity` weight scoring. The node with the highest score wins. Ties are broken randomly. The scheduler then writes the node name to the pod spec via the API server, and the kubelet on that node picks it up and starts the pod.

---

**Q20: When would you use a DaemonSet vs a Deployment?**

A DaemonSet runs exactly one pod per node (or per node matching a selector). Use it for node-level agents that must exist on every node: log shippers (Fluentd, Filebeat), metrics collectors (node-exporter, Datadog agent), network plugins (Calico, Cilium), storage daemons (Ceph OSD), security agents (Falco). A Deployment manages a replicated application where you control the replica count independently of the number of nodes. If you need "one instance globally, horizontally scaled based on load" - use Deployment. If you need "one instance per node, always" - use DaemonSet. When new nodes are added to the cluster, the DaemonSet controller automatically schedules the agent pod on them. No Deployment HPA rule would achieve this.

---

**Q21: How do you debug a pod that is stuck in CrashLoopBackOff?**

CrashLoopBackOff means the container starts, crashes, and Kubernetes keeps restarting it with exponential backoff. Debugging steps in order: (1) `kubectl logs <pod> --previous` - get logs from the crashed container (not the current one which may not have logs yet). (2) `kubectl describe pod <pod>` - check Events section for OOMKilled (memory limit too low), exit codes (exit 1 = app error, exit 137 = OOM), failed liveness probes. (3) Check liveness probe configuration - if the probe path returns non-200 before the app is ready, Kubernetes kills it and creates a loop. Fix with `initialDelaySeconds`. (4) `kubectl exec -it <pod>, sh` - if the pod stays up long enough, shell in and check filesystem permissions, missing config files, env vars. (5) Override the command with `command: ["sleep", "3600"]` to prevent the crash and shell in. (6) Check resource limits - if `memory.limit` is too low, the container is OOMKilled on startup. (7) Verify secrets and configmaps the pod mounts - a missing secret causes immediate crash with clear error in logs.

---

**Q22: What is a Kubernetes finalizer and how do you implement one in Go?**

A finalizer is a namespaced key added to an object's `metadata.finalizers` list that prevents the object from being deleted until all finalizers are removed. When `kubectl delete` is called, Kubernetes sets `metadata.deletionTimestamp` but does NOT delete the object. The controller watching the object sees the `deletionTimestamp`, performs cleanup (e.g., snapshot a database, release a cloud resource, deregister from a service registry), then removes the finalizer with a `Patch` or `Update` - only then does Kubernetes garbage-collect the object.

In Go with controller-runtime:

```go
const myFinalizer = "myapp.io/cleanup"

// In Reconcile - add finalizer on creation
if !controllerutil.ContainsFinalizer(obj, myFinalizer) {
    controllerutil.AddFinalizer(obj, myFinalizer)
    return ctrl.Result{}, r.Update(ctx, obj)
}

// Handle deletion
if !obj.DeletionTimestamp.IsZero() {
    if err := r.performCleanup(ctx, obj); err != nil {
        return ctrl.Result{}, err
    }
    controllerutil.RemoveFinalizer(obj, myFinalizer)
    return ctrl.Result{}, r.Update(ctx, obj)
}
```

Key rule: cleanup in the finalizer must be idempotent - the controller may be restarted mid-cleanup, and `Reconcile` will be called again with `DeletionTimestamp` still set.

### Junior → FAANG: Extended Questions as Mid-Level Bar Preparation

The questions in this extended set (Q16 through Q22) target mid-level to senior hiring bars. They require you to compare approaches (Q16: Helm vs operator), describe security practices (Q17: secret management), explain operational behavior (Q18: PDB during drain), and debug real failure modes (Q21: CrashLoopBackOff).

For Q21 (CrashLoopBackOff debugging), the interview evaluator is watching your diagnostic sequence, not just whether you arrive at the right answer. The correct sequence is: `kubectl logs <pod> --previous` first (get the crash output from the container that already died), then `kubectl describe pod` (get exit code and Events), then consider overriding the container command with `sleep` to keep it alive for investigation. Interviewers mark down candidates who jump straight to "delete and redeploy" without investigating root cause.

Q22 (finalizers in Go) is a strong entry-level operator question. Being able to write the finalizer pattern from memory, including the `DeletionTimestamp` check and the `RemoveFinalizer` call, demonstrates that you understand how Kubernetes resource lifecycle works at the code level. If you can also explain why the cleanup must be idempotent (the controller may crash mid-cleanup and be called again), you are answering at mid-level depth.

### Senior @ FAANG: Extended Questions as Architecture Probes

Q16 (Helm vs operator) at the senior level is an architecture scope question. The interesting extension is: "your organization currently uses Helm for a stateful service with a complex failover procedure. At what point do you migrate to an operator?" The answer depends on: how frequently the manual procedure is executed (high frequency justifies the operator investment), how error-prone the manual procedure is (high error rate does too), and what the risk of doing the procedure incorrectly is (data loss risk accelerates the decision). Framing the migration decision with these three criteria is a staff-level answer.

Q17 (secret management) at the senior level extends to rotation strategy. External Secrets Operator with AWS Secrets Manager provides automated rotation if the secret is configured for rotation in AWS. But the application must be able to pick up the rotated secret without a pod restart (by re-reading the secret on a configurable interval), or it must be designed for zero-downtime restarts that occur when the mounted secret is updated. The ADR for secret management should include the rotation policy and the application handling strategy.

Q22 (finalizers) at the senior level extends to stuck finalizer mitigation. If a controller is deleted before it removes a finalizer, the resource is stuck in terminating state indefinitely. The mitigation is a platform-level monitoring alert that detects resources with `DeletionTimestamp` set for more than a configured time window, and an administrative procedure for manually removing stuck finalizers after verifying the external resource has been cleaned up. This operational concern is part of the operator lifecycle that senior engineers plan for before deploying to production.

---
