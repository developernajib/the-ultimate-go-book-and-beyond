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
