## 102E.2 Custom Resource Definitions (CRDs)

### Writing a CRD

A Custom Resource Definition (CRD) extends the Kubernetes API with new resource types specific to your domain. Once a CRD is applied, the API server accepts, stores, and serves instances of that resource. Called custom resources. Just like built-in types such as Deployments or Services. The `openAPIV3Schema` field enforces a JSON Schema validation contract on the resource's `spec`, rejecting malformed custom resources at admission time before they are persisted to etcd.

```yaml
# crd-databasecluster.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: databaseclusters.database.myorg.io
spec:
  group: database.myorg.io
  names:
    kind: DatabaseCluster
    listKind: DatabaseClusterList
    plural: databaseclusters
    singular: databasecluster
    shortNames: [dbc]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true  # only one version can be storage=true
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [engine, version, replicas]
              properties:
                engine:
                  type: string
                  enum: [postgres, mysql, redis]
                  description: Database engine type
                version:
                  type: string
                  pattern: '^[0-9]+\.[0-9]+$'
                  description: Engine version (e.g., "16.2")
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 10
                  default: 1
                storageGB:
                  type: integer
                  minimum: 10
                  maximum: 1000
                  default: 20
                instanceClass:
                  type: string
                  default: "db.t3.medium"
                backup:
                  type: object
                  properties:
                    enabled:
                      type: boolean
                      default: true
                    retentionDays:
                      type: integer
                      minimum: 1
                      maximum: 35
                      default: 7
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Creating, Running, Updating, Failed, Deleting]
                endpoint:
                  type: string
                conditions:
                  type: array
                  items:
                    type: object
                    required: [type, status]
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                        enum: [True, False, Unknown]
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
      # Enable status subresource so status can be updated independently
      subresources:
        status: {}
      # Printer columns: shown by kubectl get databaseclusters
      additionalPrinterColumns:
        - name: Engine
          type: string
          jsonPath: .spec.engine
        - name: Replicas
          type: integer
          jsonPath: .spec.replicas
        - name: Phase
          type: string
          jsonPath: .status.phase
        - name: Endpoint
          type: string
          jsonPath: .status.endpoint
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
```

### Junior → FAANG: CRDs as the Foundation of the Operator Pattern

The most common misconception among junior engineers is that CRDs are just "custom ConfigMaps." They are not. A CRD registers a new type with the Kubernetes API server, which means it gets admission validation, watch events, RBAC, and `kubectl` support just like a built-in type. The difference between storing configuration in a ConfigMap versus a CRD is the difference between an untyped key-value store and a typed, validated, versionable API object.

For interviews at the entry level, know these three things concretely: how `openAPIV3Schema` rejects a malformed custom resource before it reaches etcd, what the `status` subresource does and why updating status separately from spec matters, and what `additionalPrinterColumns` adds to the `kubectl get` experience. Being able to walk through the CRD YAML above field by field, and explain why each constraint exists, is a clear signal that you have used CRDs in practice rather than just read about them.

The prerequisite gap that trips up juniors in interviews: not knowing that a CRD alone does nothing. The CRD defines the schema. A controller (an operator) watches instances of that custom resource and acts on them. You need both halves to have a working system.

### Senior @ FAANG: CRD API Governance at Cluster Scale

At staff level, the key question is not how to write a CRD but how to govern a growing surface area of CRDs in a shared cluster. Every CRD you install is a new API that application teams can start depending on. That dependency has a cost: you cannot remove or incompatibly change a CRD without a migration plan, and in large organizations those migrations are slow and politically difficult.

The governance pattern that mature platform teams adopt: treat every CRD as a versioned API with an explicit stability designation (alpha, beta, stable) and a documented deprecation policy. Alpha CRDs can change without notice. Beta CRDs get a deprecation warning before removal. Stable CRDs require a conversion webhook and a multi-version migration path before any field can be removed or renamed. This is not bureaucracy for its own sake. It is the minimum process needed to prevent the platform team from being blocked by a CRD migration every quarter.

Conversion webhooks are the mechanism Kubernetes provides for multi-version CRDs. When you need to add a field to `v1beta1` that does not exist in `v1alpha1`, a conversion webhook translates between versions on read and write. Implementing conversion webhooks correctly is non-trivial: the webhook must be idempotent, must handle partial objects, and must not lose unknown fields. This is bar-raiser material at L6 and above.

An ADR for any production CRD should cover: the group and versioning strategy, which fields are required versus optional and why, what the status lifecycle states mean and what transitions are valid, how the CRD will be upgraded across versions, and who owns it. Clusters at FAANG scale routinely have thirty or more CRDs. Without an ownership registry, abandoned CRDs accumulate and become maintenance debt.

---
