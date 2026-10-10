## Part 1: Project Setup and Core Types

### Project Structure

The project structure establishes the layered package organization, handlers, services, repositories, domain, that enforces separation of concerns and prevents business logic from leaking into HTTP handler code. This architecture makes it straightforward to add new tenant-aware features without touching cross-cutting infrastructure.

```
gatewaygo/
├── cmd/
│   └── gateway/
│       └── main.go
├── internal/
│   ├── gateway/
│   │   ├── gateway.go
│   │   ├── server.go
│   │   └── config.go
│   ├── router/
│   │   ├── router.go
│   │   ├── matcher.go
│   │   └── trie.go
│   ├── upstream/
│   │   ├── upstream.go
│   │   ├── loadbalancer.go
│   │   └── healthcheck.go
│   ├── plugin/
│   │   ├── plugin.go
│   │   ├── chain.go
│   │   └── registry.go
│   ├── plugins/
│   │   ├── auth/
│   │   ├── ratelimit/
│   │   ├── transform/
│   │   ├── cors/
│   │   ├── cache/
│   │   └── circuit/
│   ├── admin/
│   │   └── api.go
│   ├── observability/
│   │   ├── logger.go
│   │   ├── metrics.go
│   │   └── tracing.go
│   └── config/
│       ├── loader.go
│       └── watcher.go
├── pkg/
│   └── middleware/
│       └── middleware.go
├── configs/
│   └── gateway.yaml
├── go.mod
└── go.sum
```

### Initial Setup Let's create the project structure and core types.

```
// go.mod
module github.com/yourusername/gatewaygo

go 1.27

require (
    github.com/golang-jwt/jwt/v5 v5.2.1
    github.com/go-chi/chi/v5 v5.2.0
    github.com/prometheus/client_golang v1.19.0
    go.opentelemetry.io/otel v1.24.0
    go.opentelemetry.io/otel/trace v1.24.0
    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.49.0
    go.uber.org/zap v1.27.0
    gopkg.in/yaml.v3 v3.0.1
    github.com/fsnotify/fsnotify v1.7.0
    golang.org/x/time v0.5.0
    github.com/redis/go-redis/v9 v9.5.1
    go.etcd.io/etcd/client/v3 v3.5.12
)
```

### Core Domain Types

The main entry point composes all application components, initializes dependencies in correct order, and starts the server. Graceful shutdown handling allows in-flight requests to complete and resources to be released cleanly when the process receives a termination signal.

```go
// internal/gateway/types.go
package gateway

import (
    "net/http"
    "time"
)

// Route represents a routing rule in the gateway
type Route struct {
    ID          string            `json:"id" yaml:"id"`
    Name        string            `json:"name" yaml:"name"`
    Paths       []string          `json:"paths" yaml:"paths"`
    Methods     []string          `json:"methods" yaml:"methods"`
    Hosts       []string          `json:"hosts,omitempty" yaml:"hosts,omitempty"`
    Headers     map[string]string `json:"headers,omitempty" yaml:"headers,omitempty"`
    UpstreamID  string            `json:"upstream_id" yaml:"upstream_id"`
    Plugins     []PluginConfig    `json:"plugins,omitempty" yaml:"plugins,omitempty"`
    StripPath   bool              `json:"strip_path" yaml:"strip_path"`
    PreserveHost bool             `json:"preserve_host" yaml:"preserve_host"`
    Priority    int               `json:"priority" yaml:"priority"`
    Enabled     bool              `json:"enabled" yaml:"enabled"`
    CreatedAt   time.Time         `json:"created_at" yaml:"created_at"`
    UpdatedAt   time.Time         `json:"updated_at" yaml:"updated_at"`
}

// Upstream represents a backend service
type Upstream struct {
    ID              string            `json:"id" yaml:"id"`
    Name            string            `json:"name" yaml:"name"`
    Targets         []Target          `json:"targets" yaml:"targets"`
    LoadBalanceType LoadBalanceType   `json:"load_balance_type" yaml:"load_balance_type"`
    HealthCheck     *HealthCheck      `json:"health_check,omitempty" yaml:"health_check,omitempty"`
    Timeout         time.Duration     `json:"timeout" yaml:"timeout"`
    Retries         int               `json:"retries" yaml:"retries"`
    CircuitBreaker  *CircuitBreaker   `json:"circuit_breaker,omitempty" yaml:"circuit_breaker,omitempty"`
    CreatedAt       time.Time         `json:"created_at" yaml:"created_at"`
    UpdatedAt       time.Time         `json:"updated_at" yaml:"updated_at"`
}

// Target represents a single backend server
type Target struct {
    ID       string            `json:"id" yaml:"id"`
    Host     string            `json:"host" yaml:"host"`
    Port     int               `json:"port" yaml:"port"`
    Weight   int               `json:"weight" yaml:"weight"`
    Metadata map[string]string `json:"metadata,omitempty" yaml:"metadata,omitempty"`
}

// LoadBalanceType defines the load balancing algorithm
type LoadBalanceType string

const (
    LoadBalanceRoundRobin      LoadBalanceType = "round_robin"
    LoadBalanceLeastConnection LoadBalanceType = "least_connection"
    LoadBalanceIPHash          LoadBalanceType = "ip_hash"
    LoadBalanceWeightedRandom  LoadBalanceType = "weighted_random"
    LoadBalanceConsistentHash  LoadBalanceType = "consistent_hash"
)

// HealthCheck configuration
type HealthCheck struct {
    Enabled         bool          `json:"enabled" yaml:"enabled"`
    Interval        time.Duration `json:"interval" yaml:"interval"`
    Timeout         time.Duration `json:"timeout" yaml:"timeout"`
    HealthyThreshold   int        `json:"healthy_threshold" yaml:"healthy_threshold"`
    UnhealthyThreshold int        `json:"unhealthy_threshold" yaml:"unhealthy_threshold"`
    HTTPPath        string        `json:"http_path,omitempty" yaml:"http_path,omitempty"`
    HTTPMethod      string        `json:"http_method,omitempty" yaml:"http_method,omitempty"`
    ExpectedStatus  []int         `json:"expected_status,omitempty" yaml:"expected_status,omitempty"`
}

// CircuitBreaker configuration
type CircuitBreaker struct {
    Enabled              bool          `json:"enabled" yaml:"enabled"`
    ErrorThreshold       int           `json:"error_threshold" yaml:"error_threshold"`
    SuccessThreshold     int           `json:"success_threshold" yaml:"success_threshold"`
    Timeout              time.Duration `json:"timeout" yaml:"timeout"`
    HalfOpenMaxRequests  int           `json:"half_open_max_requests" yaml:"half_open_max_requests"`
}

// PluginConfig represents plugin configuration
type PluginConfig struct {
    Name    string                 `json:"name" yaml:"name"`
    Enabled bool                   `json:"enabled" yaml:"enabled"`
    Config  map[string]any `json:"config,omitempty" yaml:"config,omitempty"`
}

// Plugin context passed to plugins
type PluginContext struct {
    Request  *http.Request
    Response http.ResponseWriter
    Route    *Route
    Upstream *Upstream
    Metadata map[string]any
}
```

### Configuration Structure

The following configuration defines the deployment parameters for Configuration Structure, including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```go
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
```

### Example Configuration File

The following configuration defines the deployment parameters for Example Configuration File, including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```yaml
# configs/gateway.yaml
server:
  host: 0.0.0.0
  port: 8080
  read_timeout: 30s
  write_timeout: 30s
  idle_timeout: 120s
  max_header_bytes: 1048576
  shutdown_timeout: 30s

admin:
  enabled: true
  host: 127.0.0.1
  port: 9090
  api_key: "your-secret-admin-key"

logging:
  level: info
  format: json
  output: stdout
  access_log: true

metrics:
  enabled: true
  path: /metrics
  namespace: gatewaygo

tracing:
  enabled: true
  provider: jaeger
  endpoint: http://localhost:14268/api/traces
  sampling_rate: 0.1

# Global plugins applied to all routes
global_plugins:
  - name: request_id
    enabled: true
  - name: access_log
    enabled: true
  - name: prometheus
    enabled: true

# Route definitions
routes:
  - id: api-v1
    name: "API v1 Routes"
    paths:
      - /api/v1/*
    methods:
      - GET
      - POST
      - PUT
      - DELETE
    upstream_id: api-backend-v1
    strip_path: false
    preserve_host: false
    priority: 100
    enabled: true
    plugins:
      - name: jwt_auth
        enabled: true
        config:
          secret: "your-jwt-secret"
          algorithm: HS256
      - name: rate_limit
        enabled: true
        config:
          requests_per_second: 100
          burst: 200
      - name: cors
        enabled: true
        config:
          allow_origins:
            - "*"
          allow_methods:
            - GET
            - POST
            - PUT
            - DELETE
          allow_headers:
            - Authorization
            - Content-Type

  - id: websocket-route
    name: "WebSocket Route"
    paths:
      - /ws
    upstream_id: websocket-backend
    strip_path: true
    preserve_host: true
    priority: 200
    enabled: true

  - id: grpc-route
    name: "gRPC Route"
    paths:
      - /grpc/*
    upstream_id: grpc-backend
    strip_path: false
    priority: 150
    enabled: true
    plugins:
      - name: grpc_web
        enabled: true

# Upstream definitions
upstreams:
  - id: api-backend-v1
    name: "API Backend v1"
    load_balance_type: round_robin
    timeout: 30s
    retries: 3
    targets:
      - id: target-1
        host: localhost
        port: 8081
        weight: 100
      - id: target-2
        host: localhost
        port: 8082
        weight: 100
      - id: target-3
        host: localhost
        port: 8083
        weight: 100
    health_check:
      enabled: true
      interval: 10s
      timeout: 5s
      healthy_threshold: 2
      unhealthy_threshold: 3
      http_path: /health
      http_method: GET
      expected_status:
        - 200
    circuit_breaker:
      enabled: true
      error_threshold: 50
      success_threshold: 5
      timeout: 60s
      half_open_max_requests: 3

  - id: websocket-backend
    name: "WebSocket Backend"
    load_balance_type: ip_hash
    timeout: 60s
    retries: 1
    targets:
      - id: ws-target-1
        host: localhost
        port: 8091
        weight: 100

  - id: grpc-backend
    name: "gRPC Backend"
    load_balance_type: least_connection
    timeout: 30s
    retries: 3
    targets:
      - id: grpc-target-1
        host: localhost
        port: 9000
        weight: 100
      - id: grpc-target-2
        host: localhost
        port: 9001
        weight: 100

tls:
  enabled: false
  cert_file: /path/to/cert.pem
  key_file: /path/to/key.pem
  min_version: "1.2"
```
