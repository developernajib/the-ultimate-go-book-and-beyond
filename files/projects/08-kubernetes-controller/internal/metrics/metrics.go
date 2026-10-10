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
