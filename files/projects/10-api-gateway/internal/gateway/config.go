// internal/gateway/config.go
package gateway

import (
    "fmt"
    "os"
    "time"

    "gopkg.in/yaml.v3"
)

// Config represents the complete gateway configuration
type Config struct {
    Server      ServerConfig      `yaml:"server"`
    Admin       AdminConfig       `yaml:"admin"`
    Routes      []Route           `yaml:"routes"`
    Upstreams   []Upstream        `yaml:"upstreams"`
    GlobalPlugins []PluginConfig  `yaml:"global_plugins,omitempty"`
    Logging     LoggingConfig     `yaml:"logging"`
    Metrics     MetricsConfig     `yaml:"metrics"`
    Tracing     TracingConfig     `yaml:"tracing,omitempty"`
    TLS         *TLSConfig        `yaml:"tls,omitempty"`
}

// ServerConfig configures the main gateway server
type ServerConfig struct {
    Host            string        `yaml:"host"`
    Port            int           `yaml:"port"`
    ReadTimeout     time.Duration `yaml:"read_timeout"`
    WriteTimeout    time.Duration `yaml:"write_timeout"`
    IdleTimeout     time.Duration `yaml:"idle_timeout"`
    MaxHeaderBytes  int           `yaml:"max_header_bytes"`
    ShutdownTimeout time.Duration `yaml:"shutdown_timeout"`
}

// AdminConfig configures the admin API
type AdminConfig struct {
    Enabled bool   `yaml:"enabled"`
    Host    string `yaml:"host"`
    Port    int    `yaml:"port"`
    APIKey  string `yaml:"api_key,omitempty"`
}

// LoggingConfig configures logging
type LoggingConfig struct {
    Level      string `yaml:"level"`
    Format     string `yaml:"format"` // json or console
    Output     string `yaml:"output"` // stdout, stderr, or file path
    AccessLog  bool   `yaml:"access_log"`
}

// MetricsConfig configures metrics collection
type MetricsConfig struct {
    Enabled   bool   `yaml:"enabled"`
    Path      string `yaml:"path"`
    Namespace string `yaml:"namespace"`
}

// TracingConfig configures distributed tracing
type TracingConfig struct {
    Enabled      bool    `yaml:"enabled"`
    Provider     string  `yaml:"provider"` // jaeger, zipkin, otlp
    Endpoint     string  `yaml:"endpoint"`
    SamplingRate float64 `yaml:"sampling_rate"`
}

// TLSConfig configures TLS termination
type TLSConfig struct {
    Enabled     bool     `yaml:"enabled"`
    CertFile    string   `yaml:"cert_file"`
    KeyFile     string   `yaml:"key_file"`
    ClientAuth  string   `yaml:"client_auth,omitempty"` // none, request, require
    CACertFile  string   `yaml:"ca_cert_file,omitempty"`
    MinVersion  string   `yaml:"min_version,omitempty"`
    CipherSuites []string `yaml:"cipher_suites,omitempty"`
}

// LoadConfig loads configuration from a YAML file
func LoadConfig(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("read config file: %w", err)
    }

    var config Config
    if err := yaml.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("parse config: %w", err)
    }

    // Set defaults
    if err := setDefaults(&config); err != nil {
        return nil, fmt.Errorf("set defaults: %w", err)
    }

    // Validate configuration
    if err := validateConfig(&config); err != nil {
        return nil, fmt.Errorf("validate config: %w", err)
    }

    return &config, nil
}

func setDefaults(config *Config) error {
    // Server defaults
    if config.Server.Host == "" {
        config.Server.Host = "0.0.0.0"
    }
    if config.Server.Port == 0 {
        config.Server.Port = 8080
    }
    if config.Server.ReadTimeout == 0 {
        config.Server.ReadTimeout = 30 * time.Second
    }
    if config.Server.WriteTimeout == 0 {
        config.Server.WriteTimeout = 30 * time.Second
    }
    if config.Server.IdleTimeout == 0 {
        config.Server.IdleTimeout = 120 * time.Second
    }
    if config.Server.ShutdownTimeout == 0 {
        config.Server.ShutdownTimeout = 30 * time.Second
    }
    if config.Server.MaxHeaderBytes == 0 {
        config.Server.MaxHeaderBytes = 1 << 20 // 1 MB
    }

    // Admin defaults
    if config.Admin.Enabled && config.Admin.Port == 0 {
        config.Admin.Port = 9090
    }
    if config.Admin.Host == "" {
        config.Admin.Host = "127.0.0.1"
    }

    // Logging defaults
    if config.Logging.Level == "" {
        config.Logging.Level = "info"
    }
    if config.Logging.Format == "" {
        config.Logging.Format = "json"
    }
    if config.Logging.Output == "" {
        config.Logging.Output = "stdout"
    }

    // Metrics defaults
    if config.Metrics.Path == "" {
        config.Metrics.Path = "/metrics"
    }
    if config.Metrics.Namespace == "" {
        config.Metrics.Namespace = "gatewaygo"
    }

    // Set route defaults
    for i := range config.Routes {
        if config.Routes[i].ID == "" {
            config.Routes[i].ID = fmt.Sprintf("route-%d", i)
        }
        if !config.Routes[i].Enabled {
            config.Routes[i].Enabled = true
        }
        if config.Routes[i].CreatedAt.IsZero() {
            config.Routes[i].CreatedAt = time.Now()
        }
        if config.Routes[i].UpdatedAt.IsZero() {
            config.Routes[i].UpdatedAt = time.Now()
        }
    }

    // Set upstream defaults
    for i := range config.Upstreams {
        if config.Upstreams[i].ID == "" {
            config.Upstreams[i].ID = fmt.Sprintf("upstream-%d", i)
        }
        if config.Upstreams[i].LoadBalanceType == "" {
            config.Upstreams[i].LoadBalanceType = LoadBalanceRoundRobin
        }
        if config.Upstreams[i].Timeout == 0 {
            config.Upstreams[i].Timeout = 30 * time.Second
        }
        if config.Upstreams[i].Retries == 0 {
            config.Upstreams[i].Retries = 3
        }

        // Set target defaults
        for j := range config.Upstreams[i].Targets {
            if config.Upstreams[i].Targets[j].ID == "" {
                config.Upstreams[i].Targets[j].ID = fmt.Sprintf("target-%d-%d", i, j)
            }
            if config.Upstreams[i].Targets[j].Weight == 0 {
                config.Upstreams[i].Targets[j].Weight = 100
            }
        }

        // Health check defaults
        if hc := config.Upstreams[i].HealthCheck; hc != nil && hc.Enabled {
            if hc.Interval == 0 {
                hc.Interval = 10 * time.Second
            }
            if hc.Timeout == 0 {
                hc.Timeout = 5 * time.Second
            }
            if hc.HealthyThreshold == 0 {
                hc.HealthyThreshold = 2
            }
            if hc.UnhealthyThreshold == 0 {
                hc.UnhealthyThreshold = 3
            }
            if hc.HTTPPath == "" {
                hc.HTTPPath = "/health"
            }
            if hc.HTTPMethod == "" {
                hc.HTTPMethod = "GET"
            }
            if len(hc.ExpectedStatus) == 0 {
                hc.ExpectedStatus = []int{200}
            }
        }
    }

    return nil
}

func validateConfig(config *Config) error {
    if config.Server.Port < 1 || config.Server.Port > 65535 {
        return fmt.Errorf("invalid server port: %d", config.Server.Port)
    }

    if config.Admin.Enabled {
        if config.Admin.Port < 1 || config.Admin.Port > 65535 {
            return fmt.Errorf("invalid admin port: %d", config.Admin.Port)
        }
        if config.Admin.Port == config.Server.Port {
            return fmt.Errorf("admin port cannot be same as server port")
        }
    }

    // Validate routes
    upstreamIDs := make(map[string]bool)
    for _, upstream := range config.Upstreams {
        upstreamIDs[upstream.ID] = true
    }

    for _, route := range config.Routes {
        if len(route.Paths) == 0 {
            return fmt.Errorf("route %s has no paths", route.ID)
        }
        if route.UpstreamID == "" {
            return fmt.Errorf("route %s has no upstream_id", route.ID)
        }
        if !upstreamIDs[route.UpstreamID] {
            return fmt.Errorf("route %s references non-existent upstream: %s", route.ID, route.UpstreamID)
        }
    }

    // Validate upstreams
    for _, upstream := range config.Upstreams {
        if len(upstream.Targets) == 0 {
            return fmt.Errorf("upstream %s has no targets", upstream.ID)
        }
        for _, target := range upstream.Targets {
            if target.Host == "" {
                return fmt.Errorf("target %s in upstream %s has no host", target.ID, upstream.ID)
            }
            if target.Port < 1 || target.Port > 65535 {
                return fmt.Errorf("target %s has invalid port: %d", target.ID, target.Port)
            }
        }
    }

    return nil
}
