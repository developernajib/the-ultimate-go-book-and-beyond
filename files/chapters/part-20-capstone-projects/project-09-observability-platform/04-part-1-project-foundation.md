## Part 1: Project Foundation

Every observability platform starts with a solid foundation of shared types, configuration loading, and error handling. These foundational pieces are used by every other layer in the system, so getting them right early prevents painful refactors later. In this part, you will define the core domain models for metrics, logs, and traces, set up YAML-based configuration management with sensible defaults, and create a structured error handling package.

### 1.1 Core Domain Models

The domain models define the data structures that flow through the entire platform. Metrics carry numeric values with labels and timestamps, logs carry structured text with severity levels, and traces carry timing data across service boundaries. Each model includes a `TenantID` field because multi-tenancy is baked in from the start rather than bolted on later. Notice how the `Labels` type implements Go's `sort.Interface` so that label sets can be consistently hashed regardless of insertion order.

```go
// pkg/models/metric.go
package models

import (
    "fmt"
    "sort"
    "strings"
    "time"
)

// MetricType represents the type of metric
type MetricType int

const (
    MetricTypeGauge MetricType = iota
    MetricTypeCounter
    MetricTypeHistogram
    MetricTypeSummary
)

func (mt MetricType) String() string {
    switch mt {
    case MetricTypeGauge:
        return "gauge"
    case MetricTypeCounter:
        return "counter"
    case MetricTypeHistogram:
        return "histogram"
    case MetricTypeSummary:
        return "summary"
    default:
        return "unknown"
    }
}

// Label represents a key-value label
type Label struct {
    Name  string
    Value string
}

// Labels is a sortable slice of labels
type Labels []Label

func (l Labels) Len() int           { return len(l) }
func (l Labels) Less(i, j int) bool { return l[i].Name < l[j].Name }
func (l Labels) Swap(i, j int)      { l[i], l[j] = l[j], l[i] }

// Hash returns a consistent hash for the label set
func (l Labels) Hash() string {
    if len(l) == 0 {
        return ""
    }

    // Sort labels for consistent hashing
    sorted := make(Labels, len(l))
    copy(sorted, l)
    sort.Sort(sorted)

    var builder strings.Builder
    for i, label := range sorted {
        if i > 0 {
            builder.WriteByte(',')
        }
        builder.WriteString(label.Name)
        builder.WriteByte('=')
        builder.WriteString(label.Value)
    }
    return builder.String()
}

// Get returns the value for a label name
func (l Labels) Get(name string) (string, bool) {
    for _, label := range l {
        if label.Name == name {
            return label.Value, true
        }
    }
    return "", false
}

// Metric represents a single metric data point
type Metric struct {
    Name      string
    Type      MetricType
    Labels    Labels
    Timestamp time.Time
    Value     float64

    // For histograms
    Buckets []Bucket
    Count   uint64
    Sum     float64

    // For summaries
    Quantiles []Quantile

    // Metadata
    TenantID string
}

// Bucket represents a histogram bucket
type Bucket struct {
    UpperBound float64
    Count      uint64
}

// Quantile represents a summary quantile
type Quantile struct {
    Quantile float64
    Value    float64
}

// MetricFamily groups metrics by name
type MetricFamily struct {
    Name    string
    Type    MetricType
    Help    string
    Metrics []Metric
}

// Sample represents a time-series sample
type Sample struct {
    Timestamp time.Time
    Value     float64
}

// Series represents a time series
type Series struct {
    Labels  Labels
    Samples []Sample
}

// String returns a string representation of the metric
func (m *Metric) String() string {
    return fmt.Sprintf("%s%s %f @%d", m.Name, m.Labels.Hash(), m.Value, m.Timestamp.Unix())
}

// Clone creates a deep copy of the metric
func (m *Metric) Clone() *Metric {
    clone := &Metric{
        Name:      m.Name,
        Type:      m.Type,
        Labels:    make(Labels, len(m.Labels)),
        Timestamp: m.Timestamp,
        Value:     m.Value,
        Count:     m.Count,
        Sum:       m.Sum,
        TenantID:  m.TenantID,
    }

    copy(clone.Labels, m.Labels)

    if len(m.Buckets) > 0 {
        clone.Buckets = make([]Bucket, len(m.Buckets))
        copy(clone.Buckets, m.Buckets)
    }

    if len(m.Quantiles) > 0 {
        clone.Quantiles = make([]Quantile, len(m.Quantiles))
        copy(clone.Quantiles, m.Quantiles)
    }

    return clone
}
```

```go
// pkg/models/log.go
package models

import (
    "encoding/json"
    "time"
)

// LogLevel represents log severity
type LogLevel int

const (
    LogLevelDebug LogLevel = iota
    LogLevelInfo
    LogLevelWarn
    LogLevelError
    LogLevelFatal
)

func (l LogLevel) String() string {
    switch l {
    case LogLevelDebug:
        return "debug"
    case LogLevelInfo:
        return "info"
    case LogLevelWarn:
        return "warn"
    case LogLevelError:
        return "error"
    case LogLevelFatal:
        return "fatal"
    default:
        return "unknown"
    }
}

// ParseLogLevel parses a log level string
func ParseLogLevel(s string) LogLevel {
    switch s {
    case "debug", "DEBUG":
        return LogLevelDebug
    case "info", "INFO":
        return LogLevelInfo
    case "warn", "WARN", "warning", "WARNING":
        return LogLevelWarn
    case "error", "ERROR":
        return LogLevelError
    case "fatal", "FATAL":
        return LogLevelFatal
    default:
        return LogLevelInfo
    }
}

// LogEntry represents a single log entry
type LogEntry struct {
    // Core fields
    Timestamp time.Time
    Level     LogLevel
    Message   string

    // Source information
    Host      string
    Service   string
    Container string
    Pod       string
    Namespace string

    // Structured fields
    Fields map[string]any

    // Labels for indexing
    Labels Labels

    // Trace context
    TraceID string
    SpanID  string

    // Metadata
    TenantID string
}

// Clone creates a deep copy of the log entry
func (l *LogEntry) Clone() *LogEntry {
    clone := &LogEntry{
        Timestamp: l.Timestamp,
        Level:     l.Level,
        Message:   l.Message,
        Host:      l.Host,
        Service:   l.Service,
        Container: l.Container,
        Pod:       l.Pod,
        Namespace: l.Namespace,
        TraceID:   l.TraceID,
        SpanID:    l.SpanID,
        TenantID:  l.TenantID,
        Labels:    make(Labels, len(l.Labels)),
        Fields:    make(map[string]any),
    }

    copy(clone.Labels, l.Labels)

    for k, v := range l.Fields {
        clone.Fields[k] = v
    }

    return clone
}

// ToJSON serializes the log entry to JSON
func (l *LogEntry) ToJSON() ([]byte, error) {
    return json.Marshal(l)
}

// LogQuery represents a log query
type LogQuery struct {
    StartTime time.Time
    EndTime   time.Time

    // Filter criteria
    Level      *LogLevel
    Service    string
    Host       string
    Namespace  string
    Labels     Labels

    // Full-text search
    SearchQuery string

    // Trace filtering
    TraceID string

    // Pagination
    Limit  int
    Offset int

    // Tenant
    TenantID string
}

// LogQueryResult represents query results
type LogQueryResult struct {
    Entries    []*LogEntry
    TotalCount int64
    HasMore    bool
}
```

```go
// pkg/models/trace.go
package models

import (
    "time"
)

// SpanKind represents the span type
type SpanKind int

const (
    SpanKindInternal SpanKind = iota
    SpanKindServer
    SpanKindClient
    SpanKindProducer
    SpanKindConsumer
)

func (sk SpanKind) String() string {
    switch sk {
    case SpanKindInternal:
        return "internal"
    case SpanKindServer:
        return "server"
    case SpanKindClient:
        return "client"
    case SpanKindProducer:
        return "producer"
    case SpanKindConsumer:
        return "consumer"
    default:
        return "unknown"
    }
}

// SpanStatus represents span completion status
type SpanStatus int

const (
    SpanStatusUnset SpanStatus = iota
    SpanStatusOk
    SpanStatusError
)

// Span represents a distributed trace span
type Span struct {
    // Identity
    TraceID  string
    SpanID   string
    ParentID string

    // Timing
    StartTime time.Time
    EndTime   time.Time
    Duration  time.Duration

    // Description
    Name        string
    Kind        SpanKind
    Status      SpanStatus
    StatusMsg   string

    // Service info
    ServiceName string

    // Attributes
    Attributes map[string]any

    // Resource attributes
    Resource map[string]any

    // Events
    Events []SpanEvent

    // Links
    Links []SpanLink

    // Metadata
    TenantID string
}

// SpanEvent represents an event within a span
type SpanEvent struct {
    Timestamp  time.Time
    Name       string
    Attributes map[string]any
}

// SpanLink represents a link to another span
type SpanLink struct {
    TraceID    string
    SpanID     string
    Attributes map[string]any
}

// Trace represents a complete trace (collection of spans)
type Trace struct {
    TraceID     string
    RootSpan    *Span
    Spans       []*Span
    ServiceMap  map[string]bool
    StartTime   time.Time
    EndTime     time.Time
    Duration    time.Duration
    SpanCount   int
    ErrorCount  int
    TenantID    string
}

// TraceQuery represents a trace query
type TraceQuery struct {
    StartTime time.Time
    EndTime   time.Time

    // Filter criteria
    ServiceName string
    Operation   string
    MinDuration time.Duration
    MaxDuration time.Duration
    Status      *SpanStatus

    // Tag filtering
    Tags map[string]string

    // Pagination
    Limit  int
    Offset int

    // Tenant
    TenantID string
}

// ServiceDependency represents a service-to-service dependency
type ServiceDependency struct {
    Parent      string
    Child       string
    CallCount   int64
    ErrorCount  int64
    AvgDuration time.Duration
}
```

### 1.2 Configuration Management

A production observability platform has dozens of knobs to tune, from ingestion buffer sizes to storage retention periods. This configuration module loads settings from a YAML file, applies sensible defaults for anything not specified, and validates that the resulting configuration is coherent. By centralizing all configuration into a single typed struct, you make it easy to discover what options exist and ensure that typos are caught at startup rather than at runtime.

```go
// pkg/config/config.go
package config

import (
    "fmt"
    "os"
    "time"

    "gopkg.in/yaml.v3"
)

// Config represents the complete platform configuration
type Config struct {
    Server     ServerConfig     `yaml:"server"`
    Ingestion  IngestionConfig  `yaml:"ingestion"`
    Storage    StorageConfig    `yaml:"storage"`
    Query      QueryConfig      `yaml:"query"`
    Alerting   AlertingConfig   `yaml:"alerting"`
    Dashboard  DashboardConfig  `yaml:"dashboard"`
    Auth       AuthConfig       `yaml:"auth"`
    Retention  RetentionConfig  `yaml:"retention"`
}

// ServerConfig configures the main server
type ServerConfig struct {
    HTTPAddr    string        `yaml:"http_addr"`
    GRPCAddr    string        `yaml:"grpc_addr"`
    MetricsAddr string        `yaml:"metrics_addr"`
    TLSEnabled  bool          `yaml:"tls_enabled"`
    TLSCertFile string        `yaml:"tls_cert_file"`
    TLSKeyFile  string        `yaml:"tls_key_file"`
    GracefulTimeout time.Duration `yaml:"graceful_timeout"`
}

// IngestionConfig configures data ingestion
type IngestionConfig struct {
    OTLP       OTLPConfig       `yaml:"otlp"`
    Prometheus PrometheusConfig `yaml:"prometheus"`
    StatsD     StatsDConfig     `yaml:"statsd"`
    Logs       LogsConfig       `yaml:"logs"`

    // Processing
    Workers         int           `yaml:"workers"`
    BufferSize      int           `yaml:"buffer_size"`
    FlushInterval   time.Duration `yaml:"flush_interval"`
    MaxBatchSize    int           `yaml:"max_batch_size"`
}

// OTLPConfig configures OpenTelemetry Protocol receiver
type OTLPConfig struct {
    Enabled   bool   `yaml:"enabled"`
    GRPCAddr  string `yaml:"grpc_addr"`
    HTTPAddr  string `yaml:"http_addr"`
}

// PrometheusConfig configures Prometheus scraping
type PrometheusConfig struct {
    Enabled       bool          `yaml:"enabled"`
    ScrapeInterval time.Duration `yaml:"scrape_interval"`
    ScrapeTimeout  time.Duration `yaml:"scrape_timeout"`
    ConfigFile     string        `yaml:"config_file"`
}

// StatsDConfig configures StatsD receiver
type StatsDConfig struct {
    Enabled  bool   `yaml:"enabled"`
    UDPAddr  string `yaml:"udp_addr"`
    TCPAddr  string `yaml:"tcp_addr"`
}

// LogsConfig configures log collection
type LogsConfig struct {
    Enabled       bool     `yaml:"enabled"`
    SyslogAddr    string   `yaml:"syslog_addr"`
    FilePaths     []string `yaml:"file_paths"`
    ParseJSON     bool     `yaml:"parse_json"`
}

// StorageConfig configures storage backends
type StorageConfig struct {
    Metrics    MetricsStorageConfig    `yaml:"metrics"`
    Logs       LogsStorageConfig       `yaml:"logs"`
    Traces     TracesStorageConfig     `yaml:"traces"`
    LongTerm   LongTermStorageConfig   `yaml:"long_term"`
}

// MetricsStorageConfig configures metrics storage
type MetricsStorageConfig struct {
    Type           string        `yaml:"type"` // "prometheus", "victoriametrics"
    Path           string        `yaml:"path"`
    RetentionTime  time.Duration `yaml:"retention_time"`
    WALCompression bool          `yaml:"wal_compression"`
    MaxBlockSize   int64         `yaml:"max_block_size"`
}

// LogsStorageConfig configures logs storage
type LogsStorageConfig struct {
    Type          string `yaml:"type"` // "clickhouse", "elasticsearch"
    DSN           string `yaml:"dsn"`
    Database      string `yaml:"database"`
    Table         string `yaml:"table"`
    Replicas      int    `yaml:"replicas"`
    Shards        int    `yaml:"shards"`
}

// TracesStorageConfig configures traces storage
type TracesStorageConfig struct {
    Type          string `yaml:"type"` // "clickhouse", "cassandra"
    DSN           string `yaml:"dsn"`
    Database      string `yaml:"database"`
    SpansTable    string `yaml:"spans_table"`
    IndexTable    string `yaml:"index_table"`
}

// LongTermStorageConfig configures long-term storage (S3, GCS, etc.)
type LongTermStorageConfig struct {
    Enabled    bool   `yaml:"enabled"`
    Type       string `yaml:"type"` // "s3", "gcs", "azure"
    Bucket     string `yaml:"bucket"`
    Prefix     string `yaml:"prefix"`
    Region     string `yaml:"region"`
    Endpoint   string `yaml:"endpoint"`
}

// QueryConfig configures query engine
type QueryConfig struct {
    MaxConcurrentQueries int           `yaml:"max_concurrent_queries"`
    QueryTimeout         time.Duration `yaml:"query_timeout"`
    MaxSamples           int           `yaml:"max_samples"`
    CacheEnabled         bool          `yaml:"cache_enabled"`
    CacheTTL             time.Duration `yaml:"cache_ttl"`
}

// AlertingConfig configures alerting
type AlertingConfig struct {
    Enabled           bool          `yaml:"enabled"`
    RulesFile         string        `yaml:"rules_file"`
    EvaluationInterval time.Duration `yaml:"evaluation_interval"`
    Notifiers         []NotifierConfig `yaml:"notifiers"`
}

// NotifierConfig configures alert notifiers
type NotifierConfig struct {
    Type   string                 `yaml:"type"` // "email", "slack", "pagerduty"
    Config map[string]any `yaml:"config"`
}

// DashboardConfig configures dashboard service
type DashboardConfig struct {
    Enabled     bool   `yaml:"enabled"`
    StorageType string `yaml:"storage_type"` // "sqlite", "postgres"
    DSN         string `yaml:"dsn"`
}

// AuthConfig configures authentication
type AuthConfig struct {
    Enabled      bool   `yaml:"enabled"`
    Type         string `yaml:"type"` // "basic", "jwt", "oauth"
    JWTSecret    string `yaml:"jwt_secret"`
    TokenExpiry  time.Duration `yaml:"token_expiry"`
}

// RetentionConfig configures data retention
type RetentionConfig struct {
    Metrics RetentionPolicy `yaml:"metrics"`
    Logs    RetentionPolicy `yaml:"logs"`
    Traces  RetentionPolicy `yaml:"traces"`
}

// RetentionPolicy defines retention rules
type RetentionPolicy struct {
    RawData        time.Duration `yaml:"raw_data"`
    Downsampled5m  time.Duration `yaml:"downsampled_5m"`
    Downsampled1h  time.Duration `yaml:"downsampled_1h"`
}

// LoadConfig loads configuration from file
func LoadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("reading config file: %w", err)
    }

    var cfg Config
    if err := yaml.Unmarshal(data, &cfg); err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    // Set defaults
    cfg.setDefaults()

    // Validate
    if err := cfg.Validate(); err != nil {
        return nil, fmt.Errorf("validating config: %w", err)
    }

    return &cfg, nil
}

// setDefaults sets default values for unspecified config
func (c *Config) setDefaults() {
    if c.Server.HTTPAddr == "" {
        c.Server.HTTPAddr = ":8080"
    }
    if c.Server.GRPCAddr == "" {
        c.Server.GRPCAddr = ":9090"
    }
    if c.Server.GracefulTimeout == 0 {
        c.Server.GracefulTimeout = 30 * time.Second
    }

    if c.Ingestion.Workers == 0 {
        c.Ingestion.Workers = 10
    }
    if c.Ingestion.BufferSize == 0 {
        c.Ingestion.BufferSize = 10000
    }
    if c.Ingestion.FlushInterval == 0 {
        c.Ingestion.FlushInterval = 10 * time.Second
    }
    if c.Ingestion.MaxBatchSize == 0 {
        c.Ingestion.MaxBatchSize = 1000
    }

    if c.Query.MaxConcurrentQueries == 0 {
        c.Query.MaxConcurrentQueries = 20
    }
    if c.Query.QueryTimeout == 0 {
        c.Query.QueryTimeout = 2 * time.Minute
    }
    if c.Query.MaxSamples == 0 {
        c.Query.MaxSamples = 50000000
    }

    if c.Storage.Metrics.RetentionTime == 0 {
        c.Storage.Metrics.RetentionTime = 15 * 24 * time.Hour // 15 days
    }
}

// Validate validates the configuration
func (c *Config) Validate() error {
    if c.Server.HTTPAddr == "" {
        return fmt.Errorf("server.http_addr is required")
    }

    if c.Server.TLSEnabled {
        if c.Server.TLSCertFile == "" || c.Server.TLSKeyFile == "" {
            return fmt.Errorf("TLS cert and key files required when TLS enabled")
        }
    }

    if c.Ingestion.Workers <= 0 {
        return fmt.Errorf("ingestion.workers must be positive")
    }

    return nil
}
```

### 1.3 Error Handling

Observability platforms deal with data from many sources, so errors are frequent and varied: a malformed metric from one application should not crash ingestion for all others. This error package defines typed errors with severity levels and context, making it possible to distinguish between retryable transient failures and permanent validation errors. Wrapping errors with consistent types also makes it straightforward to expose meaningful error messages through the API without leaking internal details.

```go
// pkg/errors/errors.go
package errors

import (
    "errors"
    "fmt"
)

// Common error types
var (
    ErrNotFound          = errors.New("not found")
    ErrAlreadyExists     = errors.New("already exists")
    ErrInvalidInput      = errors.New("invalid input")
    ErrUnauthorized      = errors.New("unauthorized")
    ErrForbidden         = errors.New("forbidden")
    ErrTooManyRequests   = errors.New("too many requests")
    ErrInternal          = errors.New("internal error")
    ErrTimeout           = errors.New("timeout")
    ErrUnavailable       = errors.New("service unavailable")
    ErrQuotaExceeded     = errors.New("quota exceeded")
)

// ObservabilityError wraps errors with context
type ObservabilityError struct {
    Op      string // Operation that failed
    Kind    error  // Error kind
    Err     error  // Underlying error
    Context map[string]any // Additional context
}

func (e *ObservabilityError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("%s: %v: %v", e.Op, e.Kind, e.Err)
    }
    return fmt.Sprintf("%s: %v", e.Op, e.Kind)
}

func (e *ObservabilityError) Unwrap() error {
    return e.Err
}

// E constructs an ObservabilityError
func E(op string, kind error, err error, context ...map[string]any) error {
    e := &ObservabilityError{
        Op:   op,
        Kind: kind,
        Err:  err,
    }

    if len(context) > 0 {
        e.Context = context[0]
    }

    return e
}

// IsNotFound checks if error is not found
func IsNotFound(err error) bool {
    return errors.Is(err, ErrNotFound)
}

// IsUnauthorized checks if error is unauthorized
func IsUnauthorized(err error) bool {
    return errors.Is(err, ErrUnauthorized)
}

// IsQuotaExceeded checks if error is quota exceeded
func IsQuotaExceeded(err error) bool {
    return errors.Is(err, ErrQuotaExceeded)
}
```
