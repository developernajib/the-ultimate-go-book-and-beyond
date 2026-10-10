## 101.2 Custom Resource Definitions (CRDs)

### Defining a Custom Resource

A CRD teaches the Kubernetes API server about a brand-new object kind without modifying its source code. The `openAPIV3Schema` block is not merely documentation, the API server uses it as a strict validation gate, rejecting any `WebApp` manifest that omits a required field or violates a constraint (such as `replicas` exceeding 10) before the object is even persisted to etcd. The `subresources: status: {}` declaration is equally important: it causes the API server to expose a separate `/status` sub-resource endpoint, which means the controller can update observed state without triggering another reconcile loop on the spec, preventing thundering-herd feedback cycles.

```yaml
# config/crd/bases/apps.example.com_webapps.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: webapps.apps.example.com
spec:
  group: apps.example.com
  names:
    kind: WebApp
    listKind: WebAppList
    plural: webapps
    singular: webapp
    shortNames:
      - wa
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required:
                - image
                - replicas
              properties:
                image:
                  type: string
                  description: Container image to deploy
                replicas:
                  type: integer
                  minimum: 1
                  maximum: 10
                  default: 1
                port:
                  type: integer
                  default: 8080
                resources:
                  type: object
                  properties:
                    cpu:
                      type: string
                      default: "100m"
                    memory:
                      type: string
                      default: "128Mi"
            status:
              type: object
              properties:
                phase:
                  type: string
                replicas:
                  type: integer
                availableReplicas:
                  type: integer
                conditions:
                  type: array
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Image
          type: string
          jsonPath: .spec.image
        - name: Replicas
          type: integer
          jsonPath: .spec.replicas
        - name: Phase
          type: string
          jsonPath: .status.phase
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
```

---

### Junior → FAANG: CRDs as Go Types Projected Into Kubernetes

The mental model that makes CRDs click: a CRD is a Go type definition (struct) that is registered with the Kubernetes API server. `kubebuilder:validation` markers on struct fields become OpenAPI validation schema in the CRD YAML. The Kubernetes API server enforces this schema on admission, providing validation without requiring a webhook for simple constraints.

The `spec` versus `status` split is fundamental. Spec is what the user declares as desired state (and is writable by users). Status is what the controller writes as observed state (and should only be written by the controller, not users). Mixing user-writable and controller-written fields in the same section causes confusion and race conditions. Using the status subresource (enabled by `+kubebuilder:subresource:status` marker) enforces this separation at the API level.

First-job habit: design the CRD schema with a focus on the user experience, not the controller's implementation convenience. A good CRD makes the intended usage obvious from the field names and documentation strings. A CRD that exposes internal controller state in the spec is hard to use and understand.

### Senior @ FAANG: CRD Design and the API Contract Commitment

At staff level, CRD design is an API contract commitment. Once a CRD version is in use in production, changing it incompatibly (removing required fields, changing field types) requires a versioned API migration. The migration process (conversion webhook, storage version migration, updating all consumers) is complex and error-prone. Designing the CRD schema carefully upfront is significantly cheaper than migrating it after adoption.

The API design principles that matter most for CRDs: use semantic field names (not internal state names), provide defaulting for fields that have sensible defaults (via a defaulting webhook or the `default` marker), document every field with inline documentation comments that appear in `kubectl explain`, and version the API conservatively (start with `v1alpha1`, promote to `v1beta1` after sufficient validation, promote to `v1` only when the schema is stable and well-understood).

The printed columns feature (marker annotations that tell `kubectl get` which fields to display in the default table output) is a usability detail that significantly affects the operator user experience. If a user runs `kubectl get myresource` and sees only the name and age, they will need to add `-o yaml` for every status check. If the printed columns show the readiness status and key configuration parameters, the resource is self-describing. This is an API design detail that the staff engineer should define in the CRD specification before implementation begins.
