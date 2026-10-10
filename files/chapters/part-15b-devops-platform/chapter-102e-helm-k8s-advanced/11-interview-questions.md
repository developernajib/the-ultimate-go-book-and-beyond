## 102E.9 Core Kubernetes & Helm Interview Questions

**Q1: What is the difference between Helm and Kustomize? When would you use each?**

Helm uses Go templating (`{{ .Values.replicas }}`) embedded in YAML files, producing rendered manifests from a template + values. Helm manages release lifecycle: install, upgrade, rollback, history. Kustomize patches plain YAML without templates, using overlays, strategic merge patches, and JSON patches. Use Helm for: distributing reusable applications (third-party software, public charts), versioned releases with rollback, when you need pre/post hooks. Use Kustomize for: your own services where base YAML should be valid without tooling, environment-specific patches, GitOps workflows where generated YAML should be readable. Many teams use both: Helm for third-party apps, Kustomize for their services.

---

**Q2: What is a CRD and how does it extend Kubernetes?**

A Custom Resource Definition adds new resource types to the Kubernetes API. Once a CRD is installed, you can create, read, update, and delete instances of the new type using standard kubectl and the Kubernetes API. A custom controller (or operator) watches these resources and reconciles them with real-world state. Example: a `DatabaseCluster` CRD where each instance triggers the database operator to provision an actual RDS instance. Benefits: Kubernetes RBAC for your custom types, kubectl works natively, Kubernetes watch API for controllers, GitOps works because it's just YAML. CRDs enable the operator pattern - encoding operational knowledge (backup, failover, scaling) into software.

---

**Q3: What is the difference between a MutatingAdmissionWebhook and ValidatingAdmissionWebhook?**

Both intercept API calls before objects are stored. Mutating webhooks can MODIFY the object (add labels, inject sidecars, set default values). Validating webhooks can ACCEPT or REJECT but cannot modify. Order of execution: mutating webhooks run first (in parallel), then validating webhooks run on the (potentially mutated) object. This order matters: if you want to validate that a field exists, it must be set by the mutating webhook first. Common uses: mutating - sidecar injection, default values, label normalization. Validating - required labels, approved image registries, resource limits enforcement, security context requirements.

---

**Q4: How does KEDA differ from HPA with custom metrics?**

HPA with custom metrics requires: Prometheus Adapter (to expose Prometheus metrics as Kubernetes custom metrics), RBAC setup, and the metric must be available in the Kubernetes custom metrics API. KEDA provides 50+ built-in scalers (Kafka, SQS, RabbitMQ, Redis, HTTP, cron, Azure Service Bus) with pre-built authentication and configuration patterns. KEDA also supports scale-to-zero - HPA minimum is 1 replica, KEDA minimum is 0. KEDA installs its own metrics server. For event-driven workloads (Kafka consumers, SQS processors, scheduled batch jobs), KEDA is simpler and more powerful. For CPU/memory-based scaling of web services, HPA without KEDA is sufficient.

---

**Q5: Explain Kubernetes QoS classes and their impact on pod eviction.**

Three QoS classes: (1) Guaranteed: `requests == limits` for every resource (CPU and memory) in every container. Never evicted unless the node itself is out of memory. (2) Burstable: at least one container has requests != limits, or limits set without requests. Evicted after BestEffort pods when node is pressured. (3) BestEffort: no requests or limits at all. First to be evicted under node memory pressure. For production services: use Burstable (most common) or Guaranteed for stateful/critical services. Never use BestEffort in production. The eviction order: BestEffort → Burstable (starting with pods exceeding their requests) → Guaranteed.

---

**Q6: What is Pod Security Standards in Kubernetes 1.25+?**

Pod Security Standards replaced PodSecurityPolicy (deprecated in 1.21, removed in 1.25). Three policy levels enforced at the namespace level via labels: (1) Privileged: no restrictions (for kube-system components). (2) Baseline: minimal restrictions preventing privilege escalation, blocks hostNetwork, hostPath, privileged containers. (3) Restricted: heavily restricted, requires runAsNonRoot, non-default seccomp profile, drops all capabilities. Enforce mode (`pod-security.kubernetes.io/enforce: restricted`) rejects non-compliant pods. Warn mode allows but warns. Audit mode logs violations. Most application namespaces should use `restricted` or `baseline`.

---

**Q7: How would you implement a Kubernetes operator in Go?**

Use `controller-runtime` (`sigs.k8s.io/controller-runtime`), which provides the Reconciler interface, client, scheme, and manager. Steps: (1) define your CRD types as Go structs with `+kubebuilder:` markers. (2) implement `Reconcile(ctx, Request)` function - this is called whenever your watched resources change. (3) in Reconcile: fetch the custom resource, compare desired vs actual state, create/update/delete real resources to match desired. (4) return `Result{Requeue: true, RequeueAfter: 30s}` to re-check periodically. (5) handle finalizers for cleanup on deletion. Use `kubebuilder` scaffold to generate boilerplate. The reconcile loop is idempotent - it can run many times with the same result if the world already matches desired state.

---

**Q8: What are Helm release namespaces and why do they matter?**

Helm releases are scoped to a namespace. `helm install myapp . -n production` installs in the `production` namespace. The release metadata (history) is stored as a Secret in that namespace. If you install the same chart in two namespaces, they're independent releases with independent history. Resources created by Helm are in the namespace specified by the chart templates (or overridden by the namespace flag). Why it matters: (1) team isolation - teams manage their own namespaces, can't affect others. (2) RBAC - limit helm operations to specific namespaces. (3) multi-tenancy - same chart deployed independently per tenant. (4) rollback is namespace-scoped - `helm rollback` only affects that namespace's release.

---

**Q9: How do you handle Helm chart upgrades that require downtime?**

Strategies for zero-downtime Helm upgrades: (1) `create_before_destroy` on Deployments - new ReplicaSet is created before old one is scaled down (default rolling update). (2) Helm hooks - use `pre-upgrade` Job for schema migrations, `post-upgrade` Job for smoke tests. (3) `helm.sh/hook-weight` controls hook execution order. (4) Argo Rollouts with Helm - configure Helm chart to create a Rollout instead of Deployment for canary/blue-green support. (5) For CRD upgrades: version your CRDs using multiple `served: true` versions, implement conversion webhook if fields change, test upgrades in staging with production-like data. CRD upgrades in Helm are tricky because Helm doesn't upgrade CRDs by default (must use `--skip-crds=false` or upgrade CRDs separately).

---

**Q10: What is Helmfile and when would you use it?**

Helmfile manages multiple Helm releases declaratively - it's to Helm what Terraform is to individual cloud API calls. A `helmfile.yaml` describes all Helm releases, their values files, and dependencies. `helmfile apply` ensures all releases match the desired state. Use Helmfile when: deploying 5+ Helm charts that have dependencies (e.g., install Prometheus before Grafana before your dashboards), managing the same charts across multiple environments with different values, wanting `diff` support before applying (`helmfile diff` shows what would change). Alternative: ArgoCD ApplicationSet with Helm source - GitOps-native approach that doesn't require Helmfile.

---

**Q11: How do you prevent resource starvation in a multi-tenant Kubernetes cluster?**

Layered approach: (1) **Namespace ResourceQuota**: cap total CPU/memory per team namespace - prevents one team from consuming all cluster resources. (2) **LimitRange**: set default requests/limits so pods without explicit resources still count against quota. (3) **Priority Classes**: define priority for critical system workloads (PriorityClass.value = 1000000) vs application workloads (value = 100) - system pods can preempt application pods if needed. (4) **Node selectors and taints**: dedicate nodes to teams or workload types, preventing noisy neighbors at the OS level. (5) **PodDisruptionBudgets**: prevent cluster maintenance from evicting all pods of a critical service simultaneously. (6) **Network Policies**: prevent bandwidth starvation from misconfigured pods flooding the network.

---

**Q12: What is the Kubernetes scheduler and how can you influence scheduling decisions?**

The Kubernetes scheduler assigns pods to nodes based on: resource availability, taints/tolerations, nodeSelector, node affinity/anti-affinity, pod affinity/anti-affinity, and topology spread constraints. Influence scheduling: (1) `nodeSelector`: simple key-value match to specific nodes. (2) `nodeAffinity`: required (hard) and preferred (soft) rules with operators (In, NotIn, Exists). (3) `podAntiAffinity`: spread replicas across AZs (`topologyKey: topology.kubernetes.io/zone`) to avoid single-zone failures. (4) `topologySpreadConstraints`: ensure pods are evenly distributed across zones/nodes with `maxSkew`. (5) `taints/tolerations`: reserve nodes for specific workloads (e.g., GPU nodes tainted with `nvidia.com/gpu=:NoSchedule`, only GPU-tolerating pods scheduled there). For FAANG scale: always use `topologySpreadConstraints` for stateless services and `podAntiAffinity` for stateful services.

---

**Q13: How do you debug a pod that's stuck in Pending state?**

```bash
# 1. Describe the pod for events
kubectl describe pod <pod-name> -n <namespace>
# Look for: Events section - "FailedScheduling" or "Insufficient cpu"

# Common causes:
# "Insufficient cpu" → ResourceQuota exhausted or no node has enough CPU
# "0/5 nodes available: 5 Insufficient memory" → nodes too small
# "pod has unbound immediate PersistentVolumeClaims" → PVC not provisioned
# "nodes are tainted with {dedicated: gpu}" → pod missing gpu toleration

# 2. Check node capacity
kubectl describe nodes | grep -A 5 "Allocated resources"

# 3. Check ResourceQuota
kubectl describe resourcequota -n <namespace>

# 4. Check events for quota denial
kubectl get events -n <namespace> --sort-by='.lastTimestamp' | tail -20
```

---

### Junior → FAANG: Interview Questions as a Self-Assessment Tool

Work through each question in this list by giving your answer aloud before reading the answer. The questions that you answer correctly but with vague reasoning are more dangerous than the questions you cannot answer at all. Vague answers signal surface-level knowledge to interviewers, while "I don't know but here is how I would reason through it" signals problem-solving ability.

The questions that most reliably separate junior from mid-level candidates: Q3 (mutating vs validating webhook ordering), Q5 (QoS classes and eviction ordering), and Q7 (operator implementation in Go). These require both conceptual clarity and implementation familiarity. For Q7 specifically, be able to describe the idempotency requirement of a reconcile loop and why it matters, not just the scaffold commands.

Q13 (debugging a Pending pod) is a practical question where you earn points by being systematic. Interviewers are watching whether you know which command to run first, not whether you can recite all possible causes from memory. `kubectl describe pod` followed by `kubectl describe node` is the correct diagnostic sequence. Practice the commands until they are automatic.

**Q14: What are Init Containers and when should you use them?**

Init containers run to completion before app containers start. They share volumes with app containers and run sequentially. Use cases: (1) wait for dependencies - init container polls until database is ready before app starts (avoids app startup failures). (2) configuration injection - download config from Vault/S3, write to shared volume for app to read. (3) permission setup - change volume ownership (`chown`) before app container starts (app container runs as non-root, but volume created as root). (4) database migrations - run migrations in init container, ensuring they complete before multiple app replicas start (avoid race conditions). Key difference from sidecar containers (Kubernetes 1.29+): init containers run once and exit, sidecars run for the pod lifetime.

---

**Q15: How do you implement pod topology spread constraints for high availability?**

```yaml
spec:
  topologySpreadConstraints:
    # Spread evenly across availability zones
    - maxSkew: 1                    # at most 1 pod difference between zones
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule  # hard constraint
      labelSelector:
        matchLabels:
          app: shopapp-api

    # Also spread across nodes within a zone
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway  # soft constraint
      labelSelector:
        matchLabels:
          app: shopapp-api
```

For 6 replicas across 3 AZs: with `maxSkew=1`, scheduler ensures 2 pods per AZ (or 3/2/1 max). If one AZ fails, you lose at most 3 pods (50%), leaving 3 pods serving traffic. Without topology spread, all 6 could land in one AZ - a zone failure kills everything.

### Senior @ FAANG: Interview Questions as a Bar-Raiser Signal Map

At L6 and above, the interview format shifts. You are rarely asked "how does X work." Instead you are asked "how would you design a system to do X at scale" or "what went wrong in this scenario and how would you fix it." The questions here are the building blocks for those larger system design conversations.

Q6 (Pod Security Standards) is a platform policy question at the senior level. The interesting follow-up is not "what are the three levels" but "how would you migrate a cluster from no PSS enforcement to Restricted enforcement without breaking production workloads?" That migration requires an audit phase (warn mode to discover violations), a remediation phase (fix non-compliant workloads with application team coordination), and a rollout phase (enforce mode namespace by namespace). Planning and executing that migration across a large engineering organization without causing production outages is a staff-level project.

Q9 (Helm upgrades requiring downtime) is a system design question in disguise. The correct answer at senior level includes: the CRD upgrade problem (Helm does not upgrade CRDs by default, which means the application code can be newer than the CRD schema it expects), the database migration ordering problem (pre-upgrade hooks with idempotent migrations), and the conversion webhook requirement for incompatible CRD schema changes. Each of these is a failure mode that has caused production incidents at real organizations, and knowing all three with their mitigations is a bar-raiser signal.

Q12 (scheduler influence) at the senior level extends to the cluster autoscaler interaction. `topologySpreadConstraints` with `DoNotSchedule` can prevent the autoscaler from placing pods on new nodes if the zone distribution constraint cannot be satisfied. The staff-level insight is that HA scheduling constraints and cost efficiency (autoscaler scale-in) are sometimes in tension, and resolving that tension requires intentional configuration of both the pod constraints and the autoscaler behavior.

---
