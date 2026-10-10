// internal/upstream/healthcheck.go
package upstream

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"

	"go.uber.org/zap"
)

// HealthChecker performs health checks on targets
type HealthChecker struct {
	config   *HealthCheckConfig
	targets  []*TargetState
	client   *http.Client
	stopChan chan struct{}
	wg       sync.WaitGroup
	logger   *zap.Logger
}

// NewHealthChecker creates a new health checker
func NewHealthChecker(config *HealthCheckConfig, targets []*TargetState) *HealthChecker {
	return &HealthChecker{
		config:  config,
		targets: targets,
		client: &http.Client{
			Timeout: config.Timeout,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		stopChan: make(chan struct{}),
		logger:   zap.L().Named("healthcheck"),
	}
}

// Start begins health checking
func (hc *HealthChecker) Start() {
	hc.wg.Add(1)
	go hc.run()
}

// Stop stops health checking
func (hc *HealthChecker) Stop() {
	close(hc.stopChan)
	hc.wg.Wait()
}

func (hc *HealthChecker) run() {
	defer hc.wg.Done()

	ticker := time.NewTicker(hc.config.Interval)
	defer ticker.Stop()

	// Initial check
	hc.checkAll()

	for {
		select {
		case <-ticker.C:
			hc.checkAll()
		case <-hc.stopChan:
			return
		}
	}
}

func (hc *HealthChecker) checkAll() {
	var wg sync.WaitGroup

	for _, target := range hc.targets {
		wg.Add(1)
		go func(t *TargetState) {
			defer wg.Done()
			hc.checkTarget(t)
		}(target)
	}

	wg.Wait()
}

func (hc *HealthChecker) checkTarget(target *TargetState) {
	ctx, cancel := context.WithTimeout(context.Background(), hc.config.Timeout)
	defer cancel()

	url := fmt.Sprintf("http://%s:%d%s", target.Host, target.Port, hc.config.HTTPPath)

	req, err := http.NewRequestWithContext(ctx, hc.config.HTTPMethod, url, nil)
	if err != nil {
		hc.handleFailure(target, fmt.Errorf("create request: %w", err))
		return
	}

	resp, err := hc.client.Do(req)
	if err != nil {
		hc.handleFailure(target, fmt.Errorf("send request: %w", err))
		return
	}
	defer resp.Body.Close()

	// Check status code
	if !hc.isExpectedStatus(resp.StatusCode) {
		hc.handleFailure(target, fmt.Errorf("unexpected status: %d", resp.StatusCode))
		return
	}

	hc.handleSuccess(target)
}

func (hc *HealthChecker) isExpectedStatus(status int) bool {
	return slices.Contains(hc.config.ExpectedStatus, status)
}

func (hc *HealthChecker) handleSuccess(target *TargetState) {
	target.consecutiveFails.Store(0)
	succ := target.consecutiveSuccs.Add(1)

	if !target.IsHealthy() && succ >= int32(hc.config.HealthyThreshold) {
		target.SetHealthy(true)
		hc.logger.Info("target became healthy",
			zap.String("target_id", target.ID),
			zap.String("host", target.Host),
			zap.Int("port", target.Port),
		)
	}

	target.lastChecked.Store(time.Now())
}

func (hc *HealthChecker) handleFailure(target *TargetState, err error) {
	target.consecutiveSuccs.Store(0)
	fails := target.consecutiveFails.Add(1)

	if target.IsHealthy() && fails >= int32(hc.config.UnhealthyThreshold) {
		target.SetHealthy(false)
		hc.logger.Warn("target became unhealthy",
			zap.String("target_id", target.ID),
			zap.String("host", target.Host),
			zap.Int("port", target.Port),
			zap.Error(err),
		)
	}

	target.lastChecked.Store(time.Now())
}
