## Part 8: Production Considerations

Running an operator in production requires more than just correct reconciliation logic. You need observability to understand what your operator is doing, metrics to track its performance, and well-crafted example manifests that show users how to configure your custom resource for real workloads. This part covers registering custom Prometheus metrics for tracking reconciliation counts, errors, and durations, as well as providing a complete example `PostgresCluster` manifest with production-tuned PostgreSQL parameters, high availability, backup to S3, and monitoring via the Prometheus postgres exporter.

### Observability and Metrics

Observability instrumentation records latency histograms, error rates, and upstream response codes as Prometheus metrics, with distributed trace spans propagated via W3C TraceContext headers. These signals are essential for diagnosing latency spikes and routing misconfigurations in production.

```go
// internal/metrics/metrics.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "sigs.k8s.io/controller-runtime/pkg/metrics"
)

var (
    // ReconcileTotal tracks the total number of reconciliations
    ReconcileTotal = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "postgrescluster_reconcile_total",
            Help: "Total number of reconciliations",
        },
        []string{"cluster", "namespace"},
    )

    // ReconcileErrors tracks reconciliation errors
    ReconcileErrors = prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "postgrescluster_reconcile_errors_total",
            Help: "Total number of reconciliation errors",
        },
        []string{"cluster", "namespace"},
    )

    // ReconcileDuration tracks reconciliation duration
    ReconcileDuration = prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "postgrescluster_reconcile_duration_seconds",
            Help:    "Duration of reconciliations in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"cluster", "namespace"},
    )

    // ClusterStatus tracks cluster status
    ClusterStatus = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "postgrescluster_status",
            Help: "Status of PostgreSQL clusters (1=ready, 0=not ready)",
        },
        []string{"cluster", "namespace", "phase"},
    )

    // ClusterReplicas tracks replica count
    ClusterReplicas = prometheus.NewGaugeVec(
        prometheus.GaugeOpts{
            Name: "postgrescluster_replicas",
            Help: "Number of replicas in the cluster",
        },
        []string{"cluster", "namespace", "type"}, // type: desired, ready
    )
)

func init() {
    // Register custom metrics with the global prometheus registry
    metrics.Registry.MustRegister(
        ReconcileTotal,
        ReconcileErrors,
        ReconcileDuration,
        ClusterStatus,
        ClusterReplicas,
    )
}
```

### Example PostgresCluster CR

Cluster mode partitions the keyspace across multiple independent cache nodes using consistent hashing, with each node owning a contiguous range of hash slots. Clients discover the hash slot topology at startup and route each key directly to its responsible node without a central coordinator.

```yaml
# config/samples/database_v1alpha1_postgrescluster.yaml
apiVersion: database.example.com/v1alpha1
kind: PostgresCluster
metadata:
  name: production-db
  namespace: default
spec:
  version: "18.4"
  replicas: 3

  image: postgres:18.4-alpine

  storage:
    size: 100Gi
    storageClassName: fast-ssd
    accessMode: ReadWriteOnce

  resources:
    requests:
      cpu: "1"
      memory: 2Gi
    limits:
      cpu: "2"
      memory: 4Gi

  parameters:
    max_connections: "200"
    shared_buffers: "1GB"
    effective_cache_size: "3GB"
    maintenance_work_mem: "256MB"
    checkpoint_completion_target: "0.9"
    wal_buffers: "16MB"
    default_statistics_target: "100"
    random_page_cost: "1.1"
    effective_io_concurrency: "200"
    work_mem: "5242kB"
    min_wal_size: "1GB"
    max_wal_size: "4GB"

  ha:
    enabled: true
    syncReplicas: 1
    replicationMode: sync

  backup:
    enabled: true
    schedule: "0 2 * * *"
    retention: 14
    s3:
      bucket: postgres-backups
      region: us-east-1
      endpoint: https://s3.amazonaws.com
      credentialsSecret: aws-credentials

  monitoring:
    enabled: true
    prometheusExporter:
      image: quay.io/prometheuscommunity/postgres-exporter:v0.11.1
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 200m
          memory: 256Mi
```

---
