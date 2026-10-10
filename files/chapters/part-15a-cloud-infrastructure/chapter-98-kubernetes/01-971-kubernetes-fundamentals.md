## 98.1 Kubernetes Fundamentals

### Core Concepts

Kubernetes separates cluster concerns into a control plane and worker nodes. The control plane, API server, scheduler, controller manager, and etcd, holds and enforces desired state: you declare what you want (three replicas of a Pod) and the controller manager continuously reconciles reality toward that declaration. Worker nodes run the actual containers via a container runtime managed by the `kubelet` agent, while `kube-proxy` maintains the iptables or IPVS rules that route Service traffic across Pod IPs. Understanding this split is essential for Go developers because it explains why a crashed Pod is automatically restarted (the controller detects drift from desired state) and why Service IPs are stable even as the Pods behind them are replaced.

```
┌──────────────────────────────────────────────────────────────────┐
│                 KUBERNETES ARCHITECTURE                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CLUSTER                                                         │
│  ├── Control Plane                                               │
│  │   ├── API Server (kubectl talks to this)                      │
│  │   ├── Scheduler (assigns pods to nodes)                       │
│  │   ├── Controller Manager (maintains desired state)            │
│  │   └── etcd (cluster state store)                              │
│  │                                                               │
│  └── Worker Nodes                                                │
│      ├── kubelet (node agent)                                    │
│      ├── kube-proxy (network proxy)                              │
│      └── Container Runtime (Docker, containerd)                  │
│                                                                  │
│  WORKLOAD RESOURCES:                                             │
│  ├── Pod - Smallest deployable unit                              │
│  ├── Deployment - Manages pod replicas                           │
│  ├── Service - Stable network endpoint                           │
│  ├── Ingress - External HTTP routing                             │
│  ├── ConfigMap - Configuration data                              │
│  └── Secret - Sensitive data                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Building Kubernetes Intuition Through Hands-On Exploration

The control loop pattern is the central mental model for Kubernetes: a controller watches the current state, compares it to the desired state in the spec, and takes actions to reconcile any difference. This pattern appears in Deployments (desired replicas versus actual running pods), Services (desired endpoint set versus actual pod IPs), and every custom operator. Internalizing this model makes Kubernetes behavior predictable rather than magical.

The best way to build intuition is to break things deliberately and watch the control loops respond. Scale a Deployment to 0 replicas and watch the pods terminate. Delete a pod in a running Deployment and watch a new one appear. Patch a Deployment's image and watch the rolling update. Each experiment makes the machinery concrete.

For first-job readiness, be fluent with: `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl apply`, and `kubectl diff`. The last command (showing the diff between the live resource and what you are about to apply) is under-used by juniors and essential for safe production changes.

### Senior @ FAANG: Kubernetes Control Plane at Scale and Failure Modes

At staff level, understanding Kubernetes fundamentals means understanding the control plane's failure modes and the limits of the declarative model. The etcd cluster is the single source of truth. If it loses quorum, the control plane cannot make decisions. The API server is the gateway to all cluster state. If it is overloaded, all kubectl operations and all controller reconcile loops slow down or fail. Understanding these failure modes is required for designing a reliable platform.

The declarative model's limitation is that it describes desired state but does not model state transitions. A Deployment with `maxUnavailable: 0` and `maxSurge: 1` will roll out safely in normal conditions, but if the new version's pods fail health checks, the rollout stalls and neither the old nor the new version is healthy. Designing the rollout strategy, health check thresholds, and rollback triggers to handle this case correctly is a platform engineering concern.

At FAANG scale, the cluster API server receives thousands of requests per second from controllers, operators, admission webhooks, and user traffic. API priority and fairness configuration (APF) is the mechanism for ensuring that critical system controllers are not starved by user kubectl commands during high load. This is an advanced cluster configuration topic that the platform team owns, and getting it wrong causes cascading failures that look like application bugs.
