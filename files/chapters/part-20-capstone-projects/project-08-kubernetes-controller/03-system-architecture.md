## System Architecture

Before diving into code, it helps to visualize how all the pieces of a Kubernetes operator fit together. The operator runs as a pod inside the cluster and watches the API server for changes to your custom resource. When it detects a change, it triggers a reconciliation loop that creates or updates child resources like StatefulSets, Services, and ConfigMaps to match the desired state. The following diagram shows the high-level architecture of our PostgreSQL operator and how it interacts with both the Kubernetes control plane and user namespace.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES OPERATOR                                   │
├───────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────┐         │
│  │                     CONTROL PLANE                                │         │
│  │  ┌────────────────┐         ┌────────────────┐                   │         │
│  │  │ API Server     │◄────────│  Operator Pod  │                   │         │
│  │  │                │         │  ┌──────────┐  │                   │         │
│  │  │ - CRD Registry │         │  │Controller│  │                   │         │
│  │  │ - Webhooks     │         │  │ Manager  │  │                   │         │
│  │  │ - Validation   │         │  └────┬─────┘  │                   │         │
│  │  └────────┬───────┘         │       │        │                   │         │
│  │           │                 │  ┌────▼─────┐  │                   │         │
│  │           │                 │  │PostgreSQL│  │                   │         │
│  │           │                 │  │Controller│  │                   │         │
│  │           │                 │  └────┬─────┘  │                   │         │
│  │           │                 │       │        │                   │         │
│  │           │                 │  ┌────▼─────┐  │                   │         │
│  │           │                 │  │Reconcile │  │                   │         │
│  │           │                 │  │  Loop    │  │                   │         │
│  │           │                 │  └──────────┘  │                   │         │
│  │           │                 └────────────────┘                   │         │
│  └───────────┼──────────────────────────────────────────────────────┘         │
│              │                                                                │
│  ┌───────────▼──────────────────────────────────────────────────────┐         │
│  │                    USER NAMESPACE                                 │        │
│  │                                                                    │       │
│  │  ┌──────────────────────────────────────────────────────────┐    │         │
│  │  │ PostgresCluster CR (Custom Resource)                     │    │         │
│  │  │ apiVersion: database.example.com/v1alpha1                │    │         │
│  │  │ kind: PostgresCluster                                    │    │         │
│  │  │ spec:                                                    │     │        │
│  │  │   replicas: 3                                            │    │         │
│  │  │   version: "15.2"                                        │    │         │
│  │  └──────────────────────────────────────────────────────────┘    │         │
│  │                              │                                     │       │
│  │                              │ Manages                            │        │
│  │                              ▼                                     │       │
│  │  ┌────────────────────────────────────────────────────────────┐  │         │
│  │  │                  CHILD RESOURCES                           │   │        │
│  │  │                                                            │    │       │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │ │          │
│  │  │  │ StatefulSet  │  │   Service    │  │  ConfigMap   │      │ │          │
│  │  │  │              │  │              │  │              │      │ │          │
│  │  │  │ - postgres-0 │  │ - Read/Write │  │ - postgres   │      │ │          │
│  │  │  │ - postgres-1 │  │ - Read-Only  │  │   config     │      │ │          │
│  │  │  │ - postgres-2 │  │ - Headless   │  │              │      │ │          │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘      │ │          │
│  │  │                                                            │    │       │
│  │  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │ │          │
│  │  │  │    Secret    │  │     PVC      │  │   CronJob    │      │ │          │
│  │  │  │              │  │              │  │              │      │ │          │
│  │  │  │ - postgres   │  │ - Data PVCs  │  │ - Backups    │      │ │          │
│  │  │  │   credentials│  │              │  │              │      │ │          │
│  │  │  └──────────────┘  └──────────────┘  └──────────────┘      │ │          │
│  │  └────────────────────────────────────────────────────────────┘  │         │
│  └────────────────────────────────────────────────────────────────── ┘        │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Reconciliation Flow:**

```
User creates PostgresCluster CR
         │
         ▼
API Server validates (webhook)
         │
         ▼
Controller watches for change
         │
         ▼
┌────────▼─────────┐
│ Reconcile Loop   │
└────────┬─────────┘
         │
         ├─► 1. Fetch PostgresCluster
         │
         ├─► 2. Check for deletion (finalizer)
         │
         ├─► 3. Reconcile ConfigMap
         │
         ├─► 4. Reconcile Secret
         │
         ├─► 5. Reconcile StatefulSet
         │
         ├─► 6. Reconcile Services
         │
         ├─► 7. Reconcile Backup CronJob
         │
         ├─► 8. Update Status
         │
         ├─► 9. Requeue if needed
         │
         ▼
   Success/Error
```
