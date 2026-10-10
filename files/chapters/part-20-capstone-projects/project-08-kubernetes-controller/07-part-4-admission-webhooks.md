## Part 4: Admission Webhooks

Admission webhooks act as gatekeepers that intercept requests to the Kubernetes API server before resources are persisted. There are two types: validating webhooks that reject invalid configurations, and mutating webhooks that modify resources to set defaults or inject additional fields. For our PostgreSQL operator, the validating webhook prevents users from creating clusters with unsupported versions, dangerously small storage, or invalid backup settings. The mutating webhook automatically fills in sensible defaults like the container image tag and backup retention period so users do not have to specify every field.

### Validating Webhook

Admission webhooks intercept API server requests before object persistence to enforce policy and inject defaults. Mutating webhooks normalize incomplete specs, adding default resource limits or injecting sidecar containers, while validating webhooks reject requests that violate invariants.

```go
// api/v1alpha1/postgrescluster_webhook.go
package v1alpha1

import (
    "fmt"
    "regexp"
    "strconv"
    "strings"

    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/runtime/schema"
    "k8s.io/apimachinery/pkg/util/validation/field"
    ctrl "sigs.k8s.io/controller-runtime"
    logf "sigs.k8s.io/controller-runtime/pkg/log"
    "sigs.k8s.io/controller-runtime/pkg/webhook"
    "sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

var postgresclusterlog = logf.Log.WithName("postgrescluster-resource")

// SetupWebhookWithManager sets up the webhook with the manager
func (r *PostgresCluster) SetupWebhookWithManager(mgr ctrl.Manager) error {
    return ctrl.NewWebhookManagedBy(mgr).
        For(r).
        Complete()
}

// +kubebuilder:webhook:path=/mutate-database-example-com-v1alpha1-postgrescluster,mutating=true,failurePolicy=fail,sideEffects=None,groups=database.example.com,resources=postgresclusters,verbs=create;update,versions=v1alpha1,name=mpostgrescluster.kb.io,admissionReviewVersions=v1

var _ webhook.Defaulter = &PostgresCluster{}

// Default implements webhook.Defaulter
func (r *PostgresCluster) Default() {
    postgresclusterlog.Info("default", "name", r.Name)

    // Set default image if not specified
    if r.Spec.Image == "" {
        r.Spec.Image = fmt.Sprintf("postgres:%s", r.Spec.Version)
    }

    // Set default replicas
    if r.Spec.Replicas == 0 {
        r.Spec.Replicas = 1
    }

    // Set default storage access mode
    if r.Spec.Storage.AccessMode == "" {
        r.Spec.Storage.AccessMode = "ReadWriteOnce"
    }

    // Set default backup retention
    if r.Spec.Backup != nil && r.Spec.Backup.Enabled {
        if r.Spec.Backup.Retention == 0 {
            r.Spec.Backup.Retention = 7
        }
        if r.Spec.Backup.Schedule == "" {
            r.Spec.Backup.Schedule = "0 2 * * *" // 2 AM daily
        }
    }

    // Set default HA settings
    if r.Spec.HA != nil && r.Spec.HA.Enabled {
        if r.Spec.HA.SyncReplicas == 0 {
            r.Spec.HA.SyncReplicas = 1
        }
        if r.Spec.HA.ReplicationMode == "" {
            r.Spec.HA.ReplicationMode = "async"
        }
    }
}

// +kubebuilder:webhook:path=/validate-database-example-com-v1alpha1-postgrescluster,mutating=false,failurePolicy=fail,sideEffects=None,groups=database.example.com,resources=postgresclusters,verbs=create;update,versions=v1alpha1,name=vpostgrescluster.kb.io,admissionReviewVersions=v1

var _ webhook.Validator = &PostgresCluster{}

// ValidateCreate implements webhook.Validator
func (r *PostgresCluster) ValidateCreate() (admission.Warnings, error) {
    postgresclusterlog.Info("validate create", "name", r.Name)

    var allErrs field.ErrorList

    // Validate version format
    if err := r.validateVersion(); err != nil {
        allErrs = append(allErrs, err)
    }

    // Validate storage size
    if err := r.validateStorageSize(); err != nil {
        allErrs = append(allErrs, err)
    }

    // Validate backup configuration
    if errs := r.validateBackup(); len(errs) > 0 {
        allErrs = append(allErrs, errs...)
    }

    // Validate HA configuration
    if errs := r.validateHA(); len(errs) > 0 {
        allErrs = append(allErrs, errs...)
    }

    // Validate parameters
    if errs := r.validateParameters(); len(errs) > 0 {
        allErrs = append(allErrs, errs...)
    }

    if len(allErrs) == 0 {
        return nil, nil
    }

    return nil, apierrors.NewInvalid(
        schema.GroupKind{Group: "database.example.com", Kind: "PostgresCluster"},
        r.Name,
        allErrs,
    )
}

// ValidateUpdate implements webhook.Validator
func (r *PostgresCluster) ValidateUpdate(old runtime.Object) (admission.Warnings, error) {
    postgresclusterlog.Info("validate update", "name", r.Name)

    oldCluster := old.(*PostgresCluster)

    var allErrs field.ErrorList
    var warnings admission.Warnings

    // Version can only be upgraded, not downgraded
    if err := r.validateVersionUpgrade(oldCluster); err != nil {
        allErrs = append(allErrs, err)
    }

    // Storage size cannot be decreased
    if err := r.validateStorageSizeUpdate(oldCluster); err != nil {
        allErrs = append(allErrs, err)
    }

    // Replicas cannot be decreased if HA is enabled
    if r.Spec.HA != nil && r.Spec.HA.Enabled {
        if r.Spec.Replicas < oldCluster.Spec.Replicas {
            warnings = append(warnings, "Decreasing replicas with HA enabled may cause data loss")
        }
    }

    // Validate new configuration
    if createWarnings, err := r.ValidateCreate(); err != nil {
        return nil, err
    } else if len(createWarnings) > 0 {
        warnings = append(warnings, createWarnings...)
    }

    if len(allErrs) == 0 {
        return warnings, nil
    }

    return warnings, apierrors.NewInvalid(
        schema.GroupKind{Group: "database.example.com", Kind: "PostgresCluster"},
        r.Name,
        allErrs,
    )
}

// ValidateDelete implements webhook.Validator
func (r *PostgresCluster) ValidateDelete() (admission.Warnings, error) {
    postgresclusterlog.Info("validate delete", "name", r.Name)

    // Could add validation to prevent accidental deletion of production clusters
    // For example, require a specific annotation to delete
    if r.Annotations["database.example.com/allow-deletion"] != "true" {
        return admission.Warnings{
            "Cluster deletion requires annotation: database.example.com/allow-deletion=true",
        }, nil
    }

    return nil, nil
}

// validateVersion validates the PostgreSQL version format
func (r *PostgresCluster) validateVersion() *field.Error {
    versionRegex := regexp.MustCompile(`^\d+\.\d+(\.\d+)?$`)
    if !versionRegex.MatchString(r.Spec.Version) {
        return field.Invalid(
            field.NewPath("spec").Child("version"),
            r.Spec.Version,
            "must be in format X.Y or X.Y.Z (e.g., 15.2 or 15.2.0)",
        )
    }

    // Validate supported versions (PostgreSQL 12+)
    parts := strings.Split(r.Spec.Version, ".")
    major, _ := strconv.Atoi(parts[0])
    if major < 12 {
        return field.Invalid(
            field.NewPath("spec").Child("version"),
            r.Spec.Version,
            "PostgreSQL version must be 12 or higher",
        )
    }

    return nil
}

// validateStorageSize validates the storage size format and minimum size
func (r *PostgresCluster) validateStorageSize() *field.Error {
    sizeRegex := regexp.MustCompile(`^(\d+)(Mi|Gi|Ti)$`)
    matches := sizeRegex.FindStringSubmatch(r.Spec.Storage.Size)
    if len(matches) == 0 {
        return field.Invalid(
            field.NewPath("spec").Child("storage").Child("size"),
            r.Spec.Storage.Size,
            "must be in format NUMBERMi/Gi/Ti (e.g., 10Gi)",
        )
    }

    // Enforce minimum size of 1Gi
    value, _ := strconv.Atoi(matches[1])
    unit := matches[2]

    if unit == "Mi" && value < 1024 {
        return field.Invalid(
            field.NewPath("spec").Child("storage").Child("size"),
            r.Spec.Storage.Size,
            "minimum storage size is 1Gi",
        )
    }

    return nil
}

// validateBackup validates backup configuration
func (r *PostgresCluster) validateBackup() field.ErrorList {
    var allErrs field.ErrorList

    if r.Spec.Backup == nil || !r.Spec.Backup.Enabled {
        return allErrs
    }

    // Validate cron schedule
    cronRegex := regexp.MustCompile(`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`)
    if !cronRegex.MatchString(r.Spec.Backup.Schedule) {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec").Child("backup").Child("schedule"),
            r.Spec.Backup.Schedule,
            "invalid cron schedule format",
        ))
    }

    // Validate S3 configuration
    if r.Spec.Backup.S3 != nil {
        if r.Spec.Backup.S3.Bucket == "" {
            allErrs = append(allErrs, field.Required(
                field.NewPath("spec").Child("backup").Child("s3").Child("bucket"),
                "S3 bucket is required when S3 backup is configured",
            ))
        }

        if r.Spec.Backup.S3.CredentialsSecret == "" {
            allErrs = append(allErrs, field.Required(
                field.NewPath("spec").Child("backup").Child("s3").Child("credentialsSecret"),
                "S3 credentials secret is required",
            ))
        }
    }

    return allErrs
}

// validateHA validates high availability configuration
func (r *PostgresCluster) validateHA() field.ErrorList {
    var allErrs field.ErrorList

    if r.Spec.HA == nil || !r.Spec.HA.Enabled {
        return allErrs
    }

    // HA requires at least 2 replicas
    if r.Spec.Replicas < 2 {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec").Child("replicas"),
            r.Spec.Replicas,
            "HA mode requires at least 2 replicas",
        ))
    }

    // Synchronous replicas must be less than total replicas
    if r.Spec.HA.SyncReplicas >= r.Spec.Replicas {
        allErrs = append(allErrs, field.Invalid(
            field.NewPath("spec").Child("ha").Child("syncReplicas"),
            r.Spec.HA.SyncReplicas,
            "syncReplicas must be less than total replicas",
        ))
    }

    return allErrs
}

// validateParameters validates PostgreSQL parameters
func (r *PostgresCluster) validateParameters() field.ErrorList {
    var allErrs field.ErrorList

    // Define dangerous parameters that shouldn't be set via CRD
    dangerousParams := map[string]bool{
        "data_directory":    true,
        "hba_file":          true,
        "ident_file":        true,
        "listen_addresses":  true,
        "port":              true,
        "unix_socket_directories": true,
    }

    for key := range r.Spec.Parameters {
        if dangerousParams[key] {
            allErrs = append(allErrs, field.Forbidden(
                field.NewPath("spec").Child("parameters").Key(key),
                fmt.Sprintf("parameter '%s' cannot be set via CRD", key),
            ))
        }
    }

    return allErrs
}

// validateVersionUpgrade validates that version is only upgraded, not downgraded
func (r *PostgresCluster) validateVersionUpgrade(old *PostgresCluster) *field.Error {
    oldParts := strings.Split(old.Spec.Version, ".")
    newParts := strings.Split(r.Spec.Version, ".")

    oldMajor, _ := strconv.Atoi(oldParts[0])
    newMajor, _ := strconv.Atoi(newParts[0])

    if newMajor < oldMajor {
        return field.Invalid(
            field.NewPath("spec").Child("version"),
            r.Spec.Version,
            "PostgreSQL version cannot be downgraded",
        )
    }

    if newMajor == oldMajor && len(oldParts) > 1 && len(newParts) > 1 {
        oldMinor, _ := strconv.Atoi(oldParts[1])
        newMinor, _ := strconv.Atoi(newParts[1])

        if newMinor < oldMinor {
            return field.Invalid(
                field.NewPath("spec").Child("version"),
                r.Spec.Version,
                "PostgreSQL version cannot be downgraded",
            )
        }
    }

    return nil
}

// validateStorageSizeUpdate validates that storage size is not decreased
func (r *PostgresCluster) validateStorageSizeUpdate(old *PostgresCluster) *field.Error {
    // Parse old and new sizes
    oldSize := parseStorageSize(old.Spec.Storage.Size)
    newSize := parseStorageSize(r.Spec.Storage.Size)

    if newSize < oldSize {
        return field.Invalid(
            field.NewPath("spec").Child("storage").Child("size"),
            r.Spec.Storage.Size,
            "storage size cannot be decreased",
        )
    }

    return nil
}

// parseStorageSize converts storage size string to bytes
func parseStorageSize(size string) int64 {
    sizeRegex := regexp.MustCompile(`^(\d+)(Mi|Gi|Ti)$`)
    matches := sizeRegex.FindStringSubmatch(size)
    if len(matches) == 0 {
        return 0
    }

    value, _ := strconv.ParseInt(matches[1], 10, 64)
    unit := matches[2]

    switch unit {
    case "Mi":
        return value * 1024 * 1024
    case "Gi":
        return value * 1024 * 1024 * 1024
    case "Ti":
        return value * 1024 * 1024 * 1024 * 1024
    default:
        return 0
    }
}
```
