## 102F.4 Self-Service Infrastructure with Crossplane

Crossplane extends Kubernetes with cloud resource management - developers provision databases, S3 buckets, and Redis clusters using Kubernetes YAML.

```yaml
# Install Crossplane
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane -n crossplane-system --create-namespace

# Install AWS Provider
kubectl apply -f - <<EOF
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-rds
spec:
  package: xpkg.upbound.io/upbound/provider-aws-rds:v1.7.0
EOF
```

### Composite Resource Definition - Platform API for Databases

A `CompositeResourceDefinition` (XRD) is the platform team's equivalent of designing a public API: it defines the schema that developers see (`PostgreSQLInstance`) while hiding the complexity of the underlying AWS resources. The `claimNames` field creates a namespace-scoped variant of the resource so that each team can provision databases within their own namespace without cluster-admin rights. OpenAPI validation constraints. Such as `minimum: 20` on `storageGB` and an enum on `instanceClass`. Prevent developers from requesting configurations that violate cost or operational policies.

```yaml
# The platform team defines a "PostgreSQLInstance" abstraction
# that creates all required AWS resources
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.myorg.io
spec:
  group: platform.myorg.io
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  claimNames:
    kind: PostgreSQLInstance       # what teams use (namespaced)
    plural: postgresqlinstances
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  required: [storageGB, instanceClass]
                  properties:
                    storageGB:
                      type: integer
                      minimum: 20
                      maximum: 1000
                    instanceClass:
                      type: string
                      enum:
                        - db.t3.medium
                        - db.r7g.large
                        - db.r7g.xlarge
                    multiAZ:
                      type: boolean
                      default: false
                    engineVersion:
                      type: string
                      default: "16"
```

```yaml
# Developer claims a database (in their namespace)
apiVersion: platform.myorg.io/v1alpha1
kind: PostgreSQLInstance
metadata:
  name: my-service-db
  namespace: team-backend
spec:
  parameters:
    storageGB: 50
    instanceClass: db.t3.medium
    multiAZ: false
  compositionRef:
    name: postgresql-aws-us-east-1
  writeConnectionSecretToRef:
    name: my-service-db-credentials  # Crossplane writes DB credentials here
```

This creates: VPC security group, subnet group, parameter group, RDS instance, and a Kubernetes Secret with connection credentials - all automatically.

### Junior → FAANG: Why Crossplane Matters and What to Know for Interviews

Crossplane is frequently mentioned in platform engineering interviews because it represents a specific design philosophy: infrastructure as Kubernetes resources. The key idea is that a developer should never need to learn Terraform or AWS CloudFormation to get a database. They apply a YAML file in their namespace and a Secret appears with credentials. That is the developer experience goal.

For a junior engineer, the most important concept to understand is the distinction between the platform team and the developer in this model. The platform team defines the `CompositeResourceDefinition` (XRD), which is the API contract. The developer creates a `PostgreSQLInstance` claim, which is the consumer side. The developer never sees the underlying Composition (which maps the claim to AWS resources). This separation is why Crossplane enables self-service: the complexity is hidden in the Composition, not exposed to the developer.

The `claimNames` field in the XRD is significant because it creates a namespace-scoped resource. This means a developer with `edit` access to their namespace can create a `PostgreSQLInstance` without cluster-admin rights. The Crossplane controller handles the elevated permissions required to create AWS resources. This is the RBAC model that makes self-service safe: developers request resources, the platform's trusted controller fulfills them.

For interview prep: practice explaining the data flow from developer claim to provisioned resource in three steps. Developer applies YAML claim in namespace. Crossplane controller reads the claim and executes the Composition. AWS resources are created, and credentials appear as a Kubernetes Secret in the developer's namespace.

### Senior @ FAANG: Crossplane Compositions as a Platform Contract

At the senior level, a Crossplane XRD is an API contract in the same sense that a gRPC proto file is an API contract. It has a version, a schema, validation constraints, and consumers who depend on it. Breaking changes to the schema require a versioned migration, not an in-place update.

The senior-level concern with Crossplane compositions is operational blast radius. A misconfigured Composition that references the wrong AWS region, uses the wrong subnet group, or omits a required security group tag will silently create non-compliant infrastructure that may fail security audits. At FAANG scale, every Crossplane Composition must go through a CI pipeline that deploys it to a test environment and verifies the resulting AWS resources meet compliance requirements before the Composition is applied to production clusters. This is the equivalent of integration testing for infrastructure.

The `instanceClass` enum in the XRD is a governance boundary: developers cannot request instance classes outside the approved list. This prevents accidental cost overruns (a developer requesting `db.r7g.4xlarge` for a development database) and ensures that the platform team can negotiate reserved instance pricing for the approved set. The enum list is itself a policy decision that should be reviewed quarterly against actual usage patterns and cloud cost reports.

The `writeConnectionSecretToRef` field deserves attention from a security architecture perspective. The Secret is written to the developer's namespace, which means anyone with read access to that namespace can read the database credentials. At organizations with strict data classification requirements, the preferred pattern is to use External Secrets Operator rather than raw Crossplane secret writing: the database credential is stored in Vault or AWS Secrets Manager, and ESO writes a short-lived reference to the namespace. This removes long-lived credentials from Kubernetes etcd, which is a significant reduction in the blast radius of a cluster compromise.

At the staff level, the Crossplane versus Terraform decision is a recurring architecture review question. The concise answer: Crossplane fits when developers are the primary provisioners and the Kubernetes API is the natural interface. Terraform fits when the provisioner is the platform team and the artifact is a plan that can be reviewed before apply. Many mature platforms use both: Crossplane for developer-facing database and environment provisioning, Terraform for foundational infrastructure (VPCs, IAM roles, cluster configuration) that the platform team owns directly.
