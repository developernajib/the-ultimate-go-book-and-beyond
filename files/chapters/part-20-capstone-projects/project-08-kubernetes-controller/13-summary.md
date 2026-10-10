## Summary

This capstone project demonstrates a production-ready Kubernetes operator implementing:

1. **Custom Resource Definition**: Full-featured CRD with OpenAPI validation, status subresource, and printer columns

2. **Controller Pattern**: Proper reconciliation loop with error handling, requeue logic, and status updates

3. **Child Resource Management**: Creating and managing StatefulSets, Services, ConfigMaps, Secrets, and CronJobs with owner references

4. **Status Reporting**: Comprehensive status with conditions, phase tracking, and structured information

5. **Admission Webhooks**: Validation and mutation webhooks for ensuring cluster integrity

6. **Testing**: Comprehensive unit and integration tests using envtest

7. **Leader Election**: High availability operator deployment with multiple replicas

8. **Deployment**: Helm chart with proper RBAC, security contexts, and production-ready defaults

9. **Observability**: Prometheus metrics, health checks, and event recording

10. **Production Features**: Finalizers, backup management, monitoring integration, and high availability

**Key Kubernetes Concepts Demonstrated:**
- Controller runtime patterns
- API machinery and client-go
- Webhook admission control
- Leader election
- RBAC and security
- Helm packaging
- Testing strategies
- Observability

This operator serves as a blueprint for building production Kubernetes controllers at FAANG-level companies.

---

## FAANG Interview Questions

**Q: How does the Kubernetes controller reconciliation loop guarantee eventual consistency, and how do you handle partial failures during child resource creation?**

A: Kubernetes operators are level-triggered, not edge-triggered: the `Reconcile` function observes the current cluster state and takes actions to match the desired state declared in the CRD spec, regardless of which specific event triggered the loop. Every reconciliation step must be idempotent. If a child resource creation fails halfway through (e.g., ConfigMap and Secret are created, but StatefulSet creation errors due to insufficient quota), the controller records an error condition in the CR status and returns an error. The controller-runtime workqueue automatically requeues the request with exponential backoff and jitter. On the next execution, the controller detects that the ConfigMap and Secret already exist, leaves them intact, and retries the StatefulSet creation.

**Q: How do client-go informers and controller-runtime caches work, and what is the danger of cache staleness?**

A: Informers maintain local in-memory caches populated by the API server's List-Watch stream (via HTTP chunked transfer / HTTP/2 streaming) using a `DeltaFIFO` queue and local indexer (`cache.Store`). Controller reads (`r.Get` and `r.List`) target this in-memory cache to prevent saturating the API server and etcd with read requests. However, client writes (`r.Create`, `r.Update`, `r.Patch`) bypass the local cache and hit the API server directly. Because informer caches update asynchronously after the API server persists the mutation, an immediate read after a write might return stale data. If an update relies on an outdated `metadata.resourceVersion`, the API server rejects it with an HTTP 409 Conflict error (`errors.IsConflict(err)`). Controllers must handle conflicts by returning an error to trigger an immediate requeue, at which point the informer cache has caught up with the latest version.

**Q: How do finalizers work, and what precautions prevent deadlocked deletions?**

A: Finalizers (`metadata.finalizers`) inform the Kubernetes garbage collector to postpone deletion of an API object until registered cleanup logic completes. When a user runs `kubectl delete`, the API server sets `metadata.deletionTimestamp` instead of immediately deleting the object. The controller checks `!deletionTimestamp.IsZero()`, performs external teardowns (e.g., gracefully draining database connections, retaining external S3 backup archives, or deprovisioning cloud load balancers), and then removes its finalizer string using a patch or update. Once the finalizer array is empty, Kubernetes removes the object from etcd. To prevent deadlocks where a missing external dependency prevents finalizer removal and blocks deletion indefinitely, operators must enforce aggressive timeouts via `context.WithTimeout`, log descriptive error events, and provide an administrative escape hatch (e.g., an annotation such as `operator.database/skip-teardown: "true"`) allowing manual unblocking without editing etcd directly.

**Q: When should you use Mutating/Validating Admission Webhooks versus OpenAPI v3 schema validation and CEL?**

A: Modern Kubernetes (v1.25+) encourages shifting validation left into OpenAPI v3 schemas and Common Expression Language (CEL) rules (`x-kubernetes-validations`). CEL executes in-process inside the kube-apiserver without network overhead, eliminating webhook latency and availability dependencies. Use CEL for intra-object validation, immutability constraints, and transitions (e.g., verifying that a replica count cannot decrease below 1 or that a storage class cannot be modified). Reserve admission webhooks for operations CEL cannot perform: cross-resource referential integrity checks (verifying that a referenced Secret exists in the target namespace), cluster-wide capacity checks, dynamic field defaulting that requires external token generation, or pod security sidecar injection.

**Q: How do you achieve high availability and prevent split-brain in multi-replica operator deployments?**

A: Multi-replica operator deployments use leader election managed via the `coordination.k8s.io/v1` `Lease` API. All operator pods run informers to keep local caches warm, but only the replica holding the active Lease lock starts its reconciliation workers. The leader renews the Lease periodically (e.g., renew deadline 10s, lease duration 15s). If the leader network-partitions or enters an extended stop-the-world garbage collection pause, the lease expires and standby replicas elect a new leader. To prevent split-brain where the old leader resumes execution while a new leader reconciles, the controller runtime passes a leader context that is cancelled the moment lease renewal fails. All active goroutines must listen to `ctx.Done()` and abort ongoing API calls immediately.

### Junior → FAANG: Bridging Controller Fundamentals to Interview Readiness

Junior engineers often confuse Kubernetes controllers with simple cron jobs or event listeners. In technical interviews, stand out by articulating the level-triggered design philosophy: a controller does not care *what happened*; it only cares *what exists now* versus *what should exist*. If the network drops 50 events, a level-triggered reconciler still arrives at the correct final state on its next pass.

Familiarize yourself with the core client-go machinery: `CustomResourceDefinition`, `GroupVersionResource` (GVR), `GroupVersionKind` (GVK), `Scheme`, `Informer`, `WorkQueue`, and `Indexers`. Practice explaining how `OwnerReferences` automate garbage collection (`BlockOwnerDeletion` and `PropagationPolicy: Foreground/Background`), ensuring that deleting a custom resource automatically cleans up all associated Deployments, Pods, and Services without orphan leaks.

### Senior @ FAANG: Governing Operator Platforms at Scale

At staff and principal levels, operator engineering shifts from writing single-purpose controllers to governing enterprise-wide operator platforms managing hundreds of thousands of custom resources across multiple clusters. Key architecture concerns include:

1. **CRD Lifecycle and Schema Evolution**: Designing conversion webhooks (`v1alpha1` -> `v1beta1` -> `v1`) and managing storage versions in etcd. You must design zero-downtime schema migrations where old and new CR versions coexist seamlessly.
2. **Multi-Cluster Orchestration**: Moving beyond single-cluster controllers to hub-and-spoke topologies (similar to Red Hat Advanced Cluster Management or Google Anthos Config Management) where a management cluster controller projects state down into edge clusters using work agents.
3. **Informer Memory Optimization**: In clusters with tens of thousands of resources, full informers consume gigabytes of memory. Staff engineers configure metadata-only informers (`client.MetadataClient`), tune resync periods (avoiding synchronized thundering herds), and utilize `CacheOptions` to scope informers to specific namespaces or label selectors.
4. **API Server Protection**: Tuning client-go rate limiters (`client.Options.QPS` and `Burst`) and implementing token-bucket flow control to prevent an operator crash-loop from taking down the cluster control plane.

---

## Navigation & Cross-References

| [Project 7: CI/CD Platform](../project-07-cicd-platform/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Project 9: Observability Platform](../project-09-observability-platform/00-introduction.md) |
| :--- | :---: | ---: |
| ◀ Previous Project | Table of Contents | Next Project ▶ |

