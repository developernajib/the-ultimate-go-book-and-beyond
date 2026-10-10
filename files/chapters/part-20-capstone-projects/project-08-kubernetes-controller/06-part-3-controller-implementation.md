## Part 3: Controller Implementation

The controller is the brain of your operator. It contains the reconciliation logic that watches for changes to your custom resource and makes the actual cluster state match the desired state declared by the user. The core idea is simple: Kubernetes calls your `Reconcile` function whenever something changes, and your job is to compare what exists with what should exist, then create, update, or delete resources accordingly. This part implements the full reconciliation loop including ConfigMap generation, Secret management, StatefulSet creation, Service setup, backup scheduling, and status reporting.

### Controller Reconciliation Logic
The reconciler implements the core control loop: given desired state from the spec, it observes actual cluster state, computes the delta, and takes actions to converge them. Every reconcile call must be idempotent because Kubernetes may deliver the same event multiple times.

```go
// internal/controller/postgrescluster_controller.go
package controller

import (
    "context"
    "fmt"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    batchv1 "k8s.io/api/batch/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/resource"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/tools/record"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    databasev1alpha1 "github.com/example/postgres-operator/api/v1alpha1"
)

const (
    finalizerName = "database.example.com/finalizer"

    // Requeue intervals
    requeueAfterError    = 30 * time.Second
    requeueAfterNormal   = 5 * time.Minute
    requeueAfterCreating = 10 * time.Second
)

// PostgresClusterReconciler reconciles a PostgresCluster object
type PostgresClusterReconciler struct {
    client.Client
    Scheme   *runtime.Scheme
    Recorder record.EventRecorder
}

// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=database.example.com,resources=postgresclusters/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=statefulsets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=batch,resources=cronjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=core,resources=pods,verbs=get;list;watch

// Reconcile is the main reconciliation loop
func (r *PostgresClusterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Starting reconciliation", "namespace", req.Namespace, "name", req.Name)

    // Fetch the PostgresCluster instance
    pgCluster := &databasev1alpha1.PostgresCluster{}
    if err := r.Get(ctx, req.NamespacedName, pgCluster); err != nil {
        if errors.IsNotFound(err) {
            logger.Info("PostgresCluster resource not found, ignoring")
            return ctrl.Result{}, nil
        }
        logger.Error(err, "Failed to get PostgresCluster")
        return ctrl.Result{}, err
    }

    // Update observed generation
    pgCluster.Status.ObservedGeneration = pgCluster.Generation

    // Handle deletion
    if !pgCluster.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, pgCluster)
    }

    // Add finalizer if not present
    if !controllerutil.ContainsFinalizer(pgCluster, finalizerName) {
        controllerutil.AddFinalizer(pgCluster, finalizerName)
        if err := r.Update(ctx, pgCluster); err != nil {
            return ctrl.Result{}, err
        }
        return ctrl.Result{Requeue: true}, nil
    }

    // Set initial phase
    if pgCluster.Status.Phase == "" {
        pgCluster.Status.Phase = databasev1alpha1.ClusterPhasePending
        if err := r.Status().Update(ctx, pgCluster); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Reconcile ConfigMap
    if err := r.reconcileConfigMap(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to reconcile ConfigMap")
        r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "ConfigMapFailed", err.Error())
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeConfigMapReady,
            metav1.ConditionFalse,
            "ReconciliationFailed",
            err.Error(),
        )
        r.Status().Update(ctx, pgCluster)
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }
    pgCluster.Status.SetCondition(
        databasev1alpha1.ConditionTypeConfigMapReady,
        metav1.ConditionTrue,
        "ConfigMapReady",
        "ConfigMap created successfully",
    )

    // Reconcile Secret
    if err := r.reconcileSecret(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to reconcile Secret")
        r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "SecretFailed", err.Error())
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }

    // Reconcile Services
    if err := r.reconcileServices(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to reconcile Services")
        r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "ServiceFailed", err.Error())
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeServiceReady,
            metav1.ConditionFalse,
            "ReconciliationFailed",
            err.Error(),
        )
        r.Status().Update(ctx, pgCluster)
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }
    pgCluster.Status.SetCondition(
        databasev1alpha1.ConditionTypeServiceReady,
        metav1.ConditionTrue,
        "ServiceReady",
        "Services created successfully",
    )

    // Reconcile StatefulSet
    if err := r.reconcileStatefulSet(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to reconcile StatefulSet")
        r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "StatefulSetFailed", err.Error())
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeStatefulSetReady,
            metav1.ConditionFalse,
            "ReconciliationFailed",
            err.Error(),
        )
        r.Status().Update(ctx, pgCluster)
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }

    // Check StatefulSet status
    if err := r.updateStatefulSetStatus(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to update StatefulSet status")
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }

    // Reconcile backup CronJob if enabled
    if pgCluster.Spec.Backup != nil && pgCluster.Spec.Backup.Enabled {
        if err := r.reconcileBackupCronJob(ctx, pgCluster); err != nil {
            logger.Error(err, "Failed to reconcile backup CronJob")
            r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "BackupFailed", err.Error())
            pgCluster.Status.SetCondition(
                databasev1alpha1.ConditionTypeBackupConfigured,
                metav1.ConditionFalse,
                "ReconciliationFailed",
                err.Error(),
            )
            r.Status().Update(ctx, pgCluster)
            return ctrl.Result{RequeueAfter: requeueAfterError}, err
        }
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeBackupConfigured,
            metav1.ConditionTrue,
            "BackupConfigured",
            "Backup CronJob configured successfully",
        )
    }

    // Update overall Ready condition
    if pgCluster.Status.ReadyReplicas == pgCluster.Spec.Replicas {
        pgCluster.Status.Phase = databasev1alpha1.ClusterPhaseRunning
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeReady,
            metav1.ConditionTrue,
            "ClusterReady",
            fmt.Sprintf("All %d replicas are ready", pgCluster.Spec.Replicas),
        )
        r.Recorder.Event(pgCluster, corev1.EventTypeNormal, "ClusterReady", "Cluster is fully operational")
    } else {
        pgCluster.Status.Phase = databasev1alpha1.ClusterPhaseCreating
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeReady,
            metav1.ConditionFalse,
            "ClusterNotReady",
            fmt.Sprintf("Ready replicas: %d/%d", pgCluster.Status.ReadyReplicas, pgCluster.Spec.Replicas),
        )
    }

    // Update status
    if err := r.Status().Update(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to update status")
        return ctrl.Result{}, err
    }

    // Requeue based on phase
    if pgCluster.Status.Phase == databasev1alpha1.ClusterPhaseCreating {
        return ctrl.Result{RequeueAfter: requeueAfterCreating}, nil
    }

    logger.Info("Reconciliation complete", "phase", pgCluster.Status.Phase)
    return ctrl.Result{RequeueAfter: requeueAfterNormal}, nil
}

// handleDeletion handles the deletion of the PostgresCluster
func (r *PostgresClusterReconciler) handleDeletion(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) (ctrl.Result, error) {
    logger := log.FromContext(ctx)
    logger.Info("Handling deletion")

    if !controllerutil.ContainsFinalizer(pgCluster, finalizerName) {
        return ctrl.Result{}, nil
    }

    // Update phase
    pgCluster.Status.Phase = databasev1alpha1.ClusterPhaseDeleting
    r.Status().Update(ctx, pgCluster)

    // Perform cleanup (delete backups, notify external systems, etc.)
    if err := r.performCleanup(ctx, pgCluster); err != nil {
        logger.Error(err, "Failed to perform cleanup")
        r.Recorder.Event(pgCluster, corev1.EventTypeWarning, "CleanupFailed", err.Error())
        return ctrl.Result{RequeueAfter: requeueAfterError}, err
    }

    // Remove finalizer
    controllerutil.RemoveFinalizer(pgCluster, finalizerName)
    if err := r.Update(ctx, pgCluster); err != nil {
        return ctrl.Result{}, err
    }

    r.Recorder.Event(pgCluster, corev1.EventTypeNormal, "Deleted", "PostgresCluster deleted successfully")
    logger.Info("Deletion complete")
    return ctrl.Result{}, nil
}

// performCleanup performs cleanup tasks before deletion
func (r *PostgresClusterReconciler) performCleanup(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    logger := log.FromContext(ctx)
    logger.Info("Performing cleanup")

    // Here you would:
    // - Delete backups from S3
    // - Notify monitoring systems
    // - Deregister from service mesh
    // - Clean up external resources

    return nil
}

// reconcileConfigMap creates or updates the ConfigMap for PostgreSQL configuration
func (r *PostgresClusterReconciler) reconcileConfigMap(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    configMap := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name + "-config",
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, configMap, func() error {
        // Set owner reference
        if err := controllerutil.SetControllerReference(pgCluster, configMap, r.Scheme); err != nil {
            return err
        }

        // Build postgresql.conf content
        postgresConf := r.buildPostgresConfig(pgCluster)

        configMap.Data = map[string]string{
            "postgresql.conf": postgresConf,
            "pg_hba.conf":     r.buildPgHbaConfig(pgCluster),
        }

        return nil
    })

    return err
}

// buildPostgresConfig builds the postgresql.conf content
func (r *PostgresClusterReconciler) buildPostgresConfig(pgCluster *databasev1alpha1.PostgresCluster) string {
    config := `
# PostgreSQL Configuration
# Auto-generated by postgres-operator

# Connection Settings
listen_addresses = '*'
port = 5432
max_connections = 100

# Memory Settings
shared_buffers = 256MB
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 64MB

# WAL Settings
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
wal_keep_size = 1GB

# Logging
log_destination = 'stderr'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_statement = 'all'
log_line_prefix = '%m [%p] %u@%d '

# Replication
hot_standby = on
`

    // Add custom parameters
    for key, value := range pgCluster.Spec.Parameters {
        config += fmt.Sprintf("%s = %s\n", key, value)
    }

    return config
}

// buildPgHbaConfig builds the pg_hba.conf content
func (r *PostgresClusterReconciler) buildPgHbaConfig(pgCluster *databasev1alpha1.PostgresCluster) string {
    return `
# PostgreSQL Client Authentication Configuration
# Auto-generated by postgres-operator

# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections
local   all             all                                     trust

# IPv4 connections
host    all             all             0.0.0.0/0               md5

# Replication connections
host    replication     all             0.0.0.0/0               md5
`
}

// reconcileSecret creates or updates the Secret for PostgreSQL credentials
func (r *PostgresClusterReconciler) reconcileSecret(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    secret := &corev1.Secret{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name + "-credentials",
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, secret, func() error {
        // Set owner reference
        if err := controllerutil.SetControllerReference(pgCluster, secret, r.Scheme); err != nil {
            return err
        }

        // Only set password if it doesn't exist (don't overwrite)
        if secret.Data == nil {
            secret.Data = make(map[string][]byte)
        }

        if _, exists := secret.Data["password"]; !exists {
            // Generate random password (in production, use a proper password generator)
            password := generateRandomPassword(32)
            secret.Data["password"] = []byte(password)
            secret.Data["username"] = []byte("postgres")
        }

        return nil
    })

    return err
}

// generateRandomPassword generates a random password
func generateRandomPassword(length int) string {
    // In production, use crypto/rand
    return "changeme-" + time.Now().Format("20060102150405")
}

// reconcileServices creates or updates the Services
func (r *PostgresClusterReconciler) reconcileServices(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    // Headless service for StatefulSet
    if err := r.reconcileHeadlessService(ctx, pgCluster); err != nil {
        return err
    }

    // Read-write service (points to primary)
    if err := r.reconcileReadWriteService(ctx, pgCluster); err != nil {
        return err
    }

    // Read-only service (points to all replicas)
    if err := r.reconcileReadOnlyService(ctx, pgCluster); err != nil {
        return err
    }

    return nil
}

// reconcileHeadlessService creates the headless service
func (r *PostgresClusterReconciler) reconcileHeadlessService(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    service := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name + "-headless",
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
        if err := controllerutil.SetControllerReference(pgCluster, service, r.Scheme); err != nil {
            return err
        }

        service.Spec = corev1.ServiceSpec{
            ClusterIP: "None",
            Selector: map[string]string{
                "app":     "postgres",
                "cluster": pgCluster.Name,
            },
            Ports: []corev1.ServicePort{
                {
                    Name:     "postgres",
                    Port:     5432,
                    Protocol: corev1.ProtocolTCP,
                },
            },
        }

        return nil
    })

    return err
}

// reconcileReadWriteService creates the read-write service
func (r *PostgresClusterReconciler) reconcileReadWriteService(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    service := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name,
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
        if err := controllerutil.SetControllerReference(pgCluster, service, r.Scheme); err != nil {
            return err
        }

        service.Spec = corev1.ServiceSpec{
            Type: corev1.ServiceTypeClusterIP,
            Selector: map[string]string{
                "app":     "postgres",
                "cluster": pgCluster.Name,
                "role":    "primary",
            },
            Ports: []corev1.ServicePort{
                {
                    Name:     "postgres",
                    Port:     5432,
                    Protocol: corev1.ProtocolTCP,
                },
            },
        }

        return nil
    })

    return err
}

// reconcileReadOnlyService creates the read-only service
func (r *PostgresClusterReconciler) reconcileReadOnlyService(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    if pgCluster.Spec.Replicas <= 1 {
        return nil // No need for read-only service with single replica
    }

    service := &corev1.Service{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name + "-readonly",
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
        if err := controllerutil.SetControllerReference(pgCluster, service, r.Scheme); err != nil {
            return err
        }

        service.Spec = corev1.ServiceSpec{
            Type: corev1.ServiceTypeClusterIP,
            Selector: map[string]string{
                "app":     "postgres",
                "cluster": pgCluster.Name,
                "role":    "replica",
            },
            Ports: []corev1.ServicePort{
                {
                    Name:     "postgres",
                    Port:     5432,
                    Protocol: corev1.ProtocolTCP,
                },
            },
        }

        return nil
    })

    return err
}

// reconcileStatefulSet creates or updates the StatefulSet
func (r *PostgresClusterReconciler) reconcileStatefulSet(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    statefulSet := &appsv1.StatefulSet{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name,
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, statefulSet, func() error {
        if err := controllerutil.SetControllerReference(pgCluster, statefulSet, r.Scheme); err != nil {
            return err
        }

        // Build pod template
        podTemplate := r.buildPodTemplate(pgCluster)

        statefulSet.Spec = appsv1.StatefulSetSpec{
            Replicas:    &pgCluster.Spec.Replicas,
            ServiceName: pgCluster.Name + "-headless",
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{
                    "app":     "postgres",
                    "cluster": pgCluster.Name,
                },
            },
            Template: podTemplate,
            VolumeClaimTemplates: []corev1.PersistentVolumeClaim{
                {
                    ObjectMeta: metav1.ObjectMeta{
                        Name: "data",
                    },
                    Spec: corev1.PersistentVolumeClaimSpec{
                        AccessModes: []corev1.PersistentVolumeAccessMode{
                            pgCluster.Spec.Storage.AccessMode,
                        },
                        Resources: corev1.VolumeResourceRequirements{
                            Requests: corev1.ResourceList{
                                corev1.ResourceStorage: resource.MustParse(pgCluster.Spec.Storage.Size),
                            },
                        },
                        StorageClassName: pgCluster.Spec.Storage.StorageClassName,
                    },
                },
            },
            PodManagementPolicy: appsv1.OrderedReadyPodManagement,
            UpdateStrategy: appsv1.StatefulSetUpdateStrategy{
                Type: appsv1.RollingUpdateStatefulSetStrategyType,
            },
        }

        return nil
    })

    return err
}

// buildPodTemplate builds the pod template for the StatefulSet
func (r *PostgresClusterReconciler) buildPodTemplate(pgCluster *databasev1alpha1.PostgresCluster) corev1.PodTemplateSpec {
    labels := map[string]string{
        "app":     "postgres",
        "cluster": pgCluster.Name,
        "version": pgCluster.Spec.Version,
    }

    // Determine image
    image := pgCluster.Spec.Image
    if image == "" {
        image = fmt.Sprintf("postgres:%s", pgCluster.Spec.Version)
    }

    // Build containers
    containers := []corev1.Container{
        {
            Name:  "postgres",
            Image: image,
            Ports: []corev1.ContainerPort{
                {
                    Name:          "postgres",
                    ContainerPort: 5432,
                    Protocol:      corev1.ProtocolTCP,
                },
            },
            Env: []corev1.EnvVar{
                {
                    Name: "POSTGRES_PASSWORD",
                    ValueFrom: &corev1.EnvVarSource{
                        SecretKeyRef: &corev1.SecretKeySelector{
                            LocalObjectReference: corev1.LocalObjectReference{
                                Name: pgCluster.Name + "-credentials",
                            },
                            Key: "password",
                        },
                    },
                },
                {
                    Name:  "PGDATA",
                    Value: "/var/lib/postgresql/data/pgdata",
                },
                {
                    Name: "POD_NAME",
                    ValueFrom: &corev1.EnvVarSource{
                        FieldRef: &corev1.ObjectFieldSelector{
                            FieldPath: "metadata.name",
                        },
                    },
                },
            },
            VolumeMounts: []corev1.VolumeMount{
                {
                    Name:      "data",
                    MountPath: "/var/lib/postgresql/data",
                },
                {
                    Name:      "config",
                    MountPath: "/etc/postgresql",
                },
            },
            Resources: pgCluster.Spec.Resources,
            LivenessProbe: &corev1.Probe{
                ProbeHandler: corev1.ProbeHandler{
                    Exec: &corev1.ExecAction{
                        Command: []string{
                            "pg_isready",
                            "-U", "postgres",
                        },
                    },
                },
                InitialDelaySeconds: 30,
                PeriodSeconds:       10,
                TimeoutSeconds:      5,
                FailureThreshold:    3,
            },
            ReadinessProbe: &corev1.Probe{
                ProbeHandler: corev1.ProbeHandler{
                    Exec: &corev1.ExecAction{
                        Command: []string{
                            "pg_isready",
                            "-U", "postgres",
                        },
                    },
                },
                InitialDelaySeconds: 10,
                PeriodSeconds:       5,
                TimeoutSeconds:      3,
                FailureThreshold:    3,
            },
        },
    }

    // Add Prometheus exporter sidecar if monitoring is enabled
    if pgCluster.Spec.Monitoring != nil && pgCluster.Spec.Monitoring.Enabled {
        containers = append(containers, r.buildPrometheusExporterContainer(pgCluster))
    }

    return corev1.PodTemplateSpec{
        ObjectMeta: metav1.ObjectMeta{
            Labels: labels,
        },
        Spec: corev1.PodSpec{
            Containers: containers,
            Volumes: []corev1.Volume{
                {
                    Name: "config",
                    VolumeSource: corev1.VolumeSource{
                        ConfigMap: &corev1.ConfigMapVolumeSource{
                            LocalObjectReference: corev1.LocalObjectReference{
                                Name: pgCluster.Name + "-config",
                            },
                        },
                    },
                },
            },
            SecurityContext: &corev1.PodSecurityContext{
                FSGroup: ptr(int64(999)), // postgres user
            },
        },
    }
}

// buildPrometheusExporterContainer builds the Prometheus exporter sidecar
func (r *PostgresClusterReconciler) buildPrometheusExporterContainer(pgCluster *databasev1alpha1.PostgresCluster) corev1.Container {
    image := "quay.io/prometheuscommunity/postgres-exporter:latest"
    if pgCluster.Spec.Monitoring.PrometheusExporter != nil && pgCluster.Spec.Monitoring.PrometheusExporter.Image != "" {
        image = pgCluster.Spec.Monitoring.PrometheusExporter.Image
    }

    resources := corev1.ResourceRequirements{}
    if pgCluster.Spec.Monitoring.PrometheusExporter != nil {
        resources = pgCluster.Spec.Monitoring.PrometheusExporter.Resources
    }

    return corev1.Container{
        Name:  "prometheus-exporter",
        Image: image,
        Ports: []corev1.ContainerPort{
            {
                Name:          "metrics",
                ContainerPort: 9187,
                Protocol:      corev1.ProtocolTCP,
            },
        },
        Env: []corev1.EnvVar{
            {
                Name:  "DATA_SOURCE_NAME",
                Value: "postgresql://postgres:$(POSTGRES_PASSWORD)@localhost:5432/postgres?sslmode=disable",
            },
            {
                Name: "POSTGRES_PASSWORD",
                ValueFrom: &corev1.EnvVarSource{
                    SecretKeyRef: &corev1.SecretKeySelector{
                        LocalObjectReference: corev1.LocalObjectReference{
                            Name: pgCluster.Name + "-credentials",
                        },
                        Key: "password",
                    },
                },
            },
        },
        Resources: resources,
    }
}

// reconcileBackupCronJob creates or updates the backup CronJob
func (r *PostgresClusterReconciler) reconcileBackupCronJob(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    cronJob := &batchv1.CronJob{
        ObjectMeta: metav1.ObjectMeta{
            Name:      pgCluster.Name + "-backup",
            Namespace: pgCluster.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, cronJob, func() error {
        if err := controllerutil.SetControllerReference(pgCluster, cronJob, r.Scheme); err != nil {
            return err
        }

        cronJob.Spec = batchv1.CronJobSpec{
            Schedule: pgCluster.Spec.Backup.Schedule,
            JobTemplate: batchv1.JobTemplateSpec{
                Spec: batchv1.JobSpec{
                    Template: corev1.PodTemplateSpec{
                        Spec: corev1.PodSpec{
                            RestartPolicy: corev1.RestartPolicyOnFailure,
                            Containers: []corev1.Container{
                                {
                                    Name:  "backup",
                                    Image: "postgres:" + pgCluster.Spec.Version,
                                    Command: []string{
                                        "/bin/bash",
                                        "-c",
                                        r.buildBackupScript(pgCluster),
                                    },
                                    Env: r.buildBackupEnv(pgCluster),
                                },
                            },
                        },
                    },
                },
            },
            SuccessfulJobsHistoryLimit: ptr(int32(3)),
            FailedJobsHistoryLimit:      ptr(int32(1)),
        }

        return nil
    })

    return err
}

// buildBackupScript builds the backup script
func (r *PostgresClusterReconciler) buildBackupScript(pgCluster *databasev1alpha1.PostgresCluster) string {
    return `
set -e
BACKUP_FILE="/tmp/backup-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dumpall -h ${POSTGRES_HOST} -U postgres | gzip > ${BACKUP_FILE}
aws s3 cp ${BACKUP_FILE} s3://${S3_BUCKET}/backups/
echo "Backup completed: ${BACKUP_FILE}"
`
}

// buildBackupEnv builds environment variables for backup
func (r *PostgresClusterReconciler) buildBackupEnv(pgCluster *databasev1alpha1.PostgresCluster) []corev1.EnvVar {
    env := []corev1.EnvVar{
        {
            Name:  "POSTGRES_HOST",
            Value: pgCluster.Name,
        },
        {
            Name: "PGPASSWORD",
            ValueFrom: &corev1.EnvVarSource{
                SecretKeyRef: &corev1.SecretKeySelector{
                    LocalObjectReference: corev1.LocalObjectReference{
                        Name: pgCluster.Name + "-credentials",
                    },
                    Key: "password",
                },
            },
        },
    }

    if pgCluster.Spec.Backup.S3 != nil {
        env = append(env,
            corev1.EnvVar{
                Name:  "S3_BUCKET",
                Value: pgCluster.Spec.Backup.S3.Bucket,
            },
            corev1.EnvVar{
                Name:  "AWS_REGION",
                Value: pgCluster.Spec.Backup.S3.Region,
            },
        )
    }

    return env
}

// updateStatefulSetStatus updates the status based on StatefulSet state
func (r *PostgresClusterReconciler) updateStatefulSetStatus(ctx context.Context, pgCluster *databasev1alpha1.PostgresCluster) error {
    statefulSet := &appsv1.StatefulSet{}
    if err := r.Get(ctx, types.NamespacedName{
        Name:      pgCluster.Name,
        Namespace: pgCluster.Namespace,
    }, statefulSet); err != nil {
        return err
    }

    pgCluster.Status.Replicas = statefulSet.Status.Replicas
    pgCluster.Status.ReadyReplicas = statefulSet.Status.ReadyReplicas

    // Update StatefulSet condition
    if statefulSet.Status.ReadyReplicas == pgCluster.Spec.Replicas {
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeStatefulSetReady,
            metav1.ConditionTrue,
            "StatefulSetReady",
            "All replicas are ready",
        )
    } else {
        pgCluster.Status.SetCondition(
            databasev1alpha1.ConditionTypeStatefulSetReady,
            metav1.ConditionFalse,
            "StatefulSetNotReady",
            fmt.Sprintf("Ready replicas: %d/%d", statefulSet.Status.ReadyReplicas, pgCluster.Spec.Replicas),
        )
    }

    // Identify primary and replicas (simplified - in production, query PostgreSQL)
    if pgCluster.Status.Replicas > 0 {
        pgCluster.Status.PrimaryInstance = fmt.Sprintf("%s-0", pgCluster.Name)
        pgCluster.Status.ReplicaInstances = []string{}
        for i := int32(1); i < pgCluster.Status.Replicas; i++ {
            pgCluster.Status.ReplicaInstances = append(
                pgCluster.Status.ReplicaInstances,
                fmt.Sprintf("%s-%d", pgCluster.Name, i),
            )
        }
    }

    return nil
}

// SetupWithManager sets up the controller with the Manager
func (r *PostgresClusterReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).
        For(&databasev1alpha1.PostgresCluster{}).
        Owns(&appsv1.StatefulSet{}).
        Owns(&corev1.Service{}).
        Owns(&corev1.ConfigMap{}).
        Owns(&corev1.Secret{}).
        Owns(&batchv1.CronJob{}).
        Complete(r)
}

// Helper function to return pointer to value
func ptr[T any](v T) *T {
    return &v
}
```
