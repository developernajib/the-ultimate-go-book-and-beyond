// internal/upstream/upstream.go
package upstream

import (
	"context"
	"fmt"
	"net/http/httputil"
	"sync"
	"sync/atomic"
	"time"
)

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

// HealthCheckConfig represents health check configuration
type HealthCheckConfig struct {
	Enabled             bool          `json:"enabled" yaml:"enabled"`
	Interval            time.Duration `json:"interval" yaml:"interval"`
	Timeout             time.Duration `json:"timeout" yaml:"timeout"`
	HealthyThreshold    int           `json:"healthy_threshold" yaml:"healthy_threshold"`
	UnhealthyThreshold  int           `json:"unhealthy_threshold" yaml:"unhealthy_threshold"`
	HTTPPath            string        `json:"http_path,omitempty" yaml:"http_path,omitempty"`
	HTTPMethod          string        `json:"http_method,omitempty" yaml:"http_method,omitempty"`
	ExpectedStatus      []int         `json:"expected_status,omitempty" yaml:"expected_status,omitempty"`
}

// CircuitBreakerConfig represents circuit breaker configuration
type CircuitBreakerConfig struct {
	Enabled             bool          `json:"enabled" yaml:"enabled"`
	ErrorThreshold      int           `json:"error_threshold" yaml:"error_threshold"`
	SuccessThreshold    int           `json:"success_threshold" yaml:"success_threshold"`
	Timeout             time.Duration `json:"timeout" yaml:"timeout"`
	HalfOpenMaxRequests int           `json:"half_open_max_requests" yaml:"half_open_max_requests"`
}

// UpstreamConfig represents upstream configuration
type UpstreamConfig struct {
	ID              string              `json:"id" yaml:"id"`
	Name            string              `json:"name" yaml:"name"`
	Targets         []Target            `json:"targets" yaml:"targets"`
	LoadBalanceType LoadBalanceType     `json:"load_balance_type" yaml:"load_balance_type"`
	HealthCheck     *HealthCheckConfig  `json:"health_check,omitempty" yaml:"health_check,omitempty"`
	Timeout         time.Duration       `json:"timeout" yaml:"timeout"`
	Retries         int                 `json:"retries" yaml:"retries"`
	CircuitBreaker  *CircuitBreakerConfig `json:"circuit_breaker,omitempty" yaml:"circuit_breaker,omitempty"`
	CreatedAt       time.Time           `json:"created_at" yaml:"created_at"`
	UpdatedAt       time.Time           `json:"updated_at" yaml:"updated_at"`
}

// TargetState holds runtime state for a target
type TargetState struct {
	*Target
    healthy         atomic.Bool
    consecutiveFails atomic.Int32
    consecutiveSuccs atomic.Int32
    lastChecked     atomic.Value // time.Time
}

func NewTargetState(target *Target) *TargetState {
    ts := &TargetState{
        Target: target,
    }
    ts.healthy.Store(true)
    ts.lastChecked.Store(time.Now())
    return ts
}

func (ts *TargetState) IsHealthy() bool {
    return ts.healthy.Load()
}

func (ts *TargetState) SetHealthy(healthy bool) {
    ts.healthy.Store(healthy)
}

func (ts *TargetState) URL() string {
    return fmt.Sprintf("http://%s:%d", ts.Host, ts.Port)
}

// Upstream is an alias for UpstreamConfig
type Upstream = UpstreamConfig

// UpstreamState holds runtime state for an upstream
type UpstreamState struct {
	*Upstream
    targets      []*TargetState
    loadBalancer LoadBalancer
    reverseProxy *httputil.ReverseProxy
    healthChecker *HealthChecker
}

// Manager manages upstreams and their targets
type Manager struct {
    mu        sync.RWMutex
    upstreams map[string]*UpstreamState
}

// NewManager creates a new upstream manager
func NewManager() *Manager {
    return &Manager{
        upstreams: make(map[string]*UpstreamState),
    }
}

// AddUpstream adds an upstream
func (m *Manager) AddUpstream(upstream *Upstream) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if _, exists := m.upstreams[upstream.ID]; exists {
        return fmt.Errorf("upstream %s already exists", upstream.ID)
    }

    state, err := m.createUpstreamState(upstream)
    if err != nil {
        return fmt.Errorf("create upstream state: %w", err)
    }

    m.upstreams[upstream.ID] = state

    // Start health checker if enabled
    if upstream.HealthCheck != nil && upstream.HealthCheck.Enabled {
        state.healthChecker.Start()
    }

    return nil
}

// RemoveUpstream removes an upstream
func (m *Manager) RemoveUpstream(upstreamID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    state, exists := m.upstreams[upstreamID]
    if !exists {
        return fmt.Errorf("upstream %s not found", upstreamID)
    }

    // Stop health checker
    if state.healthChecker != nil {
        state.healthChecker.Stop()
    }

    delete(m.upstreams, upstreamID)
    return nil
}

// GetUpstream returns an upstream by ID
func (m *Manager) GetUpstream(upstreamID string) (*UpstreamState, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    state, exists := m.upstreams[upstreamID]
    if !exists {
        return nil, fmt.Errorf("upstream %s not found", upstreamID)
    }

    return state, nil
}

// SelectTarget selects a target from the upstream using load balancing
func (m *Manager) SelectTarget(ctx context.Context, upstreamID string) (*TargetState, error) {
    state, err := m.GetUpstream(upstreamID)
    if err != nil {
        return nil, err
    }

    // Convert to []*Target for load balancer
    targets := make([]*Target, len(state.targets))
    for i, ts := range state.targets {
        // Wrap TargetState to implement IsHealthy()
        targets[i] = &Target{
            ID:       ts.ID,
            Host:     ts.Host,
            Port:     ts.Port,
            Weight:   ts.Weight,
            Metadata: ts.Metadata,
        }
        // Copy health status
        if ts.IsHealthy() {
            if targets[i].Metadata == nil {
                targets[i].Metadata = make(map[string]string)
            }
            targets[i].Metadata["healthy"] = "true"
        }
    }

    target, err := state.loadBalancer.Select(ctx, targets)
    if err != nil {
        return nil, err
    }

    // Find corresponding TargetState
    for _, ts := range state.targets {
        if ts.ID == target.ID {
            return ts, nil
        }
    }

    return nil, fmt.Errorf("target state not found")
}

func (m *Manager) createUpstreamState(upstream *Upstream) (*UpstreamState, error) {
    // Create target states
    targets := make([]*TargetState, len(upstream.Targets))
    for i, target := range upstream.Targets {
        targets[i] = NewTargetState(&target)
    }

	// Create load balancer
	var lb LoadBalancer
	switch upstream.LoadBalanceType {
	case LoadBalanceRoundRobin:
		lb = NewRoundRobinBalancer()
	case LoadBalanceLeastConnection:
		lb = NewLeastConnectionBalancer()
	case LoadBalanceWeightedRandom:
		lb = NewWeightedRandomBalancer()
	case LoadBalanceIPHash, LoadBalanceConsistentHash:
		lb = NewIPHashBalancer()
	default:
		lb = NewRoundRobinBalancer()
	}

    state := &UpstreamState{
        Upstream:     upstream,
        targets:      targets,
        loadBalancer: lb,
    }

    // Create health checker
    if upstream.HealthCheck != nil && upstream.HealthCheck.Enabled {
        state.healthChecker = NewHealthChecker(upstream.HealthCheck, targets)
    }

    return state, nil
}

// Helper for Target to check health
func (t *Target) IsHealthy() bool {
    if t.Metadata == nil {
        return true
    }
    return t.Metadata["healthy"] == "true"
}
