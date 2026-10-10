// internal/gateway/types.go
package gateway

import (
	"net/http"

	"github.com/example/api-gateway/internal/router"
	"github.com/example/api-gateway/internal/upstream"
)

// Route is an alias for router.Route to avoid import cycles
type Route = router.Route

// PluginConfig is an alias for router.PluginConfig
type PluginConfig = router.PluginConfig

// Upstream is an alias for upstream.UpstreamConfig
type Upstream = upstream.UpstreamConfig

// Target is an alias for upstream.Target
type Target = upstream.Target

// LoadBalanceType is an alias for upstream.LoadBalanceType
type LoadBalanceType = upstream.LoadBalanceType

// HealthCheck is an alias for upstream.HealthCheckConfig
type HealthCheck = upstream.HealthCheckConfig

// CircuitBreaker is an alias for upstream.CircuitBreakerConfig
type CircuitBreaker = upstream.CircuitBreakerConfig

const (
	LoadBalanceRoundRobin      = upstream.LoadBalanceRoundRobin
	LoadBalanceLeastConnection = upstream.LoadBalanceLeastConnection
	LoadBalanceIPHash          = upstream.LoadBalanceIPHash
	LoadBalanceWeightedRandom  = upstream.LoadBalanceWeightedRandom
	LoadBalanceConsistentHash  = upstream.LoadBalanceConsistentHash
)

// PluginContext passed to plugins
type PluginContext struct {
	Request  *http.Request
	Response http.ResponseWriter
	Route    *Route
	Upstream *Upstream
	Metadata map[string]any
}
