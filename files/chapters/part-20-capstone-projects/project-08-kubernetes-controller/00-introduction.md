# Capstone Project 8: Kubernetes Operator - Database Controller

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Production-ready Kubernetes Operator managing PostgreSQL lifecycle
**Tech Stack**: Go 1.27+, Kubernetes 1.30+, client-go, controller-runtime, Kubebuilder, K3s/Kind, Prometheus, Helm

---

### Project Overview & Architecture

Kubernetes Operators represent the pinnacle of cloud-native automation in Go. By extending the Kubernetes control plane with Custom Resource Definitions (CRDs) and custom reconciliation controllers, operators encode human operational knowledge—provisioning, automated failover, backup scheduling, point-in-time recovery, and minor version upgrades—directly into software.

In this capstone project, you will design and build an enterprise-grade Kubernetes Database Controller that manages high-availability PostgreSQL clusters. The controller continuously watches custom `DatabaseCluster` specifications and reconciles actual cluster state against desired state, spinning up leader-follower replication topologies, configuring dynamic persistent volume claims, and coordinating zero-downtime failovers.

```
┌──────────────────────────────────────────────────────────────┐
│                    Kubernetes Control Plane                  │
│                                                              │
│   API Server ──────> Admission Webhooks (Validation/Default) │
│       │                                                      │
│       ▼                                                      │
│   Custom Resource: DatabaseCluster (v1alpha1)                │
│       │                                                      │
└───────┼──────────────────────────────────────────────────────┘
        │ Watch / Reconcile Loop
        ▼
┌──────────────────────────────────────────────────────────────┐
│                  Database Controller Engine                  │
│                                                              │
│   Reconciliation Loop (Level-Triggered State Sync)           │
│   ├─ 1. Ensure Headless Services & Endpoints                 │
│   ├─ 2. Provision ConfigMaps & Secrets (Credentials)         │
│   ├─ 3. Reconcile StatefulSet (Primary + Standby Pods)       │
│   ├─ 4. Health Probing & Automated Failover Coordinator      │
│   └─ 5. Update CRD Status & Emit Kubernetes Events           │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

Throughout this project, you will build each layer of the operator step-by-step:

- **Part 1 & 2 (Scaffolding & CRD Design)**: Define the `DatabaseCluster` CRD schema with OpenAPI v3 validation, status subresources, scale markers, and printer columns.
- **Part 3 (Reconciliation Controller)**: Implement level-triggered reconciliation loops with `controller-runtime`, managing StatefulSets, headless services, and PVC storage bindings.
- **Part 4 (Admission Webhooks)**: Implement validating and mutating admission webhooks to reject invalid specs (e.g. replica count < 1, downgrade attempts) before reaching etcd.
- **Part 5 (Backup & Restore Subsystem)**: Automate scheduled WAL backups to S3-compatible object stores and coordinate point-in-time recovery workflows.
- **Part 6 (High Availability & Failover)**: Build automated leader election and standby promotion routines when node or pod liveness checks fail.
- **Part 7 (Testing & Verification)**: Write end-to-end integration tests using `envtest` and ephemeral KinD clusters to verify reconciliation invariants under simulated failures.

### Junior → FAANG: Mastering the Operator Pattern

For engineers transitioning into backend and platform roles, Kubernetes operators are the gold standard demonstration of systems Go.

- **Level-Triggered vs. Edge-Triggered Thinking**: A common beginner mistake is assuming the controller receives every state change event in order. In Kubernetes, the reconciliation loop is level-triggered: your `Reconcile()` function must be completely idempotent and handle any combination of partial states without crashing.
- **Understanding Status Subresources**: Modifying custom resource specs triggers new generation events. Beginners frequently create infinite reconciliation loops by updating the spec inside the reconcile loop. You must isolate status mutations to the `Status()` subresource update pipeline.
- **Etcd & API Server Etiquette**: Avoid making unbounded API calls or polling. Use client-go informers and listers with shared caches to read cluster state without hammering etcd.

### Senior @ FAANG: Production Reliability & Multi-Tenant Safety

At staff and principal altitude, evaluating an operator focuses on operational resilience, multi-cluster federation, and safety guardrails:

- **Leader Election & High Availability**: Operators must run with multiple replicas for high availability. Master how client-go `Lease` locks coordinate active controller leadership and ensure standby replicas can instantly take over when a pod is evicted.
- **Finalizers & Safe Deletion**: When a user deletes a `DatabaseCluster` resource, cascading deletion of underlying storage volumes can cause irreversible data loss. Implement custom Kubernetes Finalizers to cleanly archive backups and verify storage snapshots before allowing resource teardown.
- **Rate Limiting & Worker Queues**: Under cluster-wide disruptions (e.g. node pool upgrades), hundreds of reconciliation requests fire simultaneously. Tune `WorkQueue` rate-limiting algorithms (exponential backoff vs bucket limiting) to avoid thundering herd conditions against external cloud APIs.
