## 101.12 Exercises with Complete Solutions

### Exercise 1: Build a CronJob Manager Operator

**Scenario**: Build an operator that manages enhanced CronJobs with additional features like concurrency limits, failure alerts, and execution history.

**Complete Solution**:

```go
// api/v1alpha1/managedcronjob_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ManagedCronJobSpec defines the desired state
type ManagedCronJobSpec struct {
    // Schedule in Cron format
    Schedule string `json:"schedule"`

    // Container image to run
    Image string `json:"image"`

    // Command to execute
    Command []string `json:"command,omitempty"`

    // ConcurrencyPolicy: Allow, Forbid, Replace
    ConcurrencyPolicy string `json:"concurrencyPolicy,omitempty"`

    // MaxConcurrent jobs allowed
    MaxConcurrent int32 `json:"maxConcurrent,omitempty"`

    // FailureThreshold before alerting
    FailureThreshold int32 `json:"failureThreshold,omitempty"`

    // HistoryLimit of completed jobs to keep
    HistoryLimit int32 `json:"historyLimit,omitempty"`

    // Suspend execution
    Suspend bool `json:"suspend,omitempty"`
}

// ManagedCronJobStatus defines the observed state
type ManagedCronJobStatus struct {
    // LastScheduleTime is when the job was last scheduled
    LastScheduleTime *metav1.Time `json:"lastScheduleTime,omitempty"`

    // LastSuccessfulTime is when the job last succeeded
    LastSuccessfulTime *metav1.Time `json:"lastSuccessfulTime,omitempty"`

    // ActiveJobs is the count of currently running jobs
    ActiveJobs int32 `json:"activeJobs,omitempty"`

    // ConsecutiveFailures is the count of recent failures
    ConsecutiveFailures int32 `json:"consecutiveFailures,omitempty"`

    // ExecutionHistory of recent job runs
    ExecutionHistory []JobExecution `json:"executionHistory,omitempty"`

    // Conditions represent the latest available observations
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

type JobExecution struct {
    JobName   string      `json:"jobName"`
    StartTime metav1.Time `json:"startTime"`
    EndTime   *metav1.Time `json:"endTime,omitempty"`
    Status    string      `json:"status"` // Running, Succeeded, Failed
    Message   string      `json:"message,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Schedule",type="string",JSONPath=".spec.schedule"
// +kubebuilder:printcolumn:name="Active",type="integer",JSONPath=".status.activeJobs"
// +kubebuilder:printcolumn:name="Last Schedule",type="date",JSONPath=".status.lastScheduleTime"
type ManagedCronJob struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   ManagedCronJobSpec   `json:"spec,omitempty"`
    Status ManagedCronJobStatus `json:"status,omitempty"`
}
```

```go
// controllers/managedcronjob_controller.go
package controllers

import (
    "context"
    "fmt"
    "sort"
    "time"

    batchv1 "k8s.io/api/batch/v1"
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    cronv1alpha1 "github.com/example/cronjob-operator/api/v1alpha1"
    "github.com/robfig/cron/v3"
)

const (
    finalizerName = "cronjob.example.com/finalizer"
)

type ManagedCronJobReconciler struct {
    client.Client
    Scheme *runtime.Scheme
    Clock  // Testable time source
}

type Clock interface {
    Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (r *ManagedCronJobReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    // Fetch the ManagedCronJob
    var mcj cronv1alpha1.ManagedCronJob
    if err := r.Get(ctx, req.NamespacedName, &mcj); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Handle deletion
    if !mcj.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, &mcj)
    }

    // Add finalizer if not present
    if !controllerutil.ContainsFinalizer(&mcj, finalizerName) {
        controllerutil.AddFinalizer(&mcj, finalizerName)
        if err := r.Update(ctx, &mcj); err != nil {
            return ctrl.Result{}, err
        }
    }

    // If suspended, do nothing
    if mcj.Spec.Suspend {
        logger.Info("CronJob is suspended", "name", mcj.Name)
        return ctrl.Result{}, nil
    }

    // List child Jobs
    var childJobs batchv1.JobList
    if err := r.List(ctx, &childJobs, client.InNamespace(mcj.Namespace),
        client.MatchingLabels{"managed-cronjob": mcj.Name}); err != nil {
        return ctrl.Result{}, err
    }

    // Categorize jobs
    activeJobs, successfulJobs, failedJobs := r.categorizeJobs(childJobs.Items)

    // Update execution history
    r.updateExecutionHistory(ctx, &mcj, childJobs.Items)

    // Check concurrency policy
    if !r.canScheduleNew(&mcj, activeJobs) {
        logger.Info("Skipping schedule due to concurrency policy",
            "active", len(activeJobs), "policy", mcj.Spec.ConcurrencyPolicy)
        return ctrl.Result{RequeueAfter: time.Minute}, nil
    }

    // Calculate next schedule time
    schedule, err := cron.ParseStandard(mcj.Spec.Schedule)
    if err != nil {
        logger.Error(err, "Invalid cron schedule")
        return ctrl.Result{}, nil // Don't requeue, schedule is invalid
    }

    now := r.Clock.Now()
    var lastSchedule time.Time
    if mcj.Status.LastScheduleTime != nil {
        lastSchedule = mcj.Status.LastScheduleTime.Time
    } else {
        lastSchedule = mcj.CreationTimestamp.Time
    }

    // Find missed schedules
    missedSchedules := r.getMissedSchedules(schedule, lastSchedule, now)

    if len(missedSchedules) > 0 {
        // Create job for most recent missed schedule
        scheduledTime := missedSchedules[len(missedSchedules)-1]

        job := r.constructJob(&mcj, scheduledTime)
        if err := controllerutil.SetControllerReference(&mcj, job, r.Scheme); err != nil {
            return ctrl.Result{}, err
        }

        if err := r.Create(ctx, job); err != nil {
            if !errors.IsAlreadyExists(err) {
                return ctrl.Result{}, err
            }
        }

        logger.Info("Created Job", "job", job.Name, "scheduledTime", scheduledTime)

        // Update last schedule time
        mcj.Status.LastScheduleTime = &metav1.Time{Time: scheduledTime}
    }

    // Update status
    mcj.Status.ActiveJobs = int32(len(activeJobs))
    mcj.Status.ConsecutiveFailures = r.countConsecutiveFailures(&mcj)

    // Check failure threshold
    if mcj.Spec.FailureThreshold > 0 &&
        mcj.Status.ConsecutiveFailures >= mcj.Spec.FailureThreshold {
        r.sendAlert(ctx, &mcj)
    }

    // Clean up old jobs
    r.cleanupJobs(ctx, &mcj, successfulJobs, failedJobs)

    // Update status
    if err := r.Status().Update(ctx, &mcj); err != nil {
        return ctrl.Result{}, err
    }

    // Calculate next reconcile time
    nextSchedule := schedule.Next(now)
    return ctrl.Result{RequeueAfter: nextSchedule.Sub(now)}, nil
}

func (r *ManagedCronJobReconciler) canScheduleNew(mcj *cronv1alpha1.ManagedCronJob, activeJobs []*batchv1.Job) bool {
    switch mcj.Spec.ConcurrencyPolicy {
    case "Forbid":
        return len(activeJobs) == 0
    case "Replace":
        return true // Will be handled by deleting old jobs
    default: // Allow
        maxConcurrent := mcj.Spec.MaxConcurrent
        if maxConcurrent == 0 {
            maxConcurrent = 1
        }
        return int32(len(activeJobs)) < maxConcurrent
    }
}

func (r *ManagedCronJobReconciler) constructJob(mcj *cronv1alpha1.ManagedCronJob, scheduledTime time.Time) *batchv1.Job {
    jobName := fmt.Sprintf("%s-%d", mcj.Name, scheduledTime.Unix())

    return &batchv1.Job{
        ObjectMeta: metav1.ObjectMeta{
            Name:      jobName,
            Namespace: mcj.Namespace,
            Labels: map[string]string{
                "managed-cronjob":    mcj.Name,
                "scheduled-at-unix":  fmt.Sprintf("%d", scheduledTime.Unix()),
            },
            Annotations: map[string]string{
                "scheduled-at": scheduledTime.Format(time.RFC3339),
            },
        },
        Spec: batchv1.JobSpec{
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    RestartPolicy: corev1.RestartPolicyNever,
                    Containers: []corev1.Container{
                        {
                            Name:    "job",
                            Image:   mcj.Spec.Image,
                            Command: mcj.Spec.Command,
                        },
                    },
                },
            },
        },
    }
}

func (r *ManagedCronJobReconciler) categorizeJobs(jobs []batchv1.Job) (active, successful, failed []*batchv1.Job) {
    for i := range jobs {
        job := &jobs[i]
        if job.Status.Succeeded > 0 {
            successful = append(successful, job)
        } else if job.Status.Failed > 0 {
            failed = append(failed, job)
        } else {
            active = append(active, job)
        }
    }
    return
}

func (r *ManagedCronJobReconciler) cleanupJobs(ctx context.Context, mcj *cronv1alpha1.ManagedCronJob,
    successful, failed []*batchv1.Job) {

    limit := mcj.Spec.HistoryLimit
    if limit == 0 {
        limit = 3
    }

    // Sort by creation time, keep newest
    sort.Slice(successful, func(i, j int) bool {
        return successful[i].CreationTimestamp.After(successful[j].CreationTimestamp.Time)
    })

    for i := int(limit); i < len(successful); i++ {
        r.Delete(ctx, successful[i], client.PropagationPolicy(metav1.DeletePropagationBackground))
    }

    // Same for failed jobs
    sort.Slice(failed, func(i, j int) bool {
        return failed[i].CreationTimestamp.After(failed[j].CreationTimestamp.Time)
    })

    for i := int(limit); i < len(failed); i++ {
        r.Delete(ctx, failed[i], client.PropagationPolicy(metav1.DeletePropagationBackground))
    }
}

func (r *ManagedCronJobReconciler) getMissedSchedules(schedule cron.Schedule, lastSchedule, now time.Time) []time.Time {
    var missed []time.Time
    for t := schedule.Next(lastSchedule); !t.After(now); t = schedule.Next(t) {
        missed = append(missed, t)
        // Limit to avoid infinite loop on very old last schedule
        if len(missed) > 100 {
            break
        }
    }
    return missed
}

func (r *ManagedCronJobReconciler) handleDeletion(ctx context.Context, mcj *cronv1alpha1.ManagedCronJob) (ctrl.Result, error) {
    if controllerutil.ContainsFinalizer(mcj, finalizerName) {
        // Delete all child jobs
        var childJobs batchv1.JobList
        if err := r.List(ctx, &childJobs, client.InNamespace(mcj.Namespace),
            client.MatchingLabels{"managed-cronjob": mcj.Name}); err != nil {
            return ctrl.Result{}, err
        }

        for _, job := range childJobs.Items {
            if err := r.Delete(ctx, &job, client.PropagationPolicy(metav1.DeletePropagationBackground)); err != nil {
                if !errors.IsNotFound(err) {
                    return ctrl.Result{}, err
                }
            }
        }

        controllerutil.RemoveFinalizer(mcj, finalizerName)
        if err := r.Update(ctx, mcj); err != nil {
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, nil
}

func (r *ManagedCronJobReconciler) SetupWithManager(mgr ctrl.Manager) error {
    if r.Clock == nil {
        r.Clock = realClock{}
    }

    return ctrl.NewControllerManagedBy(mgr).
        For(&cronv1alpha1.ManagedCronJob{}).
        Owns(&batchv1.Job{}).
        Complete(r)
}
```

---

### Exercise 2: Build a Database Backup Operator

**Scenario**: Create an operator that automatically backs up PostgreSQL databases to S3 with configurable schedules and retention policies.

**Complete Solution**:

```go
// api/v1alpha1/databasebackup_types.go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type DatabaseBackupSpec struct {
    // DatabaseRef references the database to backup
    DatabaseRef DatabaseReference `json:"databaseRef"`

    // Schedule in cron format
    Schedule string `json:"schedule"`

    // S3 destination configuration
    S3Destination S3Config `json:"s3Destination"`

    // RetentionDays for keeping backups
    RetentionDays int32 `json:"retentionDays,omitempty"`

    // Compression type (gzip, zstd, none)
    Compression string `json:"compression,omitempty"`

    // EncryptionKeyRef for backup encryption
    EncryptionKeyRef *SecretReference `json:"encryptionKeyRef,omitempty"`
}

type DatabaseReference struct {
    Name      string `json:"name"`
    Namespace string `json:"namespace,omitempty"`
    // SecretRef containing connection credentials
    SecretRef SecretReference `json:"secretRef"`
}

type S3Config struct {
    Bucket       string          `json:"bucket"`
    Region       string          `json:"region"`
    Prefix       string          `json:"prefix,omitempty"`
    CredentialsRef SecretReference `json:"credentialsRef"`
}

type SecretReference struct {
    Name string `json:"name"`
    Key  string `json:"key,omitempty"`
}

type DatabaseBackupStatus struct {
    LastBackupTime    *metav1.Time `json:"lastBackupTime,omitempty"`
    LastBackupResult  string       `json:"lastBackupResult,omitempty"`
    BackupHistory     []BackupRecord `json:"backupHistory,omitempty"`
    TotalBackups      int32        `json:"totalBackups,omitempty"`
    TotalSizeBytes    int64        `json:"totalSizeBytes,omitempty"`
    Conditions        []metav1.Condition `json:"conditions,omitempty"`
}

type BackupRecord struct {
    Name      string      `json:"name"`
    S3Key     string      `json:"s3Key"`
    SizeBytes int64       `json:"sizeBytes"`
    StartTime metav1.Time `json:"startTime"`
    EndTime   *metav1.Time `json:"endTime,omitempty"`
    Status    string      `json:"status"`
    Message   string      `json:"message,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
type DatabaseBackup struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   DatabaseBackupSpec   `json:"spec,omitempty"`
    Status DatabaseBackupStatus `json:"status,omitempty"`
}
```

```go
// controllers/databasebackup_controller.go
package controllers

import (
    "context"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    batchv1 "k8s.io/api/batch/v1"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    ctrl "sigs.k8s.io/controller-runtime"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
    "sigs.k8s.io/controller-runtime/pkg/log"

    backupv1alpha1 "github.com/example/backup-operator/api/v1alpha1"
    "github.com/robfig/cron/v3"
)

const (
    backupFinalizer = "backup.example.com/finalizer"
    backupImage     = "postgres:18-alpine"
)

type DatabaseBackupReconciler struct {
    client.Client
    Scheme    *runtime.Scheme
    S3Client  *s3.Client
}

func (r *DatabaseBackupReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    logger := log.FromContext(ctx)

    var backup backupv1alpha1.DatabaseBackup
    if err := r.Get(ctx, req.NamespacedName, &backup); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }

    // Handle deletion
    if !backup.DeletionTimestamp.IsZero() {
        return r.handleDeletion(ctx, &backup)
    }

    // Add finalizer
    if !controllerutil.ContainsFinalizer(&backup, backupFinalizer) {
        controllerutil.AddFinalizer(&backup, backupFinalizer)
        if err := r.Update(ctx, &backup); err != nil {
            return ctrl.Result{}, err
        }
    }

    // Parse schedule
    schedule, err := cron.ParseStandard(backup.Spec.Schedule)
    if err != nil {
        logger.Error(err, "Invalid cron schedule")
        r.updateCondition(ctx, &backup, "ScheduleValid", metav1.ConditionFalse, "InvalidSchedule", err.Error())
        return ctrl.Result{}, nil
    }
    r.updateCondition(ctx, &backup, "ScheduleValid", metav1.ConditionTrue, "ValidSchedule", "")

    // Check if backup is needed
    now := time.Now()
    var lastBackup time.Time
    if backup.Status.LastBackupTime != nil {
        lastBackup = backup.Status.LastBackupTime.Time
    } else {
        lastBackup = backup.CreationTimestamp.Time
    }

    nextBackup := schedule.Next(lastBackup)
    if nextBackup.After(now) {
        // Not time yet, requeue for next schedule
        return ctrl.Result{RequeueAfter: nextBackup.Sub(now)}, nil
    }

    // Time to backup
    logger.Info("Starting backup", "database", backup.Spec.DatabaseRef.Name)

    // Create backup job
    job, err := r.createBackupJob(ctx, &backup, now)
    if err != nil {
        logger.Error(err, "Failed to create backup job")
        r.recordBackupResult(ctx, &backup, "Failed", err.Error(), 0)
        return ctrl.Result{RequeueAfter: 5 * time.Minute}, nil
    }

    // Add to history
    record := backupv1alpha1.BackupRecord{
        Name:      job.Name,
        StartTime: metav1.Now(),
        Status:    "Running",
    }
    backup.Status.BackupHistory = append([]backupv1alpha1.BackupRecord{record}, backup.Status.BackupHistory...)

    // Trim history
    if len(backup.Status.BackupHistory) > 10 {
        backup.Status.BackupHistory = backup.Status.BackupHistory[:10]
    }

    backup.Status.LastBackupTime = &metav1.Time{Time: now}
    if err := r.Status().Update(ctx, &backup); err != nil {
        return ctrl.Result{}, err
    }

    // Clean up old backups based on retention
    if err := r.cleanupOldBackups(ctx, &backup); err != nil {
        logger.Error(err, "Failed to cleanup old backups")
    }

    // Requeue for next schedule
    nextBackup = schedule.Next(now)
    return ctrl.Result{RequeueAfter: nextBackup.Sub(now)}, nil
}

func (r *DatabaseBackupReconciler) createBackupJob(ctx context.Context, backup *backupv1alpha1.DatabaseBackup, timestamp time.Time) (*batchv1.Job, error) {
    backupName := fmt.Sprintf("%s-%s", backup.Name, timestamp.Format("20060102-150405"))
    s3Key := fmt.Sprintf("%s/%s/%s.sql.gz",
        backup.Spec.S3Destination.Prefix,
        backup.Spec.DatabaseRef.Name,
        backupName)

    job := &batchv1.Job{
        ObjectMeta: metav1.ObjectMeta{
            Name:      backupName,
            Namespace: backup.Namespace,
            Labels: map[string]string{
                "backup.example.com/database-backup": backup.Name,
            },
        },
        Spec: batchv1.JobSpec{
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    RestartPolicy: corev1.RestartPolicyNever,
                    Containers: []corev1.Container{
                        {
                            Name:  "backup",
                            Image: backupImage,
                            Command: []string{"/bin/sh", "-c"},
                            Args: []string{
                                fmt.Sprintf(`
                                    pg_dump -h $PGHOST -U $PGUSER -d $PGDATABASE | gzip | \
                                    aws s3 cp - s3://%s/%s
                                `, backup.Spec.S3Destination.Bucket, s3Key),
                            },
                            EnvFrom: []corev1.EnvFromSource{
                                {
                                    SecretRef: &corev1.SecretEnvSource{
                                        LocalObjectReference: corev1.LocalObjectReference{
                                            Name: backup.Spec.DatabaseRef.SecretRef.Name,
                                        },
                                    },
                                },
                                {
                                    SecretRef: &corev1.SecretEnvSource{
                                        LocalObjectReference: corev1.LocalObjectReference{
                                            Name: backup.Spec.S3Destination.CredentialsRef.Name,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }

    if err := controllerutil.SetControllerReference(backup, job, r.Scheme); err != nil {
        return nil, err
    }

    if err := r.Create(ctx, job); err != nil {
        return nil, err
    }

    return job, nil
}

func (r *DatabaseBackupReconciler) cleanupOldBackups(ctx context.Context, backup *backupv1alpha1.DatabaseBackup) error {
    if backup.Spec.RetentionDays <= 0 {
        return nil
    }

    cutoff := time.Now().AddDate(0, 0, -int(backup.Spec.RetentionDays))

    // List S3 objects and delete old ones
    prefix := fmt.Sprintf("%s/%s/", backup.Spec.S3Destination.Prefix, backup.Spec.DatabaseRef.Name)

    paginator := s3.NewListObjectsV2Paginator(r.S3Client, &s3.ListObjectsV2Input{
        Bucket: &backup.Spec.S3Destination.Bucket,
        Prefix: &prefix,
    })

    for paginator.HasMorePages() {
        page, err := paginator.NextPage(ctx)
        if err != nil {
            return err
        }

        for _, obj := range page.Contents {
            if obj.LastModified.Before(cutoff) {
                _, err := r.S3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
                    Bucket: &backup.Spec.S3Destination.Bucket,
                    Key:    obj.Key,
                })
                if err != nil {
                    return err
                }
            }
        }
    }

    return nil
}

func (r *DatabaseBackupReconciler) handleDeletion(ctx context.Context, backup *backupv1alpha1.DatabaseBackup) (ctrl.Result, error) {
    if controllerutil.ContainsFinalizer(backup, backupFinalizer) {
        // Optionally delete all backups from S3
        // For safety, we leave them by default

        controllerutil.RemoveFinalizer(backup, backupFinalizer)
        if err := r.Update(ctx, backup); err != nil {
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, nil
}

func (r *DatabaseBackupReconciler) SetupWithManager(mgr ctrl.Manager) error {
    // Initialize S3 client
    cfg, err := config.LoadDefaultConfig(context.Background())
    if err != nil {
        return err
    }
    r.S3Client = s3.NewFromConfig(cfg)

    return ctrl.NewControllerManagedBy(mgr).
        For(&backupv1alpha1.DatabaseBackup{}).
        Owns(&batchv1.Job{}).
        Complete(r)
}
```

---

**Next Chapter: Infrastructure as Code** - We'll cover Terraform, Pulumi, and GitOps workflows for Go services.

### Junior → FAANG: Operator Exercises as Learning Accelerators

These exercises are structured learning accelerators: each one builds a specific operator skill on top of the previous one. Complete them in order. The CronJob Manager operator exercise is intentionally approachable as a starting point because CronJobs are a familiar Kubernetes resource, and managing them with a higher-level abstraction makes the operator's value immediately visible.

The most important rule for these exercises: do not just copy the solution. Attempt the exercise first, encounter the specific failure modes (webhook TLS certificate errors, RBAC permission denials, informer cache not synced), and debug them. The debugging process is where the real learning happens.

### Senior @ FAANG: Operator Exercises as Platform Capability Validation

At staff level, these exercises are prototypes for platform capabilities. The CronJob Manager operator is a simplified version of a real scheduling platform feature. The database operator is a simplified version of what StatefulSet operators (Percona XtraDB Cluster Operator, CockroachDB Operator, Vitess Operator) do in production.

Running through these exercises with the "production scale" lens reveals the gaps between a learning exercise and a production operator: the exercise does not handle the case where the managed resource is manually modified by a user (drift detection), does not provide a dry-run mode for plan-before-apply safety, and does not include the operational runbooks needed for the on-call rotation. Identifying these gaps, documenting them, and scoping the work to fill them is the staff engineering contribution that moves a prototype to a production-ready platform component.
