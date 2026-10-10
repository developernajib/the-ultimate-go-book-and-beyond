## 104.12 Multi-Tenancy and Federation

### Prometheus Federation Setup

Federation lets a global Prometheus scrape aggregated series from regional Prometheus instances, giving you a fleet-wide view without shipping every raw sample across regions. The configuration below federates selected series from two regional instances.
```yaml
# prometheus/prometheus-federation.yaml
global:
  scrape_interval: 15s
  external_labels:
    cluster: global

scrape_configs:
  # Federate from regional Prometheus instances
  - job_name: 'federate'
    scrape_interval: 30s
    honor_labels: true
    metrics_path: '/federate'
    params:
      'match[]':
        - '{job="api-server"}'
        - '{job="database"}'
        - 'up'
        - '{__name__=~"sli:.*"}'
        - '{__name__=~"slo:.*"}'
    static_configs:
      - targets:
        - 'prometheus-us-east.internal:9090'
        - 'prometheus-us-west.internal:9090'
        - 'prometheus-eu-west.internal:9090'
```

### Thanos for Long-Term Storage

Thanos extends Prometheus with durable long-term storage: a sidecar uploads TSDB blocks to object storage, and store gateways make years of metrics queryable through the same PromQL interface.

```go
// Thanos sidecar configuration as Go struct
package config

type ThanosConfig struct {
    Store  StoreConfig  `yaml:"store"`
    Query  QueryConfig  `yaml:"query"`
    Sidecar SidecarConfig `yaml:"sidecar"`
}

type StoreConfig struct {
    GrpcAddress string `yaml:"grpc_address"`
    HttpAddress string `yaml:"http_address"`
    DataDir     string `yaml:"data_dir"`
    Objstore    ObjstoreConfig `yaml:"objstore"`
}

type ObjstoreConfig struct {
    Type   string `yaml:"type"`
    Config struct {
        Bucket   string `yaml:"bucket"`
        Endpoint string `yaml:"endpoint"`
    } `yaml:"config"`
}

// Kubernetes deployment for Thanos Query
const thanosQueryDeployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: thanos-query
spec:
  replicas: 2
  selector:
    matchLabels:
      app: thanos-query
  template:
    metadata:
      labels:
        app: thanos-query
    spec:
      containers:
      - name: thanos-query
        image: quay.io/thanos/thanos:v0.37.0
        args:
        - query
        - --log.level=info
        - --store=dnssrv+_grpc._tcp.thanos-store.monitoring.svc
        - --store=dnssrv+_grpc._tcp.thanos-sidecar.monitoring.svc
        ports:
        - name: http
          containerPort: 10902
        - name: grpc
          containerPort: 10901
`
```

### Multi-Tenant Metrics

Multi-tenant metrics require isolating each tenant's data so that one tenant's queries cannot access another's time series. The `TenantMetrics` wrapper below stamps a constant `tenant` label on every metric and uses a per-tenant Prometheus registry to enforce namespace separation at the collection layer.

```go
// Multi-tenant metrics with namespace isolation
package metrics

import (
    "net/http"
    "sync"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promhttp"
)

// TenantRegistry manages per-tenant metrics
type TenantRegistry struct {
    registries map[string]*prometheus.Registry
    mu         sync.RWMutex
}

func NewTenantRegistry() *TenantRegistry {
    return &TenantRegistry{
        registries: make(map[string]*prometheus.Registry),
    }
}

func (tr *TenantRegistry) GetRegistry(tenantID string) *prometheus.Registry {
    tr.mu.RLock()
    reg, exists := tr.registries[tenantID]
    tr.mu.RUnlock()

    if exists {
        return reg
    }

    tr.mu.Lock()
    defer tr.mu.Unlock()

    // Double-check after acquiring write lock
    if reg, exists = tr.registries[tenantID]; exists {
        return reg
    }

    reg = prometheus.NewRegistry()
    tr.registries[tenantID] = reg
    return reg
}

// TenantMetrics creates isolated metrics per tenant
type TenantMetrics struct {
    registry       *prometheus.Registry
    tenantID       string
    requestsTotal  *prometheus.CounterVec
    requestLatency *prometheus.HistogramVec
}

func NewTenantMetrics(tr *TenantRegistry, tenantID string) *TenantMetrics {
    reg := tr.GetRegistry(tenantID)

    requestsTotal := prometheus.NewCounterVec(
        prometheus.CounterOpts{
            Name: "http_requests_total",
            Help: "Total HTTP requests",
            ConstLabels: prometheus.Labels{"tenant": tenantID},
        },
        []string{"method", "path", "status"},
    )
    reg.MustRegister(requestsTotal)

    requestLatency := prometheus.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "http_request_duration_seconds",
            Help:    "Request latency",
            ConstLabels: prometheus.Labels{"tenant": tenantID},
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )
    reg.MustRegister(requestLatency)

    return &TenantMetrics{
        registry:       reg,
        tenantID:       tenantID,
        requestsTotal:  requestsTotal,
        requestLatency: requestLatency,
    }
}

func (tm *TenantMetrics) RecordRequest(method, path, status string, duration float64) {
    tm.requestsTotal.WithLabelValues(method, path, status).Inc()
    tm.requestLatency.WithLabelValues(method, path).Observe(duration)
}

// Multi-tenant metrics handler.
// In production, derive the tenant from an authenticated identity
// (mTLS cert, validated header), never from an unauthenticated
// query parameter, or any caller can read any tenant's metrics.
func (tr *TenantRegistry) MetricsHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        tenantID := r.URL.Query().Get("tenant")
        if tenantID == "" {
            http.Error(w, "tenant parameter required", http.StatusBadRequest)
            return
        }

        reg := tr.GetRegistry(tenantID)
        promhttp.HandlerFor(reg, promhttp.HandlerOpts{}).ServeHTTP(w, r)
    }
}
```

### Junior → FAANG: Why Multi-Tenancy Matters in Metrics

In a single-team environment, one Prometheus instance serving one team is fine. In a multi-team organization, all teams sharing one Prometheus without isolation means a single team's cardinality explosion affects everyone's alerting. Multi-tenancy solves this by separating metric namespaces, query quotas, and alert routing per team.

For a first job in a large organization, you will likely interact with a pre-existing multi-tenant metrics platform (Cortex, Thanos, Grafana Mimir) rather than building one. Understanding the architecture helps you use it correctly: know which tenant ID your service should use, how to scope your Grafana data source to your team's metrics, and how to avoid leaking metrics across tenant boundaries.

### Senior @ FAANG: Federation Topology Design and Tenant Isolation Enforcement

**Remote write vs. federation for multi-cluster aggregation.** Prometheus federation (the `/federate` endpoint) is a pull model: a central Prometheus scrapes selected metrics from leaf Prometheus instances. Remote write is a push model: leaf instances push metrics to a centralized storage backend (Cortex, Mimir, Thanos receive). At FAANG scale, remote write is preferred because it scales horizontally and does not create a scrape bottleneck at the central instance. The trade-off: remote write introduces a write-ahead log buffer and a network hop, adding seconds of latency before metrics appear in the global store.

**Tenant isolation at the storage layer.** Grafana Mimir and Cortex implement tenant isolation by prepending a tenant ID to all metric series in storage. A misconfigured tenant ID leaks metrics into another tenant's namespace. The platform team enforces tenant ID correctness by validating the `X-Scope-OrgID` header at the Mimir ingress using a policy engine (OPA), and any request with a tenant ID not in the authorized list is rejected with 403 before reaching storage.

**Per-tenant query quotas.** Without query quotas, one team running an expensive backfill query can saturate the Thanos query frontend and delay alerts for all other teams. Cortex and Mimir implement per-tenant query limits (max series per query, max time range per query, max concurrent queries per tenant). An L6 engineer calibrates these limits based on the observed query patterns from each tenant and adjusts them as teams' needs evolve.

---
