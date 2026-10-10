## Part 2: Custom Resource Definition (CRD)

A Custom Resource Definition (CRD) extends the Kubernetes API with your own resource type. Think of it as defining a new "kind" of object that Kubernetes can manage, just like it manages Pods or Services. In this part, you will define the `PostgresCluster` CRD using Go structs with special comment annotations called markers. These markers tell the code generator how to produce the OpenAPI schema, default values, and validation rules that Kubernetes will enforce when users create or update your custom resource.

### Define the API Types

The following type definitions establish the core data model for the Define the API Types domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
// api/v1alpha1/postgrescluster_types.go
package v1alpha1

import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PostgresClusterSpec defines the desired state of PostgresCluster
type PostgresClusterSpec struct {
    // Version is the PostgreSQL version (e.g., "18.4", "17.5")
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:Pattern=`^\d+\.\d+(\.\d+)?$`
    Version string `json:"version"`

    // Replicas is the number of PostgreSQL instances
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=10
    // +kubebuilder:default=1
    Replicas int32 `json:"replicas,omitempty"`

    // Storage configuration for PostgreSQL data
    // +kubebuilder:validation:Required
    Storage StorageSpec `json:"storage"`

    // Resources defines CPU and memory requirements
    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`

    // Image is the PostgreSQL container image
    // +kubebuilder:default="postgres:18.4"
    // +optional
    Image string `json:"image,omitempty"`

    // Configuration parameters for postgresql.conf
    // +optional
    Parameters map[string]string `json:"parameters,omitempty"`

    // Backup configuration
    // +optional
    Backup *BackupSpec `json:"backup,omitempty"`

    // High availability configuration
    // +optional
    HA *HASpec `json:"ha,omitempty"`

    // Monitoring configuration
    // +optional
    Monitoring *MonitoringSpec `json:"monitoring,omitempty"`
}

// StorageSpec defines storage configuration
type StorageSpec struct {
    // Size is the requested storage size
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:Pattern=`^\d+(Mi|Gi|Ti)$`
    Size string `json:"size"`

    // StorageClassName for PVCs
    // +optional
    StorageClassName *string `json:"storageClassName,omitempty"`

    // AccessMode for the PVC
    // +kubebuilder:default=ReadWriteOnce
    // +optional
    AccessMode corev1.PersistentVolumeAccessMode `json:"accessMode,omitempty"`
}

// BackupSpec defines backup configuration
type BackupSpec struct {
    // Enabled determines if backups are enabled
    // +kubebuilder:default=false
    Enabled bool `json:"enabled"`

    // Schedule in cron format
    // +kubebuilder:validation:Pattern=`^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})$`
    // +optional
    Schedule string `json:"schedule,omitempty"`

    // Retention is the number of backups to retain
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:default=7
    // +optional
    Retention int32 `json:"retention,omitempty"`

    // S3 configuration for backup storage
    // +optional
    S3 *S3Spec `json:"s3,omitempty"`
}

// S3Spec defines S3 configuration
type S3Spec struct {
    // Bucket name
    // +kubebuilder:validation:Required
    Bucket string `json:"bucket"`

    // Region
    // +optional
    Region string `json:"region,omitempty"`

    // Endpoint for S3-compatible storage
    // +optional
    Endpoint string `json:"endpoint,omitempty"`

    // CredentialsSecret contains AWS credentials
    // +kubebuilder:validation:Required
    CredentialsSecret string `json:"credentialsSecret"`
}

// HASpec defines high availability configuration
type HASpec struct {
    // Enabled determines if HA is enabled
    // +kubebuilder:default=false
    Enabled bool `json:"enabled"`

    // SyncReplicas is the number of synchronous replicas
    // +kubebuilder:validation:Minimum=0
    // +kubebuilder:validation:Maximum=9
    // +kubebuilder:default=1
    // +optional
    SyncReplicas int32 `json:"syncReplicas,omitempty"`

    // ReplicationMode: async or sync
    // +kubebuilder:validation:Enum=async;sync
    // +kubebuilder:default=async
    // +optional
    ReplicationMode string `json:"replicationMode,omitempty"`
}

// MonitoringSpec defines monitoring configuration
type MonitoringSpec struct {
    // Enabled determines if monitoring is enabled
    // +kubebuilder:default=false
    Enabled bool `json:"enabled"`

    // PrometheusExporter configuration
    // +optional
    PrometheusExporter *PrometheusExporterSpec `json:"prometheusExporter,omitempty"`
}

// PrometheusExporterSpec defines Prometheus exporter configuration
type PrometheusExporterSpec struct {
    // Image for the Prometheus exporter
    // +kubebuilder:default="quay.io/prometheuscommunity/postgres-exporter:latest"
    // +optional
    Image string `json:"image,omitempty"`

    // Resources for the exporter sidecar
    // +optional
    Resources corev1.ResourceRequirements `json:"resources,omitempty"`
}

// PostgresClusterStatus defines the observed state of PostgresCluster
type PostgresClusterStatus struct {
    // Conditions represent the latest available observations
    // +optional
    // +patchMergeKey=type
    // +patchStrategy=merge
    // +listType=map
    // +listMapKey=type
    Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`

    // Phase represents the current phase (Pending, Creating, Running, Failed)
    // +optional
    Phase ClusterPhase `json:"phase,omitempty"`

    // Replicas is the current number of replicas
    // +optional
    Replicas int32 `json:"replicas,omitempty"`

    // ReadyReplicas is the number of ready replicas
    // +optional
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`

    // PrimaryInstance is the name of the primary pod
    // +optional
    PrimaryInstance string `json:"primaryInstance,omitempty"`

    // ReplicaInstances is a list of replica pod names
    // +optional
    ReplicaInstances []string `json:"replicaInstances,omitempty"`

    // LastBackupTime is the timestamp of the last successful backup
    // +optional
    LastBackupTime *metav1.Time `json:"lastBackupTime,omitempty"`

    // ObservedGeneration reflects the generation of the most recently observed spec
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`
}

// ClusterPhase represents the current phase of the cluster
// +kubebuilder:validation:Enum=Pending;Creating;Running;Failed;Deleting
type ClusterPhase string

const (
    ClusterPhasePending  ClusterPhase = "Pending"
    ClusterPhaseCreating ClusterPhase = "Creating"
    ClusterPhaseRunning  ClusterPhase = "Running"
    ClusterPhaseFailed   ClusterPhase = "Failed"
    ClusterPhaseDeleting ClusterPhase = "Deleting"
)

// Condition types
const (
    ConditionTypeReady              = "Ready"
    ConditionTypeStatefulSetReady   = "StatefulSetReady"
    ConditionTypeConfigMapReady     = "ConfigMapReady"
    ConditionTypeServiceReady       = "ServiceReady"
    ConditionTypeBackupConfigured   = "BackupConfigured"
    ConditionTypeReplicationHealthy = "ReplicationHealthy"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:subresource:scale:specpath=.spec.replicas,statuspath=.status.replicas,selectorpath=.status.selector
// +kubebuilder:printcolumn:name="Version",type=string,JSONPath=`.spec.version`
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Ready",type=integer,JSONPath=`.status.readyReplicas`
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`
// +kubebuilder:resource:shortName=pgc;pg

// PostgresCluster is the Schema for the postgresclusters API
type PostgresCluster struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   PostgresClusterSpec   `json:"spec,omitempty"`
    Status PostgresClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// PostgresClusterList contains a list of PostgresCluster
type PostgresClusterList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []PostgresCluster `json:"items"`
}

func init() {
    SchemeBuilder.Register(&PostgresCluster{}, &PostgresClusterList{})
}

// Helper methods for status management

// SetCondition sets a condition on the status
func (pcs *PostgresClusterStatus) SetCondition(conditionType string, status metav1.ConditionStatus, reason, message string) {
    condition := metav1.Condition{
        Type:               conditionType,
        Status:             status,
        ObservedGeneration: pcs.ObservedGeneration,
        LastTransitionTime: metav1.Now(),
        Reason:             reason,
        Message:            message,
    }

    // Find existing condition
    for i, existingCondition := range pcs.Conditions {
        if existingCondition.Type == conditionType {
            // Only update if status changed
            if existingCondition.Status != status {
                pcs.Conditions[i] = condition
            } else {
                // Update message even if status didn't change
                pcs.Conditions[i].Message = message
                pcs.Conditions[i].Reason = reason
                pcs.Conditions[i].ObservedGeneration = pcs.ObservedGeneration
            }
            return
        }
    }

    // Add new condition
    pcs.Conditions = append(pcs.Conditions, condition)
}

// GetCondition returns the condition with the given type
func (pcs *PostgresClusterStatus) GetCondition(conditionType string) *metav1.Condition {
    for i := range pcs.Conditions {
        if pcs.Conditions[i].Type == conditionType {
            return &pcs.Conditions[i]
        }
    }
    return nil
}

// IsReady returns true if the cluster is ready
func (pcs *PostgresClusterStatus) IsReady() bool {
    condition := pcs.GetCondition(ConditionTypeReady)
    return condition != nil && condition.Status == metav1.ConditionTrue
}
```

### Generate CRD Manifests

Custom Resource Definitions extend the Kubernetes API with application-specific resource kinds that follow the same declarative model as built-in objects. Registering a CRD makes the new type available through kubectl, the API server, and RBAC policies without modifying Kubernetes itself.

```bash
# Generate CRD manifests and deepcopy code
make manifests generate
```

The generated CRD will include: - OpenAPI v3 schema validation
- Printer columns for `kubectl get`
- Status subresource
- Scale subresource
- Short names (`pgc`, `pg`)
