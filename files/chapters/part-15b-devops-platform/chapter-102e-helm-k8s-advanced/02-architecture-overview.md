## Architecture Overview

Advanced Kubernetes deployments layer multiple control mechanisms on top of core workload primitives. Admission webhooks intercept every API server request before it reaches etcd, enabling both mutation (injecting sidecars, setting defaults) and validation (rejecting non-compliant specs). Custom Resource Definitions combined with controllers extend the Kubernetes API to model domain-specific infrastructure, while the autoscaling stack. HPA for reactive scaling, VPA for right-sizing, and KEDA for event-driven workloads. Ensures resources match actual demand rather than worst-case reservations.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Kubernetes Advanced Layers                            │
└──────────────────────────────────────────────────────────────────────────┘

  Admission Control (Webhooks)
  ┌──────────────────────────────────────────────────────────────────┐
  │  API Server → MutatingWebhook → ValidatingWebhook → etcd         │
  │               (inject sidecar)  (enforce policy)                 │
  └──────────────────────────────────────────────────────────────────┘
              │
              ▼
  Custom Resources (CRDs)
  ┌──────────────────────────────────────────────────────────────────┐
  │  CRD: DatabaseCluster  →  Custom Controller  →  Real Resources   │
  │  spec.replicas: 3          (reconcile loop)      3x StatefulSet  │
  └──────────────────────────────────────────────────────────────────┘

  Autoscaling Stack
  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────┐
  │  HPA                │  │  VPA                │  │  KEDA       │
  │  CPU/Memory/Custom  │  │  Right-size requests│  │  Kafka lag  │
  │  metrics scaling    │  │  and limits         │  │  SQS depth  │
  └─────────────────────┘  └─────────────────────┘  └─────────────┘

  Network Policy (Zero Trust)
  ┌──────────────────────────────────────────────────────────────────┐
  │  Default: deny all  →  Allow: api→db  →  Allow: ingress→api      │
  │  No pod can communicate unless explicitly allowed                │
  └──────────────────────────────────────────────────────────────────┘

  Resource Management
  ┌──────────────────────────────────────────────────────────────────┐
  │  Namespace Quota → LimitRange → PDB → QoS Class                  │
  │  (team budget)    (per-pod limits) (min available) (Guaranteed)  │
  └──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams as Interview Preparation

This diagram is a compressed view of how control flows through a Kubernetes cluster. For interview preparation, the most important insight is the ordering: mutation happens before validation, and both happen before the object is written to etcd. That ordering has practical consequences. A mutating webhook can supply defaults that a validating webhook then checks. If you reverse the mental model and think validation happens first, you will give wrong answers about webhook interaction.

The second insight is that each layer in this diagram corresponds to a different organizational concern. Admission control is policy. CRDs and controllers are abstraction. Autoscaling is efficiency. Network policy is security. Resource management is cost and reliability. Knowing which layer to reach for when solving a given problem is a judgment skill that interviews test with scenario questions: "how would you ensure every pod in the cluster has a memory limit?" is an admission control question, not a Helm question.

### Senior @ FAANG: Architecture as a Contract Surface Between Platform and Application Teams

The layered architecture shown here is not just a technical decomposition. Each layer is a place where the platform team makes and enforces a promise to application teams, and each layer introduces potential failure modes that affect cluster availability.

The admission control layer deserves the most scrutiny at staff level. Webhooks that are misconfigured, slow, or unavailable during an API server operation can prevent pods from starting, block deployments, or cascade into cluster-wide degradation. The `failurePolicy` field is an architectural decision: `Fail` (fail-closed) gives safety but risks availability if the webhook has a bug or is unreachable. `Ignore` (fail-open) preserves availability but can allow non-compliant workloads through during an incident. That tradeoff should be documented as an ADR per webhook, not left as a default.

The CRD layer introduces API governance concerns. Every CRD you add to a cluster is a new API that application teams can start depending on. Removing or changing a CRD later requires a migration plan. Staff-level platform engineers maintain a CRD registry with ownership, stability status (alpha/beta/stable), and a deprecation policy. Clusters at FAANG scale typically have dozens of CRDs and the operational overhead of managing them, including validation schema updates, conversion webhooks for version upgrades, and deletion of abandoned CRDs, is a meaningful ongoing cost.

The resource management layer at the bottom is where platform economics live. Namespace quotas translate directly into cloud spend controls. Getting this layer right, including LimitRange defaults that prevent unbounded resource requests without blocking legitimate burst usage, requires understanding actual workload behavior rather than setting conservative numbers and hoping. At L6/L7, this layer is designed in collaboration with finance and capacity planning teams, not set once and forgotten.
