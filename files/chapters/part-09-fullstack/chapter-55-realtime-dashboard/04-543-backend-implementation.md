## 55.3 Backend Implementation

### Configuration with Observability Built-In

Embedding observability configuration (tracing endpoints, log level, metric export targets) directly in the application config struct ensures that every deployment, including local development, produces structured telemetry by default. This eliminates the common gap where tracing is configured in production but not locally, making distributed trace comparisons between environments meaningful. The config below also uses `GOMEMLIMIT` and GC tuning values that are exposed as environment variables so operators can tune them without redeploying.

```go
// backend/pkg/config/config.go
package config

import (
    "time"

    "github.com/kelseyhightower/envconfig"
)

type Config struct {
    // Server
    APIPort       int           `envconfig:"API_PORT" default:"8080"`
    WSPort        int           `envconfig:"WS_PORT" default:"8081"`
    ReadTimeout   time.Duration `envconfig:"READ_TIMEOUT" default:"5s"`
    WriteTimeout  time.Duration `envconfig:"WRITE_TIMEOUT" default:"10s"`

    // Database - Note: We configure for SCALE from the start
    DatabaseURL        string        `envconfig:"DATABASE_URL" required:"true"`
    DBMaxOpenConns     int           `envconfig:"DB_MAX_OPEN_CONNS" default:"25"`
    DBMaxIdleConns     int           `envconfig:"DB_MAX_IDLE_CONNS" default:"10"`
    DBConnMaxLifetime  time.Duration `envconfig:"DB_CONN_MAX_LIFETIME" default:"5m"`
    DBConnMaxIdleTime  time.Duration `envconfig:"DB_CONN_MAX_IDLE_TIME" default:"1m"`

    // Read Replicas for scaling reads
    ReadReplicaURLs    []string      `envconfig:"READ_REPLICA_URLS"`

    // Redis - Caching is NOT optional
    RedisURL           string        `envconfig:"REDIS_URL" required:"true"`
    RedisCachePrefix   string        `envconfig:"REDIS_CACHE_PREFIX" default:"dashboard"`
    RedisCacheTTL      time.Duration `envconfig:"REDIS_CACHE_TTL" default:"5m"`

    // TimescaleDB/InfluxDB for time-series
    TimeSeriesURL      string        `envconfig:"TIMESERIES_URL" required:"true"`

    // Observability - Pillar 3
    MetricsEnabled     bool          `envconfig:"METRICS_ENABLED" default:"true"`
    MetricsPort        int           `envconfig:"METRICS_PORT" default:"9090"`
    TracingEnabled     bool          `envconfig:"TRACING_ENABLED" default:"true"`
    TracingEndpoint    string        `envconfig:"TRACING_ENDPOINT"`
    LogLevel           string        `envconfig:"LOG_LEVEL" default:"info"`
    LogFormat          string        `envconfig:"LOG_FORMAT" default:"json"`

    // WebSocket
    WSMaxConnections   int           `envconfig:"WS_MAX_CONNECTIONS" default:"10000"`
    WSReadBufferSize   int           `envconfig:"WS_READ_BUFFER_SIZE" default:"1024"`
    WSWriteBufferSize  int           `envconfig:"WS_WRITE_BUFFER_SIZE" default:"1024"`
    WSPingInterval     time.Duration `envconfig:"WS_PING_INTERVAL" default:"30s"`
    WSPongTimeout      time.Duration `envconfig:"WS_PONG_TIMEOUT" default:"60s"`

    // Rate Limiting
    RateLimitRequests  int           `envconfig:"RATE_LIMIT_REQUESTS" default:"100"`
    RateLimitWindow    time.Duration `envconfig:"RATE_LIMIT_WINDOW" default:"1m"`
}

func Load() (*Config, error) {
    var cfg Config
    if err := envconfig.Process("", &cfg); err != nil {
        return nil, err
    }
    return &cfg, nil
}
```

### Observability Foundation (Pillar 3)

Structured logging with correlation IDs, distributed tracing via OpenTelemetry, and Prometheus metrics form the observability trifecta that makes production incidents diagnosable without SSH access. Initializing all three in a single `observability` package ensures consistent span naming, log field conventions, and metric label cardinality across the entire service. The setup below wires OTLP export, a Prometheus scrape endpoint, and a `slog` handler that emits JSON with trace IDs automatically attached.

```go
// backend/internal/observability/metrics.go
package observability

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

// DashboardMetrics contains all custom metrics for our dashboard
// Remember: The legacy system had 240 metrics. We aim for comprehensive coverage.
type DashboardMetrics struct {
    // HTTP Metrics
    HTTPRequestsTotal    *prometheus.CounterVec
    HTTPRequestDuration  *prometheus.HistogramVec
    HTTPRequestsInFlight prometheus.Gauge

    // WebSocket Metrics
    WSConnectionsActive  prometheus.Gauge
    WSConnectionsTotal   prometheus.Counter
    WSMessagesReceived   *prometheus.CounterVec
    WSMessagesSent       *prometheus.CounterVec
    WSMessageLatency     *prometheus.HistogramVec

    // Database Metrics - Critical for catching N+1 problems
    DBQueriesTotal       *prometheus.CounterVec
    DBQueryDuration      *prometheus.HistogramVec
    DBConnectionsActive  prometheus.Gauge
    DBConnectionsIdle    prometheus.Gauge
    DBConnectionErrors   prometheus.Counter

    // Cache Metrics - Remember: 91% vs 23% cache hit rate
    CacheHits            *prometheus.CounterVec
    CacheMisses          *prometheus.CounterVec
    CacheHitRate         prometheus.Gauge
    CacheLatency         *prometheus.HistogramVec

    // Ingestion Metrics
    MetricsIngested      prometheus.Counter
    MetricsDropped       *prometheus.CounterVec
    IngestionLatency     prometheus.Histogram
    IngestionBatchSize   prometheus.Histogram

    // Aggregation Metrics
    AggregationsRun      *prometheus.CounterVec
    AggregationDuration  *prometheus.HistogramVec
    AggregationErrors    *prometheus.CounterVec

    // Business Metrics - What actually matters
    ActiveDashboards     prometheus.Gauge
    QueriesPerSecond     prometheus.Gauge
    DataPointsPerSecond  prometheus.Gauge
}

func NewDashboardMetrics(reg prometheus.Registerer) *DashboardMetrics {
    m := &DashboardMetrics{
        // HTTP Metrics
        HTTPRequestsTotal: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_http_requests_total",
                Help: "Total number of HTTP requests",
            },
            []string{"method", "path", "status"},
        ),
        HTTPRequestDuration: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "dashboard_http_request_duration_seconds",
                Help:    "HTTP request duration in seconds",
                Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
            },
            []string{"method", "path"},
        ),
        HTTPRequestsInFlight: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_http_requests_in_flight",
                Help: "Current number of HTTP requests being processed",
            },
        ),

        // WebSocket Metrics
        WSConnectionsActive: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_ws_connections_active",
                Help: "Current number of active WebSocket connections",
            },
        ),
        WSConnectionsTotal: promauto.With(reg).NewCounter(
            prometheus.CounterOpts{
                Name: "dashboard_ws_connections_total",
                Help: "Total number of WebSocket connections established",
            },
        ),
        WSMessagesReceived: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_ws_messages_received_total",
                Help: "Total WebSocket messages received",
            },
            []string{"type"},
        ),
        WSMessagesSent: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_ws_messages_sent_total",
                Help: "Total WebSocket messages sent",
            },
            []string{"type"},
        ),
        WSMessageLatency: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "dashboard_ws_message_latency_seconds",
                Help:    "WebSocket message processing latency",
                Buckets: []float64{.0001, .0005, .001, .005, .01, .025, .05, .1},
            },
            []string{"type"},
        ),

        // Database Metrics
        DBQueriesTotal: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_db_queries_total",
                Help: "Total database queries executed",
            },
            []string{"query_type", "table"},
        ),
        DBQueryDuration: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "dashboard_db_query_duration_seconds",
                Help:    "Database query duration",
                Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5},
            },
            []string{"query_type", "table"},
        ),
        DBConnectionsActive: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_db_connections_active",
                Help: "Current active database connections",
            },
        ),
        DBConnectionsIdle: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_db_connections_idle",
                Help: "Current idle database connections",
            },
        ),
        DBConnectionErrors: promauto.With(reg).NewCounter(
            prometheus.CounterOpts{
                Name: "dashboard_db_connection_errors_total",
                Help: "Total database connection errors",
            },
        ),

        // Cache Metrics - CRITICAL
        CacheHits: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_cache_hits_total",
                Help: "Total cache hits",
            },
            []string{"cache_type", "key_pattern"},
        ),
        CacheMisses: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_cache_misses_total",
                Help: "Total cache misses",
            },
            []string{"cache_type", "key_pattern"},
        ),
        CacheHitRate: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_cache_hit_rate",
                Help: "Current cache hit rate (0-1)",
            },
        ),
        CacheLatency: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "dashboard_cache_latency_seconds",
                Help:    "Cache operation latency",
                Buckets: []float64{.0001, .0005, .001, .005, .01},
            },
            []string{"operation", "cache_type"},
        ),

        // Ingestion Metrics
        MetricsIngested: promauto.With(reg).NewCounter(
            prometheus.CounterOpts{
                Name: "dashboard_metrics_ingested_total",
                Help: "Total metrics data points ingested",
            },
        ),
        MetricsDropped: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_metrics_dropped_total",
                Help: "Total metrics dropped",
            },
            []string{"reason"},
        ),
        IngestionLatency: promauto.With(reg).NewHistogram(
            prometheus.HistogramOpts{
                Name:    "dashboard_ingestion_latency_seconds",
                Help:    "Metrics ingestion latency",
                Buckets: []float64{.001, .005, .01, .025, .05, .1, .25},
            },
        ),
        IngestionBatchSize: promauto.With(reg).NewHistogram(
            prometheus.HistogramOpts{
                Name:    "dashboard_ingestion_batch_size",
                Help:    "Ingestion batch sizes",
                Buckets: []float64{1, 10, 50, 100, 500, 1000, 5000},
            },
        ),

        // Aggregation Metrics
        AggregationsRun: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_aggregations_run_total",
                Help: "Total aggregation jobs run",
            },
            []string{"aggregation_type", "interval"},
        ),
        AggregationDuration: promauto.With(reg).NewHistogramVec(
            prometheus.HistogramOpts{
                Name:    "dashboard_aggregation_duration_seconds",
                Help:    "Aggregation job duration",
                Buckets: []float64{.1, .5, 1, 2.5, 5, 10, 30, 60},
            },
            []string{"aggregation_type"},
        ),
        AggregationErrors: promauto.With(reg).NewCounterVec(
            prometheus.CounterOpts{
                Name: "dashboard_aggregation_errors_total",
                Help: "Total aggregation errors",
            },
            []string{"aggregation_type", "error_type"},
        ),

        // Business Metrics
        ActiveDashboards: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_active_dashboards",
                Help: "Number of dashboards being actively viewed",
            },
        ),
        QueriesPerSecond: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_queries_per_second",
                Help: "Current queries per second",
            },
        ),
        DataPointsPerSecond: promauto.With(reg).NewGauge(
            prometheus.GaugeOpts{
                Name: "dashboard_data_points_per_second",
                Help: "Data points being processed per second",
            },
        ),
    }

    return m
}

// CalculateCacheHitRate updates the cache hit rate gauge
func (m *DashboardMetrics) CalculateCacheHitRate() {
    // This would be called periodically to update the gauge
    // In practice, you'd track hits and misses over a window
}
```

### Database Layer with Connection Pooling

Properly sizing the Postgres connection pool (setting `MaxOpenConns`, `MaxIdleConns`, and `ConnMaxLifetime`) prevents both connection exhaustion under load and idle connection accumulation that wastes database server resources. Beyond pool sizing, embedding span creation in every query helper attaches database timing to the distributed trace, making slow queries immediately visible in Jaeger or Tempo. The layer below also validates schema compatibility at startup using a migration check, aborting before serving traffic if the schema version is unexpected.

```go
// backend/pkg/database/pool.go
package database

import (
    "context"
    "fmt"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5"
    "github.com/jackc/pgx/v5/pgxpool"
)

type PoolConfig struct {
    URL             string
    MaxConns        int32
    MinConns        int32
    MaxConnLifetime time.Duration
    MaxConnIdleTime time.Duration
    HealthCheckPeriod time.Duration
}

// NewPool creates a properly configured connection pool
// This is Pillar 2: Infrastructure - connection pooling is NOT optional
func NewPool(ctx context.Context, cfg PoolConfig) (*pgxpool.Pool, error) {
    poolConfig, err := pgxpool.ParseConfig(cfg.URL)
    if err != nil {
        return nil, fmt.Errorf("parsing database URL: %w", err)
    }

    // Configure pool settings
    poolConfig.MaxConns = cfg.MaxConns
    poolConfig.MinConns = cfg.MinConns
    poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
    poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
    poolConfig.HealthCheckPeriod = cfg.HealthCheckPeriod

    // Add connection lifecycle hooks for observability
    poolConfig.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
        slog.Debug("acquiring connection from pool")
        return true
    }

    poolConfig.AfterRelease = func(conn *pgx.Conn) bool {
        slog.Debug("releasing connection back to pool")
        return true
    }

    pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
    if err != nil {
        return nil, fmt.Errorf("creating connection pool: %w", err)
    }

    // Verify connection
    if err := pool.Ping(ctx); err != nil {
        return nil, fmt.Errorf("pinging database: %w", err)
    }

    return pool, nil
}

// PoolStats returns current pool statistics for monitoring
type PoolStats struct {
    TotalConns      int32
    AcquiredConns   int32
    IdleConns       int32
    MaxConns        int32
    AcquireCount    int64
    AcquireDuration time.Duration
    EmptyAcquire    int64
}

func GetPoolStats(pool *pgxpool.Pool) PoolStats {
    stat := pool.Stat()
    return PoolStats{
        TotalConns:      stat.TotalConns(),
        AcquiredConns:   stat.AcquiredConns(),
        IdleConns:       stat.IdleConns(),
        MaxConns:        stat.MaxConns(),
        AcquireCount:    stat.AcquireCount(),
        AcquireDuration: stat.AcquireDuration(),
        EmptyAcquire:    stat.EmptyAcquireCount(),
    }
}
```

---

### Junior -> FAANG: Building Observability and Connection Pooling Intuition

Two things in this file will determine whether you look senior or junior in your first production incident: whether you understand connection pool exhaustion, and whether you have ever read a trace that linked a slow query to a slow HTTP response.

Connection pool exhaustion is the most common database-related production issue for new backend engineers. The symptom is requests timing out while the database appears healthy. The cause is all connections in the pool are held by in-flight requests, and new requests queue waiting for one to free. The config struct's `DBMaxOpenConns` and `DBConnMaxLifetime` fields directly control whether this happens. Default values from database drivers are almost never correct for production. Learn what your production pool stats look like under normal load before you need them during an incident.

For the observability config: the key first-job habit is to always deploy with `TracingEnabled: true` locally, even if the team only uses it in staging. If you develop with tracing off, you will not notice when your code creates nested spans that look fine in unit tests but show 200ms gaps in distributed traces in staging.

Interview framing for the `DashboardMetrics` struct: when asked "how would you instrument a WebSocket server?", walk through the same five categories shown here: HTTP, WebSocket, database, cache, and business metrics. Interviewers at senior-track FAANG roles expect you to know that business metrics (active dashboards, queries per second) are as important as infrastructure metrics. Most junior candidates only mention CPU and error rate.

### Senior @ FAANG: Configuration Governance and Observability Platform Standards

The config struct here encodes defaults that will be wrong for most production deployments. A staff engineer's concern is not the specific values. It is the governance process for how those values are chosen, documented, and kept current as load profiles change.

**Configuration as a first-class artifact:** The `DBMaxOpenConns: 25` default is borrowed from a reasonable starting point, but it has no documented basis in this codebase. A production-ready config system documents why each default was chosen: "25 open connections is appropriate for a single-instance deployment with a Postgres server allowing 100 total connections, leaving headroom for migrations, monitoring queries, and direct database access during incidents." When the deployment grows to 10 instances, that comment tells the operator they need to recalculate. Without it, the setting is cargo-culted indefinitely.

**Observability trifecta as a platform contract:** At FAANG, the three components initialized here (structured logging, distributed tracing, Prometheus metrics) are not wired up per service. They are provided as a platform library that every service imports. The platform library enforces naming conventions (service name in every log field, trace ID in every log line, metric name prefixed with the team namespace), sets default histograms buckets that align with organizational SLO definitions, and provides a single initialization call that wires all three together. A staff engineer's job is to design and maintain that library, not to implement tracing from scratch in each service.

**`GOMEMLIMIT` and GC tuning in production Go:** The comment about exposing GC tuning as environment variables is important and often skipped. Go's GC target heap percentage (`GOGC`) defaults to 100 (double the live heap), which is fine for latency-insensitive batch workloads but may cause tail latency spikes in a WebSocket server where GC pauses affect all in-flight message deliveries simultaneously. `GOMEMLIMIT` (available since Go 1.19) lets operators cap total memory usage and force more frequent, smaller GC cycles. At FAANG scale, these values are tuned per service based on heap profile data and encoded in Kubernetes resource limits. A staff engineer owns the documented policy for which services need tuned GC and what the tuning process looks like.

**Pool lifecycle hooks for tracing:** The `BeforeAcquire` and `AfterRelease` hooks are where distributed traces should be extended to show connection wait time. A request that spends 80ms waiting for a pool connection and only 5ms executing a query will show as a 5ms database call in naive tracing. With hooks that record the wait time in a span attribute, the trace shows the real cost. This distinction matters during incidents: a spike in connection wait time points to pool exhaustion, which points to either a traffic spike or a slow query holding connections longer than expected. Both have different mitigations, and the trace is how you tell them apart.
