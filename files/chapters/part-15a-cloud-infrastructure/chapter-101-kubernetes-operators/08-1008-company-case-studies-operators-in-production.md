## 101.8 Company Case Studies: Operators in Production

### Google: GKE Config Connector

Google's Config Connector lets you manage GCP resources as Kubernetes objects:

```yaml
# Google-style: Managing GCP resources via K8s
apiVersion: sql.cnrm.cloud.google.com/v1beta1
kind: SQLInstance
metadata:
  name: production-db
  annotations:
    cnrm.cloud.google.com/project-id: my-project
spec:
  databaseVersion: POSTGRES_15
  region: us-central1
  settings:
    tier: db-custom-4-15360
    availabilityType: REGIONAL
    backupConfiguration:
      enabled: true
      startTime: "03:00"
    ipConfiguration:
      privateNetworkRef:
        name: production-vpc
---
# Go operator that watches SQLInstance CRs
package controllers

import (
    "context"

    sqlv1beta1 "github.com/GoogleCloudPlatform/k8s-config-connector/pkg/apis/sql/v1beta1"
    ctrl "sigs.k8s.io/controller-runtime"
)

type DatabaseBackupReconciler struct {
    client.Client
}

func (r *DatabaseBackupReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var sqlInstance sqlv1beta1.SQLInstance
    if err := r.Get(ctx, req.NamespacedName, &sqlInstance); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Ensure backup is configured
    if !sqlInstance.Spec.Settings.BackupConfiguration.Enabled {
        sqlInstance.Spec.Settings.BackupConfiguration.Enabled = true
        sqlInstance.Spec.Settings.BackupConfiguration.StartTime = "03:00"
        if err := r.Update(ctx, &sqlInstance); err != nil {
            return ctrl.Result{}, err
        }
    }

    return ctrl.Result{RequeueAfter: time.Hour}, nil
}
```

### Uber: Custom Service Mesh Operator

Uber built custom operators for their service mesh:

```go
// Uber-style service mesh operator
package controllers

import (
    "context"
    "fmt"

    meshv1 "github.com/uber/mesh-operator/api/v1"
    appsv1 "k8s.io/api/apps/v1"
    corev1 "k8s.io/api/core/v1"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type MeshServiceReconciler struct {
    client.Client
    Scheme *runtime.Scheme
}

// MeshService CRD
type MeshServiceSpec struct {
    // Service configuration
    Replicas     int32             `json:"replicas"`
    Image        string            `json:"image"`
    Port         int32             `json:"port"`

    // Mesh configuration
    Mesh         MeshConfig        `json:"mesh"`
    CircuitBreaker CircuitBreakerConfig `json:"circuitBreaker"`
    Retry        RetryConfig       `json:"retry"`
}

type MeshConfig struct {
    InjectSidecar bool     `json:"injectSidecar"`
    MTLSMode      string   `json:"mtlsMode"` // STRICT, PERMISSIVE
    Upstream      []string `json:"upstream"` // Allowed upstream services
}

func (r *MeshServiceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    var meshService meshv1.MeshService
    if err := r.Get(ctx, req.NamespacedName, &meshService); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Create deployment with sidecar
    deployment := r.deploymentForMeshService(&meshService)

    // Inject envoy sidecar if enabled
    if meshService.Spec.Mesh.InjectSidecar {
        r.injectEnvoySidecar(deployment, &meshService)
    }

    // Create or update deployment
    if err := r.createOrUpdate(ctx, deployment); err != nil {
        return ctrl.Result{}, err
    }

    // Create circuit breaker config
    if err := r.reconcileCircuitBreaker(ctx, &meshService); err != nil {
        return ctrl.Result{}, err
    }

    // Create retry policy
    if err := r.reconcileRetryPolicy(ctx, &meshService); err != nil {
        return ctrl.Result{}, err
    }

    logger.Info("Successfully reconciled MeshService")
    return ctrl.Result{}, nil
}

func (r *MeshServiceReconciler) injectEnvoySidecar(deployment *appsv1.Deployment, ms *meshv1.MeshService) {
    sidecar := corev1.Container{
        Name:  "envoy",
        Image: "envoyproxy/envoy:v1.28.0",
        Ports: []corev1.ContainerPort{
            {ContainerPort: 15001, Name: "envoy-admin"},
            {ContainerPort: 15006, Name: "envoy-inbound"},
        },
        Env: []corev1.EnvVar{
            {Name: "MESH_SERVICE", Value: ms.Name},
            {Name: "MTLS_MODE", Value: ms.Spec.Mesh.MTLSMode},
        },
        Resources: corev1.ResourceRequirements{
            Requests: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("50m"),
                corev1.ResourceMemory: resource.MustParse("64Mi"),
            },
            Limits: corev1.ResourceList{
                corev1.ResourceCPU:    resource.MustParse("200m"),
                corev1.ResourceMemory: resource.MustParse("256Mi"),
            },
        },
    }
    deployment.Spec.Template.Spec.Containers = append(
        deployment.Spec.Template.Spec.Containers, sidecar)
}
```

### Netflix: Titus Operator

Netflix's Titus container platform includes custom operators:

```go
// Netflix-style job orchestration operator
package controllers

type TitusJobSpec struct {
    // Container configuration
    Image       string            `json:"image"`
    Entrypoint  []string          `json:"entrypoint"`
    Env         map[string]string `json:"env"`

    // Capacity
    CPU         resource.Quantity `json:"cpu"`
    Memory      resource.Quantity `json:"memory"`
    GPU         int               `json:"gpu,omitempty"`
    NetworkMbps int               `json:"networkMbps"`

    // Placement
    Capacity    CapacityConfig    `json:"capacity"`
    Constraints []Constraint      `json:"constraints"`

    // Chaos testing
    ChaosTesting ChaosTesting     `json:"chaosTesting,omitempty"`
}

type ChaosTesting struct {
    Enabled         bool   `json:"enabled"`
    KillProbability float64 `json:"killProbability"`
    LatencyInjection LatencyInjection `json:"latencyInjection,omitempty"`
}

type TitusJobReconciler struct {
    client.Client
}

func (r *TitusJobReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var job titusv1.TitusJob
    if err := r.Get(ctx, req.NamespacedName, &job); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Validate job placement
    if err := r.validatePlacement(ctx, &job); err != nil {
        r.updateStatus(ctx, &job, titusv1.JobPhaseFailed, err.Error())
        return ctrl.Result{}, nil
    }

    // Create pods with Netflix-specific annotations
    pods := r.createPodsForJob(&job)
    for _, pod := range pods {
        // Add chaos testing annotations if enabled
        if job.Spec.ChaosTesting.Enabled {
            pod.Annotations["chaos.netflix.com/enabled"] = "true"
            pod.Annotations["chaos.netflix.com/kill-probability"] =
                fmt.Sprintf("%f", job.Spec.ChaosTesting.KillProbability)
        }

        if err := r.Create(ctx, pod); err != nil && !errors.IsAlreadyExists(err) {
            return ctrl.Result{}, err
        }
    }

    // Update status
    r.updateStatus(ctx, &job, titusv1.JobPhaseRunning, "")
    return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}
```

### Stripe: Database Operator

Stripe's database operator manages database schemas and migrations:

```go
// Stripe-style database schema operator
package controllers

type DatabaseSchemaSpec struct {
    // Database connection
    DatabaseRef    DatabaseReference `json:"databaseRef"`

    // Schema management
    Migrations     []Migration       `json:"migrations"`
    ValidationMode string            `json:"validationMode"` // strict, permissive

    // Safety settings
    RequireApproval bool             `json:"requireApproval"`
    BackupBefore    bool             `json:"backupBefore"`
    RollbackOnError bool             `json:"rollbackOnError"`
}

type Migration struct {
    Version     string `json:"version"`
    Description string `json:"description"`
    SQL         string `json:"sql"`
    RollbackSQL string `json:"rollbackSQL,omitempty"`
}

type DatabaseSchemaReconciler struct {
    client.Client
    DBConnector DatabaseConnector
}

func (r *DatabaseSchemaReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var schema dbv1.DatabaseSchema
    if err := r.Get(ctx, req.NamespacedName, &schema); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Check if approval is required
    if schema.Spec.RequireApproval && !r.isApproved(&schema) {
        log.Info("Waiting for approval", "schema", schema.Name)
        r.updateStatus(ctx, &schema, "PendingApproval")
        return ctrl.Result{}, nil
    }

    // Get database connection
    db, err := r.DBConnector.Connect(ctx, schema.Spec.DatabaseRef)
    if err != nil {
        return ctrl.Result{}, err
    }
    defer db.Close()

    // Create backup if required
    if schema.Spec.BackupBefore {
        if err := r.createBackup(ctx, db, &schema); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Run migrations in transaction
    pendingMigrations := r.getPendingMigrations(ctx, db, &schema)
    for _, migration := range pendingMigrations {
        tx, err := db.BeginTx(ctx, nil)
        if err != nil {
            return ctrl.Result{}, err
        }

        if _, err := tx.ExecContext(ctx, migration.SQL); err != nil {
            tx.Rollback()

            if schema.Spec.RollbackOnError && migration.RollbackSQL != "" {
                r.runRollback(ctx, db, migration)
            }

            r.updateStatus(ctx, &schema, "Failed")
            return ctrl.Result{}, err
        }

        // Record migration
        r.recordMigration(ctx, tx, migration)
        tx.Commit()

        log.Info("Applied migration", "version", migration.Version)
    }

    r.updateStatus(ctx, &schema, "Synced")
    return ctrl.Result{}, nil
}
```

### Amazon: ACK Controllers

AWS Controllers for Kubernetes (ACK) pattern:

```go
// AWS-style controller for managing AWS resources
package controllers

type S3BucketSpec struct {
    Name                string            `json:"name"`
    Region              string            `json:"region"`
    Versioning          bool              `json:"versioning"`
    Encryption          EncryptionConfig  `json:"encryption"`
    LifecycleRules      []LifecycleRule   `json:"lifecycleRules,omitempty"`
    ReplicationConfig   *ReplicationConfig `json:"replicationConfig,omitempty"`
}

type S3BucketReconciler struct {
    client.Client
    S3Client *s3.Client
}

func (r *S3BucketReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var bucket ackv1.S3Bucket
    if err := r.Get(ctx, req.NamespacedName, &bucket); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Handle deletion
    if !bucket.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, &bucket)
    }

    // Add finalizer
    if !controllerutil.ContainsFinalizer(&bucket, s3Finalizer) {
        controllerutil.AddFinalizer(&bucket, s3Finalizer)
        if err := r.Update(ctx, &bucket); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Check if bucket exists
    exists, err := r.bucketExists(ctx, bucket.Spec.Name)
    if err != nil {
        return ctrl.Result{}, err
    }

    if !exists {
        // Create bucket
        if err := r.createBucket(ctx, &bucket); err != nil {
            r.updateStatus(ctx, &bucket, "Failed", err.Error())
            return ctrl.Result{}, err
        }
    }

    // Sync configuration
    if err := r.syncBucketConfig(ctx, &bucket); err != nil {
        return ctrl.Result{}, err
    }

    r.updateStatus(ctx, &bucket, "Synced", "")
    return ctrl.Result{RequeueAfter: 5 * time.Minute}, nil
}

func (r *S3BucketReconciler) handleDeletion(ctx context.Context, bucket *ackv1.S3Bucket) (ctrl.Result, error) {
    if controllerutil.ContainsFinalizer(bucket, s3Finalizer) {
        // Delete bucket from AWS
        if err := r.deleteBucket(ctx, bucket.Spec.Name); err != nil {
            return ctrl.Result{}, err
        }

        controllerutil.RemoveFinalizer(bucket, s3Finalizer)
        if err := r.Update(ctx, bucket); err != nil {
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, nil
}
```

**Operator Patterns by Company**:

| Company | Operator Focus | Key Pattern |
|---------|---------------|-------------|
| Google | Cloud Resources | Config Connector, GCP integration |
| Uber | Service Mesh | Sidecar injection, traffic management |
| Netflix | Job Orchestration | Chaos testing, capacity management |
| Stripe | Database Schema | Safe migrations, approval workflows |
| Amazon | AWS Resources | ACK, resource lifecycle management |

---

### Junior → FAANG: Operator Case Studies as Pattern Libraries

The production operator examples (Config Connector, Crossplane, cert-manager, Prometheus Operator) are excellent references for learning operator design patterns. Each one solves a specific problem well, and studying their CRD designs, reconcile logic, and status condition patterns reveals practical patterns that generalize beyond their specific use case.

cert-manager is particularly instructive: it manages Certificate resources that map to TLS certificates from various issuers (Let's Encrypt, Vault, self-signed). Its CRD design (Certificate, CertificateRequest, Issuer, ClusterIssuer) shows how to decompose a complex problem into multiple cooperating CRDs with clear responsibility boundaries. Its renewal logic (renewing certificates before they expire) demonstrates the requeue-after pattern for time-based reconciliation.

For first-job engineers, the most productive operator learning path is: use cert-manager, understand its CRDs by running `kubectl explain certificate.spec`, read its controller logic in the open source repository, then build a simple operator that follows the same structural patterns.

### Senior @ FAANG: Building and Operating Operators at Organizational Scale

At staff level, the case studies reveal the organizational patterns that make operators sustainable in production. GKE Config Connector and AWS ACK represent Google and Amazon's investment in making cloud resources Kubernetes-native, which simplifies the GitOps workflow for infrastructure provisioning. The organizational value is that infrastructure and application configuration use the same toolchain, the same access control model, and the same change management process.

For teams building internal operators, the lesson from production operators is that longevity requires investment in: comprehensive test suites (the Prometheus Operator has extensive e2e tests), clear API versioning (cert-manager has maintained API compatibility across major versions through careful deprecation), operator lifecycle management (the Operator Lifecycle Manager framework handles operator upgrades, dependency management, and multi-tenancy), and a clear owner who is responsible for maintenance as Kubernetes evolves.

The staff engineer's contribution when proposing to adopt or build an operator: a make-versus-buy analysis (is there an existing operator that solves this problem?), a maintenance commitment assessment (who will maintain this when the current team changes?), and an adoption plan (how will teams migrate from their current approach to the operator-managed approach?). Without these, operators become abandoned infrastructure debt.
