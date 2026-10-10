## 102E.6 Resource Management

### Namespace Resource Quotas

Resource quotas prevent any single team or namespace from consuming all cluster capacity. They set hard limits on the total CPU, memory, and storage that all pods in a namespace may collectively request, as well as limits on the number of objects such as services and load balancers. Quotas are enforced at admission time. A pod that would exceed the namespace quota is rejected before it is scheduled, giving you predictable multi-tenancy without requiring dedicated node pools per team.

```yaml
# Limit total resource usage per team namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-quota
  namespace: team-backend
spec:
  hard:
    requests.cpu: "20"          # total CPU requests
    requests.memory: 40Gi       # total memory requests
    limits.cpu: "40"            # total CPU limits
    limits.memory: 80Gi         # total memory limits
    pods: "100"                 # max pods
    services: "20"              # max services
    persistentvolumeclaims: "10"
    count/deployments.apps: "20"
    count/secrets: "50"
```

### LimitRange - Per-Pod Defaults

A `LimitRange` sets default CPU and memory requests and limits that are automatically applied to any container that does not specify them explicitly. Without a LimitRange, a pod without resource specifications has unlimited CPU and memory, making it a potential noisy neighbor that starves other pods on the same node. LimitRanges also set maximum values, preventing individual containers from requesting unreasonably large resources that the cluster cannot accommodate.

```yaml
# Auto-apply resource limits and set defaults
apiVersion: v1
kind: LimitRange
metadata:
  name: default-limits
  namespace: shopapp-production
spec:
  limits:
    - type: Container
      default:         # applied if container has no limits
        cpu: 500m
        memory: 512Mi
      defaultRequest:  # applied if container has no requests
        cpu: 100m
        memory: 128Mi
      max:             # maximum allowed
        cpu: "4"
        memory: 8Gi
      min:             # minimum allowed
        cpu: 50m
        memory: 64Mi
    - type: Pod
      max:
        cpu: "8"
        memory: 16Gi
    - type: PersistentVolumeClaim
      max:
        storage: 100Gi
```

### QoS Classes

Kubernetes assigns every pod one of three Quality of Service (QoS) classes based on the resource requests and limits of its containers. `Guaranteed` pods (requests equal limits for all containers) are the last to be evicted under memory pressure. They are the right class for latency-sensitive production services. `Burstable` pods can use more CPU/memory than requested up to the limit, while `BestEffort` pods have no resources specified at all and are evicted first. Understanding which class your pods fall into is essential for predicting behavior during node memory pressure events.

```yaml
# Guaranteed QoS: requests == limits for ALL containers
# Best for: critical services, databases
resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 500m    # same as request
    memory: 512Mi  # same as request

# Burstable QoS: requests < limits (or missing for one resource)
# Best for: most applications
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 1000m    # can burst to 1 CPU
    memory: 512Mi

# BestEffort QoS: no requests or limits
# First to be evicted under pressure - avoid for production workloads
```

### Junior → FAANG: Resource Management as Production Hygiene

The entry-level insight that many engineers miss: a Kubernetes cluster without ResourceQuotas and LimitRanges is a shared resource with no fairness guarantees. One team's runaway Deployment can starve every other team's pods by consuming all available CPU and memory on every node. Quotas and LimitRanges are how multi-tenant clusters stay sane.

The QoS class distinction is a high-frequency interview topic because it has concrete behavioral consequences. Guaranteed pods survive node memory pressure. BestEffort pods are killed first. The practical implication: if you run a database pod without setting `requests == limits`, it becomes Burstable and can be evicted under pressure, which is a data availability risk. Stateful workloads with persistent storage should almost always be Guaranteed QoS.

The prerequisite gap: not knowing that `requests` and `limits` serve different purposes. `requests` is the scheduler's input: it uses this number to decide which node has enough capacity. `limits` is the kubelet's enforcement boundary: it kills or throttles containers that exceed it. A container can be scheduled on a node that has 500 MB of available memory (matching its 500 MB request) and then grow to consume 2 GB (up to its limit), as long as the node has that physical capacity available. Confusing requests with limits is a fundamental misunderstanding that surfaces in system design interviews.

### Senior @ FAANG: Resource Management as Platform Economics

At staff and principal level, resource management is where platform engineering meets financial accountability. Namespace ResourceQuotas translate directly into cloud cost controls. Getting the numbers right requires understanding actual workload behavior, not just setting conservative values and hoping.

The common failure mode: a platform team sets quotas based on what they think teams need, teams request increases as a reflex when they hit any limit, and the quota values become meaningless because they are always higher than actual usage. The mature approach uses historical utilization data, from Prometheus or your cloud provider's cost dashboard, to set quotas at approximately 150 percent of peak observed usage. Teams that consistently use less than 50 percent of their quota get a review conversation. This turns resource quotas from a bureaucratic gate into a cost optimization feedback loop.

LimitRange defaults require careful calibration. Setting defaults that are too low causes OOMKill cascades when services hit unexpected memory pressure. Setting defaults that are too high means every pod without explicit resources consumes more capacity than it needs. The right default is the median resource usage of the services in your organization, which is a data-driven number. It also means LimitRange defaults should be revisited annually as the service mix changes.

The PodDisruptionBudget interaction with cluster autoscaler and node drain is a real operational concern at scale. A PDB that requires `minAvailable: N` where N equals the current replica count will block node drains indefinitely, stalling cluster upgrades. The staff-level check is: for every PDB in production, can the cluster drain a node in the normal upgrade path without violating it? This requires knowing both the PDB configuration and the current replica count of the workload it protects. Automated tooling that validates PDB drain-compatibility before a cluster upgrade is the production-grade approach.

---
