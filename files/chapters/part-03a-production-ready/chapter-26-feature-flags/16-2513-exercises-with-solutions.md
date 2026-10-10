## 26.13 Exercises with Solutions

### Exercise 1: Build a Complete Feature Flag SDK

**Task:** Create a feature flag SDK with local evaluation, caching, and background synchronization.

**Solution:**

The SDK fetches all flag definitions from a remote server on startup, caches them in memory using `atomic.Value` for lock-free reads, and refreshes them via background polling. Flag evaluation happens entirely in-process against the local cache, so each call resolves in microseconds with no network round trip.

```go
// pkg/flagsdk/sdk.go
package flagsdk

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Flag represents a feature flag.
type Flag struct {
	Key          string     `json:"key"`
	Enabled      bool       `json:"enabled"`
	Percentage   int        `json:"percentage"`
	Rules        []Rule     `json:"rules"`
	DefaultValue bool       `json:"default_value"`
	Version      int64      `json:"version"`
}

// Rule represents a targeting rule.
type Rule struct {
	Attribute string   `json:"attribute"`
	Operator  string   `json:"operator"`
	Values    []string `json:"values"`
	Value     bool     `json:"value"`
}

// User represents evaluation context.
type User struct {
	ID         string
	Email      string
	Country    string
	Plan       string
	IsBeta     bool
	Attributes map[string]string
}

// SDK is the feature flag SDK.
type SDK struct {
	config     Config
	flags      atomic.Value // map[string]*Flag
	httpClient *http.Client
	logger     *slog.Logger
	closeCh    chan struct{}
	wg         sync.WaitGroup
	ready      atomic.Bool
	listeners  []func(map[string]*Flag)
	mu         sync.RWMutex
}

// Config configures the SDK.
type Config struct {
	ServerURL     string
	APIKey        string
	PollInterval  time.Duration
	RequestTimeout time.Duration
	Logger        *slog.Logger
}

// New creates a new SDK instance.
func New(config Config) (*SDK, error) {
	if config.PollInterval == 0 {
		config.PollInterval = 30 * time.Second
	}
	if config.RequestTimeout == 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.Logger == nil {
		config.Logger = slog.Default()
	}

	sdk := &SDK{
		config: config,
		httpClient: &http.Client{
			Timeout: config.RequestTimeout,
		},
		logger:    config.Logger,
		closeCh:   make(chan struct{}),
		listeners: make([]func(map[string]*Flag), 0),
	}
	sdk.flags.Store(make(map[string]*Flag))

	// Initial fetch. Non-fatal by design (see 26.8): a flag service
	// outage must not stop the fleet from booting, and every accessor
	// already takes an explicit default. Log loudly and serve defaults
	// until the first successful poll.
	if err := sdk.refresh(context.Background()); err != nil {
		sdk.logger.Warn("initial flag fetch failed, serving defaults until first successful poll",
			"error", err)
	}
	sdk.ready.Store(true)

	// Start background polling
	sdk.wg.Add(1)
	go sdk.pollLoop()

	return sdk, nil
}

// IsEnabled checks if a flag is enabled for the user.
func (s *SDK) IsEnabled(key string, user *User) bool {
	return s.BoolVariation(key, user, false)
}

// BoolVariation returns the boolean value of a flag.
func (s *SDK) BoolVariation(key string, user *User, defaultValue bool) bool {
	if !s.ready.Load() {
		return defaultValue
	}

	flags := s.flags.Load().(map[string]*Flag)
	flag, exists := flags[key]
	if !exists {
		s.logger.Debug("flag not found", "key", key)
		return defaultValue
	}

	if !flag.Enabled {
		return flag.DefaultValue
	}

	// Evaluate rules
	for _, rule := range flag.Rules {
		if s.evaluateRule(rule, user) {
			return rule.Value
		}
	}

	// Percentage rollout
	if flag.Percentage > 0 && flag.Percentage < 100 {
		bucket := s.calculateBucket(user.ID, key)
		return bucket < flag.Percentage
	}

	if flag.Percentage == 100 {
		return true
	}

	return flag.DefaultValue
}

// evaluateRule evaluates a targeting rule.
func (s *SDK) evaluateRule(rule Rule, user *User) bool {
	var actual string
	switch rule.Attribute {
	case "email":
		actual = user.Email
	case "country":
		actual = user.Country
	case "plan":
		actual = user.Plan
	case "is_beta":
		if user.IsBeta {
			actual = "true"
		} else {
			actual = "false"
		}
	default:
		if user.Attributes != nil {
			actual = user.Attributes[rule.Attribute]
		}
	}

	switch rule.Operator {
	case "eq":
		return len(rule.Values) > 0 && actual == rule.Values[0]
	case "in":
		for _, v := range rule.Values {
			if actual == v {
				return true
			}
		}
		return false
	case "contains":
		for _, v := range rule.Values {
			if contains(actual, v) {
				return true
			}
		}
		return false
	default:
		return false
	}
}

// calculateBucket calculates consistent bucket for user.
func (s *SDK) calculateBucket(userID, salt string) int {
	h := sha256.New()
	h.Write([]byte(userID + ":" + salt))
	hash := h.Sum(nil)
	n := binary.BigEndian.Uint32(hash[:4])
	return int(n % 100)
}

// AllFlags returns all flag values for the user.
func (s *SDK) AllFlags(user *User) map[string]bool {
	flags := s.flags.Load().(map[string]*Flag)
	result := make(map[string]bool, len(flags))
	for key := range flags {
		result[key] = s.IsEnabled(key, user)
	}
	return result
}

// OnFlagsUpdated registers a callback for flag updates.
func (s *SDK) OnFlagsUpdated(fn func(map[string]*Flag)) {
	s.mu.Lock()
	s.listeners = append(s.listeners, fn)
	s.mu.Unlock()
}

// pollLoop polls for flag updates.
func (s *SDK) pollLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(s.config.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-s.closeCh:
			return
		case <-ticker.C:
			if err := s.refresh(context.Background()); err != nil {
				s.logger.Error("flag refresh failed", "error", err)
			}
		}
	}
}

// refresh fetches flags from the server.
func (s *SDK) refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", s.config.ServerURL+"/api/flags", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.config.APIKey)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var flags []Flag
	if err := json.NewDecoder(resp.Body).Decode(&flags); err != nil {
		return err
	}

	flagMap := make(map[string]*Flag, len(flags))
	for i := range flags {
		flagMap[flags[i].Key] = &flags[i]
	}

	s.flags.Store(flagMap)

	// Notify listeners
	s.mu.RLock()
	listeners := s.listeners
	s.mu.RUnlock()
	for _, fn := range listeners {
		go fn(flagMap)
	}

	s.logger.Debug("flags refreshed", "count", len(flags))
	return nil
}

// Close shuts down the SDK.
func (s *SDK) Close() error {
	close(s.closeCh)
	s.wg.Wait()
	return nil
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && len(substr) > 0 && findSubstring(s, substr)))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
```

### Exercise 2: Implement A/B Testing with Statistical Analysis

**Task:** Build an A/B testing framework that tracks experiments and provides statistical analysis.

**Solution:**

This implementation manages the full experiment lifecycle: registration, weighted variant assignment via consistent hashing, exposure and conversion tracking through a pluggable `MetricsCollector`, and statistical analysis using a two-proportion z-test. Assignments are persisted through an `ExperimentStore` interface so users see the same variant across sessions.

```go
// pkg/abtest/experiment.go
package abtest

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"math"
	"sync"
	"time"
)

// Experiment represents an A/B test.
type Experiment struct {
	Key         string
	Name        string
	Status      string // "draft", "running", "completed"
	Traffic     int    // Percentage of users in experiment
	Variants    []Variant
	StartTime   time.Time
	Metrics     []Metric
}

// Variant represents an experiment variant.
type Variant struct {
	Key       string
	Name      string
	Weight    int  // Relative weight
	IsControl bool
}

// Metric defines what to measure.
type Metric struct {
	Name    string
	Type    string // "conversion", "continuous"
	Primary bool
}

// Assignment tracks a user's experiment assignment.
type Assignment struct {
	ExperimentKey string
	VariantKey    string
	UserID        string
	AssignedAt    time.Time
}

// ExperimentStore persists experiment assignments.
type ExperimentStore interface {
	GetAssignment(ctx context.Context, experimentKey, userID string) (*Assignment, error)
	SaveAssignment(ctx context.Context, assignment *Assignment) error
}

// MetricsCollector collects experiment metrics.
type MetricsCollector interface {
	RecordExposure(experimentKey, variantKey, userID string)
	RecordConversion(experimentKey, userID string, value float64)
	GetMetrics(experimentKey string) (*ExperimentMetrics, error)
}

// ExperimentMetrics contains collected metrics.
type ExperimentMetrics struct {
	VariantMetrics map[string]*VariantMetrics
}

// VariantMetrics contains metrics for a variant.
type VariantMetrics struct {
	Exposures     int
	Conversions   int
	TotalValue    float64
	Values        []float64 // For continuous metrics
}

// Service manages experiments.
type Service struct {
	experiments map[string]*Experiment
	store       ExperimentStore
	metrics     MetricsCollector
	mu          sync.RWMutex
}

// NewService creates a new experiment service.
func NewService(store ExperimentStore, metrics MetricsCollector) *Service {
	return &Service{
		experiments: make(map[string]*Experiment),
		store:       store,
		metrics:     metrics,
	}
}

// RegisterExperiment registers an experiment.
func (s *Service) RegisterExperiment(exp *Experiment) {
	s.mu.Lock()
	s.experiments[exp.Key] = exp
	s.mu.Unlock()
}

// GetVariant returns the variant for a user.
func (s *Service) GetVariant(ctx context.Context, experimentKey, userID string) (*Variant, error) {
	s.mu.RLock()
	exp, exists := s.experiments[experimentKey]
	s.mu.RUnlock()

	if !exists || exp.Status != "running" {
		return nil, nil
	}

	// Check for existing assignment
	assignment, err := s.store.GetAssignment(ctx, experimentKey, userID)
	if err == nil && assignment != nil {
		for _, v := range exp.Variants {
			if v.Key == assignment.VariantKey {
				return &v, nil
			}
		}
	}

	// Check if user is in experiment traffic
	trafficBucket := calculateBucket(userID, experimentKey+"_traffic")
	if trafficBucket >= exp.Traffic {
		return nil, nil // Not in experiment
	}

	// Assign to variant based on weights
	variantBucket := calculateBucket(userID, experimentKey+"_variant")
	totalWeight := 0
	for _, v := range exp.Variants {
		totalWeight += v.Weight
	}

	normalized := variantBucket * totalWeight / 100
	cumulative := 0
	var selectedVariant *Variant
	for _, v := range exp.Variants {
		cumulative += v.Weight
		if normalized < cumulative {
			selectedVariant = &v
			break
		}
	}

	if selectedVariant == nil {
		return nil, nil
	}

	// Save assignment
	assignment = &Assignment{
		ExperimentKey: experimentKey,
		VariantKey:    selectedVariant.Key,
		UserID:        userID,
		AssignedAt:    time.Now(),
	}
	if err := s.store.SaveAssignment(ctx, assignment); err != nil {
		// Log but don't fail
	}

	// Record exposure
	s.metrics.RecordExposure(experimentKey, selectedVariant.Key, userID)

	return selectedVariant, nil
}

// TrackConversion records a conversion event.
func (s *Service) TrackConversion(experimentKey, userID string, value float64) {
	s.metrics.RecordConversion(experimentKey, userID, value)
}

// Analyze performs statistical analysis on an experiment.
func (s *Service) Analyze(experimentKey string) (*AnalysisResult, error) {
	s.mu.RLock()
	exp, exists := s.experiments[experimentKey]
	s.mu.RUnlock()

	if !exists {
		return nil, nil
	}

	metrics, err := s.metrics.GetMetrics(experimentKey)
	if err != nil {
		return nil, err
	}

	result := &AnalysisResult{
		ExperimentKey: experimentKey,
		AnalyzedAt:    time.Now(),
		Variants:      make(map[string]*VariantAnalysis),
	}

	// Find control variant
	var controlMetrics *VariantMetrics
	for _, v := range exp.Variants {
		if v.IsControl {
			controlMetrics = metrics.VariantMetrics[v.Key]
			break
		}
	}

	// Analyze each variant
	for _, v := range exp.Variants {
		vm := metrics.VariantMetrics[v.Key]
		if vm == nil {
			continue
		}

		analysis := &VariantAnalysis{
			VariantKey:     v.Key,
			Exposures:      vm.Exposures,
			Conversions:    vm.Conversions,
			ConversionRate: float64(vm.Conversions) / float64(vm.Exposures),
		}

		// Calculate statistical significance vs control
		if !v.IsControl && controlMetrics != nil {
			analysis.Lift = (analysis.ConversionRate -
				float64(controlMetrics.Conversions)/float64(controlMetrics.Exposures)) /
				(float64(controlMetrics.Conversions) / float64(controlMetrics.Exposures)) * 100

			analysis.PValue = calculatePValue(
				controlMetrics.Conversions, controlMetrics.Exposures,
				vm.Conversions, vm.Exposures,
			)
			analysis.Significant = analysis.PValue < 0.05
		}

		result.Variants[v.Key] = analysis
	}

	return result, nil
}

// AnalysisResult contains experiment analysis.
type AnalysisResult struct {
	ExperimentKey string
	AnalyzedAt    time.Time
	Variants      map[string]*VariantAnalysis
}

// VariantAnalysis contains analysis for a variant.
type VariantAnalysis struct {
	VariantKey     string
	Exposures      int
	Conversions    int
	ConversionRate float64
	Lift           float64 // Percentage lift vs control
	PValue         float64
	Significant    bool
}

// calculateBucket calculates consistent hash bucket.
func calculateBucket(userID, salt string) int {
	h := sha256.New()
	h.Write([]byte(userID + ":" + salt))
	hash := h.Sum(nil)
	n := binary.BigEndian.Uint32(hash[:4])
	return int(n % 100)
}

// calculatePValue calculates p-value using two-proportion z-test.
func calculatePValue(c1, n1, c2, n2 int) float64 {
	p1 := float64(c1) / float64(n1)
	p2 := float64(c2) / float64(n2)

	// Pooled proportion
	p := float64(c1+c2) / float64(n1+n2)

	// Standard error
	se := math.Sqrt(p * (1 - p) * (1/float64(n1) + 1/float64(n2)))
	if se == 0 {
		return 1.0
	}

	// Z-score
	z := math.Abs(p2-p1) / se

	// Two-tailed p-value (approximation)
	return 2 * (1 - normalCDF(z))
}

// normalCDF approximates the normal CDF.
func normalCDF(z float64) float64 {
	return 0.5 * (1 + math.Erf(z/math.Sqrt2))
}
```

### Exercise 3: Create a Hot-Reload Configuration System

**Task:** Build a configuration system that supports hot-reloading from multiple sources.

**Solution:**

The `HotReloadConfig` aggregates multiple `Source` implementations, file, environment variable, and remote HTTP, into a single merged configuration map. Each source implements `Watch` to detect changes: files use `fsnotify`, remote sources poll on a timer, and environment variables block until context cancellation since they cannot change at runtime. When any source signals a change, the system reloads all sources and notifies registered listeners with both the old and new configuration maps.

```go
// pkg/config/hotreload.go
package config

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"gopkg.in/yaml.v3"
)

// Source represents a configuration source.
type Source interface {
	Load(ctx context.Context) (map[string]any, error)
	Watch(ctx context.Context, onChange func()) error
}

// HotReloadConfig provides hot-reloadable configuration.
type HotReloadConfig struct {
	sources      []Source
	config       map[string]any
	mu           sync.RWMutex
	logger       *slog.Logger
	listeners    []func(old, new map[string]any)
	listenersMu  sync.RWMutex
}

// NewHotReloadConfig creates a new hot-reload config.
func NewHotReloadConfig(logger *slog.Logger, sources ...Source) *HotReloadConfig {
	return &HotReloadConfig{
		sources:   sources,
		config:    make(map[string]any),
		logger:    logger,
		listeners: make([]func(old, new map[string]any), 0),
	}
}

// Load loads configuration from all sources.
func (h *HotReloadConfig) Load(ctx context.Context) error {
	merged := make(map[string]any)

	for _, source := range h.sources {
		data, err := source.Load(ctx)
		if err != nil {
			h.logger.Warn("failed to load source", "error", err)
			continue
		}
		mergeConfig(merged, data)
	}

	h.mu.Lock()
	old := h.config
	h.config = merged
	h.mu.Unlock()

	// Notify listeners
	h.notifyListeners(old, merged)

	return nil
}

// Start starts watching all sources.
func (h *HotReloadConfig) Start(ctx context.Context) error {
	// Initial load
	if err := h.Load(ctx); err != nil {
		return err
	}

	// Start watching each source
	for _, source := range h.sources {
		go func(s Source) {
			if err := s.Watch(ctx, func() {
				h.logger.Info("configuration change detected")
				if err := h.Load(ctx); err != nil {
					h.logger.Error("failed to reload config", "error", err)
				}
			}); err != nil {
				h.logger.Error("watch failed", "error", err)
			}
		}(source)
	}

	return nil
}

// Get returns a configuration value.
func (h *HotReloadConfig) Get(key string) any {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.config[key]
}

// GetString returns a string configuration value.
func (h *HotReloadConfig) GetString(key string) string {
	if v := h.Get(key); v != nil {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// GetInt returns an integer configuration value.
func (h *HotReloadConfig) GetInt(key string) int {
	if v := h.Get(key); v != nil {
		switch val := v.(type) {
		case int:
			return val
		case float64:
			return int(val)
		case int64:
			return int(val)
		}
	}
	return 0
}

// GetBool returns a boolean configuration value.
func (h *HotReloadConfig) GetBool(key string) bool {
	if v := h.Get(key); v != nil {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

// OnChange registers a callback for configuration changes.
func (h *HotReloadConfig) OnChange(fn func(old, new map[string]any)) {
	h.listenersMu.Lock()
	h.listeners = append(h.listeners, fn)
	h.listenersMu.Unlock()
}

// notifyListeners notifies all registered listeners.
func (h *HotReloadConfig) notifyListeners(old, new map[string]any) {
	h.listenersMu.RLock()
	listeners := h.listeners
	h.listenersMu.RUnlock()

	for _, fn := range listeners {
		go fn(old, new)
	}
}

// FileSource loads configuration from a file.
type FileSource struct {
	path   string
	format string // "yaml", "json"
}

// NewFileSource creates a new file source.
func NewFileSource(path string) *FileSource {
	format := "yaml"
	ext := filepath.Ext(path)
	if ext == ".json" {
		format = "json"
	}
	return &FileSource{path: path, format: format}
}

// Load loads configuration from file.
func (f *FileSource) Load(ctx context.Context) (map[string]any, error) {
	data, err := os.ReadFile(f.path)
	if err != nil {
		return nil, err
	}

	var config map[string]any
	switch f.format {
	case "json":
		err = json.Unmarshal(data, &config)
	default:
		err = yaml.Unmarshal(data, &config)
	}

	return config, err
}

// Watch watches the file for changes.
func (f *FileSource) Watch(ctx context.Context, onChange func()) error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer watcher.Close()

	// Watch the DIRECTORY, not the file (see 26.4): a watch binds to
	// the inode, so an atomic rename leaves a file watch orphaned.
	// CREATE matters as much as WRITE: a rename into place arrives
	// as CREATE.
	target := filepath.Clean(f.path)
	if err := watcher.Add(filepath.Dir(target)); err != nil {
		return err
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event := <-watcher.Events:
			if filepath.Clean(event.Name) != target {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) != 0 {
				onChange()
			}
		case err := <-watcher.Errors:
			return err
		}
	}
}

// EnvSource loads configuration from environment variables.
type EnvSource struct {
	prefix string
}

// NewEnvSource creates a new environment source.
func NewEnvSource(prefix string) *EnvSource {
	return &EnvSource{prefix: prefix}
}

// Load loads configuration from environment.
func (e *EnvSource) Load(ctx context.Context) (map[string]any, error) {
	config := make(map[string]any)

	for _, env := range os.Environ() {
		key, value := parseEnv(env)
		if e.prefix != "" && !hasPrefix(key, e.prefix) {
			continue
		}
		config[key] = value
	}

	return config, nil
}

// Watch does nothing for environment variables.
func (e *EnvSource) Watch(ctx context.Context, onChange func()) error {
	<-ctx.Done()
	return ctx.Err()
}

// RemoteSource loads configuration from a remote URL.
type RemoteSource struct {
	url          string
	pollInterval time.Duration
	httpClient   *http.Client
}

// NewRemoteSource creates a new remote source.
func NewRemoteSource(url string, pollInterval time.Duration) *RemoteSource {
	return &RemoteSource{
		url:          url,
		pollInterval: pollInterval,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
	}
}

// Load loads configuration from remote URL.
func (r *RemoteSource) Load(ctx context.Context) (map[string]any, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", r.url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var config map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		return nil, err
	}

	return config, nil
}

// Watch polls the remote URL for changes.
func (r *RemoteSource) Watch(ctx context.Context, onChange func()) error {
	ticker := time.NewTicker(r.pollInterval)
	defer ticker.Stop()

	var lastConfig map[string]any

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			config, err := r.Load(ctx)
			if err != nil {
				continue
			}
			if !reflect.DeepEqual(config, lastConfig) {
				lastConfig = config
				onChange()
			}
		}
	}
}

// mergeConfig merges source into dest.
func mergeConfig(dest, source map[string]any) {
	for k, v := range source {
		dest[k] = v
	}
}

func parseEnv(env string) (string, string) {
	for i := 0; i < len(env); i++ {
		if env[i] == '=' {
			return env[:i], env[i+1:]
		}
	}
	return env, ""
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
```

### Senior at FAANG Track

For one service, audit all feature flags. Identify stale ones, then delete them and the code they gate.

### Staff / Principal Track

Build flag governance: tagging, ownership, lifetime. Dashboard for stale flags. Lint rule for dead references. Drive adoption.

---
