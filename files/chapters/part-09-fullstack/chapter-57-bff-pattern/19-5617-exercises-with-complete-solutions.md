## Exercises with Complete Solutions

### Exercise 1: Build a Mobile BFF with Adaptive Quality

Modern mobile browsers and apps expose network quality hints through HTTP headers like `ECT` (Effective Connection Type), `Save-Data`, and `Downlink`. A well-designed mobile BFF reads these headers and adjusts its response accordingly: fewer items, smaller images, and omitted optional fields on slow connections. This exercise builds a complete adaptive handler that detects network quality from three different header sources and applies per-quality configuration to product listings.

```go
// Solution: mobile-bff/internal/adaptive/handler.go
package adaptive

import (
    "compress/gzip"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/http/httptest"
    "strconv"
    "strings"
    "sync"
    "testing"
    "time"
)

// AdaptiveHandler adjusts responses based on network quality
type AdaptiveHandler struct {
    productClient *ProductClient
    imageService  *ImageService
    cache         *Cache
}

// NetworkQuality detected from headers
type NetworkQuality int

const (
    NetworkSlow   NetworkQuality = iota // 2G, 3G
    NetworkMedium                        // 4G, LTE
    NetworkFast                          // WiFi, 5G
)

// AdaptiveConfig for each quality level
type AdaptiveConfig struct {
    ImageSize      int
    ImageQuality   int
    MaxItems       int
    IncludeDetails bool
    Compression    bool
}

var qualityConfigs = map[NetworkQuality]AdaptiveConfig{
    NetworkSlow: {
        ImageSize:      100,
        ImageQuality:   60,
        MaxItems:       5,
        IncludeDetails: false,
        Compression:    true,
    },
    NetworkMedium: {
        ImageSize:      200,
        ImageQuality:   80,
        MaxItems:       10,
        IncludeDetails: true,
        Compression:    true,
    },
    NetworkFast: {
        ImageSize:      400,
        ImageQuality:   90,
        MaxItems:       20,
        IncludeDetails: true,
        Compression:    false,
    },
}

// DetectNetworkQuality from request headers
func DetectNetworkQuality(r *http.Request) NetworkQuality {
    // Check Save-Data header (user preference)
    if r.Header.Get("Save-Data") == "on" {
        return NetworkSlow
    }

    // Check Network Information API hints
    ect := strings.ToLower(r.Header.Get("ECT")) // Effective Connection Type
    switch ect {
    case "slow-2g", "2g":
        return NetworkSlow
    case "3g":
        return NetworkSlow
    case "4g":
        return NetworkMedium
    default:
        // Check custom app header
        appNetwork := r.Header.Get("X-Network-Type")
        switch strings.ToLower(appNetwork) {
        case "wifi", "5g":
            return NetworkFast
        case "4g", "lte":
            return NetworkMedium
        case "3g", "2g", "slow":
            return NetworkSlow
        }
    }

    // Check Downlink header (bandwidth in Mbps)
    if downlink := r.Header.Get("Downlink"); downlink != "" {
        if dl, err := strconv.ParseFloat(downlink, 64); err == nil {
            if dl < 1 {
                return NetworkSlow
            } else if dl < 5 {
                return NetworkMedium
            }
            return NetworkFast
        }
    }

    return NetworkMedium // Default
}

// MobileProduct with adaptive fields
type MobileProduct struct {
    ID          string  `json:"id"`
    Name        string  `json:"name"`
    PriceCents  int64   `json:"price_cents"`
    ImageURL    string  `json:"image"`
    // Optional details (omitted on slow networks)
    Description *string  `json:"description,omitempty"`
    Rating      *float64 `json:"rating,omitempty"`
    ReviewCount *int     `json:"reviews,omitempty"`
}

// MobileProductList is the API response
type MobileProductList struct {
    Products    []*MobileProduct `json:"products"`
    TotalCount  int              `json:"total"`
    HasMore     bool             `json:"has_more"`
    Quality     string           `json:"quality"` // For debugging
}

func (h *AdaptiveHandler) GetProducts(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()

    // Detect network quality
    quality := DetectNetworkQuality(r)
    config := qualityConfigs[quality]

    // Get products with adaptive limits
    products, total, err := h.productClient.ListProducts(ctx, ListParams{
        Limit:  config.MaxItems,
        Offset: parseOffset(r),
    })
    if err != nil {
        http.Error(w, "Failed to fetch products", http.StatusInternalServerError)
        return
    }

    // Transform with adaptive config
    mobileProducts := make([]*MobileProduct, len(products))
    for i, p := range products {
        mobileProducts[i] = h.transformProduct(p, config)
    }

    response := &MobileProductList{
        Products:   mobileProducts,
        TotalCount: total,
        HasMore:    total > config.MaxItems,
        Quality:    qualityName(quality),
    }

    // Set response headers
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("X-Network-Quality", qualityName(quality))

    // Compress for slow/medium networks
    if config.Compression {
        w.Header().Set("Content-Encoding", "gzip")
        gz := gzip.NewWriter(w)
        defer gz.Close()
        json.NewEncoder(gz).Encode(response)
    } else {
        json.NewEncoder(w).Encode(response)
    }
}

func (h *AdaptiveHandler) transformProduct(p *Product, config AdaptiveConfig) *MobileProduct {
    mobile := &MobileProduct{
        ID:       p.ID,
        Name:     truncateName(p.Name, config),
        PriceCents: p.PriceCents,
        ImageURL: h.imageService.Resize(p.ImageURL, config.ImageSize, config.ImageQuality),
    }

    // Include details only on good networks
    if config.IncludeDetails {
        desc := truncateDescription(p.Description, 200)
        mobile.Description = &desc
        mobile.Rating = &p.Rating
        mobile.ReviewCount = &p.ReviewCount
    }

    return mobile
}

func truncateName(name string, config AdaptiveConfig) string {
    maxLen := 50
    if !config.IncludeDetails {
        maxLen = 25 // Shorter on slow networks
    }
    if len(name) > maxLen {
        return name[:maxLen-3] + "..."
    }
    return name
}

func truncateDescription(desc string, maxLen int) string {
    if len(desc) > maxLen {
        return desc[:maxLen-3] + "..."
    }
    return desc
}

func qualityName(q NetworkQuality) string {
    switch q {
    case NetworkSlow:
        return "low"
    case NetworkMedium:
        return "medium"
    case NetworkFast:
        return "high"
    default:
        return "unknown"
    }
}

// ImageService handles adaptive image URLs
type ImageService struct {
    cdnBaseURL string
}

func (s *ImageService) Resize(originalURL string, size, quality int) string {
    // Return CDN URL with transformation params
    return fmt.Sprintf("%s/resize/%d/%d/%s",
        s.cdnBaseURL,
        size,
        quality,
        extractImagePath(originalURL),
    )
}

// Test the adaptive handler
func TestAdaptiveHandler(t *testing.T) {
    handler := setupTestHandler()

    tests := []struct {
        name           string
        headers        map[string]string
        expectQuality  string
        expectMaxItems int
    }{
        {
            name:           "slow network",
            headers:        map[string]string{"ECT": "2g"},
            expectQuality:  "low",
            expectMaxItems: 5,
        },
        {
            name:           "save data enabled",
            headers:        map[string]string{"Save-Data": "on"},
            expectQuality:  "low",
            expectMaxItems: 5,
        },
        {
            name:           "medium network",
            headers:        map[string]string{"ECT": "4g"},
            expectQuality:  "medium",
            expectMaxItems: 10,
        },
        {
            name:           "fast network",
            headers:        map[string]string{"X-Network-Type": "wifi"},
            expectQuality:  "high",
            expectMaxItems: 20,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := httptest.NewRequest("GET", "/products", nil)
            for k, v := range tt.headers {
                req.Header.Set(k, v)
            }

            rec := httptest.NewRecorder()
            handler.GetProducts(rec, req)

            assert.Equal(t, http.StatusOK, rec.Code)

            var resp MobileProductList
            json.NewDecoder(rec.Body).Decode(&resp)

            assert.Equal(t, tt.expectQuality, resp.Quality)
            assert.LessOrEqual(t, len(resp.Products), tt.expectMaxItems)

            // Check details omission on slow networks
            if tt.expectQuality == "low" {
                for _, p := range resp.Products {
                    assert.Nil(t, p.Description)
                    assert.Nil(t, p.Rating)
                }
            }
        })
    }
}
```

### Exercise 2: Implement Circuit Breaker Dashboard for BFF

When a BFF depends on five or six downstream services, operators need visibility into which circuits are open, half-open, or closed. This exercise builds a circuit breaker registry that tracks all breakers in the BFF process, records state transitions with timestamps, and exposes them through a JSON API endpoint (with an optional HTML dashboard). The registry also hooks into the `gobreaker` state change callback to send alerts when a circuit opens.

```go
// Solution: admin-bff/internal/handler/circuit_dashboard.go
package handler

import (
    "context"
    "encoding/json"
    "fmt"
    "html/template"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/sony/gobreaker"
)

// CircuitBreakerRegistry tracks all circuit breakers
type CircuitBreakerRegistry struct {
    mu       sync.RWMutex
    breakers map[string]*gobreaker.CircuitBreaker
    history  map[string][]*StateChange
}

type StateChange struct {
    From      string    `json:"from"`
    To        string    `json:"to"`
    Timestamp time.Time `json:"timestamp"`
}

func NewCircuitBreakerRegistry() *CircuitBreakerRegistry {
    return &CircuitBreakerRegistry{
        breakers: make(map[string]*gobreaker.CircuitBreaker),
        history:  make(map[string][]*StateChange),
    }
}

// Register adds a circuit breaker to the registry
func (r *CircuitBreakerRegistry) Register(name string, cb *gobreaker.CircuitBreaker) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.breakers[name] = cb
    r.history[name] = make([]*StateChange, 0)
}

// GetStatus returns the current status of all circuit breakers
func (r *CircuitBreakerRegistry) GetStatus() *DashboardStatus {
    r.mu.RLock()
    defer r.mu.RUnlock()

    status := &DashboardStatus{
        Timestamp: time.Now(),
        Services:  make([]*ServiceStatus, 0, len(r.breakers)),
        Summary:   &Summary{},
    }

    for name, cb := range r.breakers {
        state := cb.State()
        counts := cb.Counts()

        svcStatus := &ServiceStatus{
            Name:             name,
            State:            stateToString(state),
            Requests:         counts.Requests,
            Successes:        counts.TotalSuccesses,
            Failures:         counts.TotalFailures,
            ConsecutiveFails: counts.ConsecutiveFailures,
            SuccessRate:      calculateSuccessRate(counts),
            LastStateChange:  r.getLastStateChange(name),
            RecentHistory:    r.history[name],
        }

        status.Services = append(status.Services, svcStatus)

        // Update summary
        switch state {
        case gobreaker.StateClosed:
            status.Summary.Healthy++
        case gobreaker.StateHalfOpen:
            status.Summary.Degraded++
        case gobreaker.StateOpen:
            status.Summary.Unhealthy++
        }
    }

    status.Summary.Total = len(r.breakers)
    return status
}

func (r *CircuitBreakerRegistry) getLastStateChange(name string) *time.Time {
    history := r.history[name]
    if len(history) == 0 {
        return nil
    }
    return &history[len(history)-1].Timestamp
}

// RecordStateChange logs a state transition
func (r *CircuitBreakerRegistry) RecordStateChange(name string, from, to gobreaker.State) {
    r.mu.Lock()
    defer r.mu.Unlock()

    change := &StateChange{
        From:      stateToString(from),
        To:        stateToString(to),
        Timestamp: time.Now(),
    }

    r.history[name] = append(r.history[name], change)

    // Keep only last 100 changes
    if len(r.history[name]) > 100 {
        r.history[name] = r.history[name][1:]
    }
}

// Dashboard response types
type DashboardStatus struct {
    Timestamp time.Time        `json:"timestamp"`
    Services  []*ServiceStatus `json:"services"`
    Summary   *Summary         `json:"summary"`
}

type ServiceStatus struct {
    Name             string         `json:"name"`
    State            string         `json:"state"`
    Requests         uint32         `json:"requests"`
    Successes        uint32         `json:"successes"`
    Failures         uint32         `json:"failures"`
    ConsecutiveFails uint32         `json:"consecutive_failures"`
    SuccessRate      float64        `json:"success_rate"`
    LastStateChange  *time.Time     `json:"last_state_change,omitempty"`
    RecentHistory    []*StateChange `json:"recent_history"`
}

type Summary struct {
    Total     int `json:"total"`
    Healthy   int `json:"healthy"`
    Degraded  int `json:"degraded"`
    Unhealthy int `json:"unhealthy"`
}

// CircuitDashboardHandler serves the dashboard
type CircuitDashboardHandler struct {
    registry *CircuitBreakerRegistry
}

func NewCircuitDashboardHandler(registry *CircuitBreakerRegistry) *CircuitDashboardHandler {
    return &CircuitDashboardHandler{registry: registry}
}

func (h *CircuitDashboardHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    switch r.Method {
    case http.MethodGet:
        h.getStatus(w, r)
    case http.MethodPost:
        h.handleAction(w, r)
    default:
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
    }
}

func (h *CircuitDashboardHandler) getStatus(w http.ResponseWriter, r *http.Request) {
    status := h.registry.GetStatus()

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(status)
}

func (h *CircuitDashboardHandler) handleAction(w http.ResponseWriter, r *http.Request) {
    var action struct {
        Service string `json:"service"`
        Action  string `json:"action"` // "reset", "force_open", "force_close"
    }

    if err := json.NewDecoder(r.Body).Decode(&action); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    h.registry.mu.RLock()
    cb, exists := h.registry.breakers[action.Service]
    h.registry.mu.RUnlock()

    if !exists {
        http.Error(w, "Service not found", http.StatusNotFound)
        return
    }

    switch action.Action {
    case "reset":
        // Note: gobreaker doesn't have a reset method
        // In production, you'd implement custom circuit breaker
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{
            "status":  "acknowledged",
            "message": "Circuit breaker will reset on next successful request",
        })
    default:
        http.Error(w, "Unknown action", http.StatusBadRequest)
    }
}

// Helper functions
func stateToString(state gobreaker.State) string {
    switch state {
    case gobreaker.StateClosed:
        return "closed"
    case gobreaker.StateHalfOpen:
        return "half-open"
    case gobreaker.StateOpen:
        return "open"
    default:
        return "unknown"
    }
}

func calculateSuccessRate(counts gobreaker.Counts) float64 {
    if counts.Requests == 0 {
        return 100.0
    }
    return float64(counts.TotalSuccesses) / float64(counts.Requests) * 100
}

// CreateCircuitBreaker with state change tracking
func (r *CircuitBreakerRegistry) CreateCircuitBreaker(name string, settings gobreaker.Settings) *gobreaker.CircuitBreaker {
    settings.OnStateChange = func(name string, from, to gobreaker.State) {
        r.RecordStateChange(name, from, to)

        // Log state changes
        slog.Info("circuit breaker state change",
            "service", name,
            "from", stateToString(from),
            "to", stateToString(to),
        )

        // Alert on open state
        if to == gobreaker.StateOpen {
            alerting.SendAlert(context.Background(), &Alert{
                Severity: "critical",
                Title:    fmt.Sprintf("Circuit breaker opened: %s", name),
                Message:  fmt.Sprintf("Service %s circuit breaker is now OPEN", name),
            })
        }
    }

    cb := gobreaker.NewCircuitBreaker(settings)
    r.Register(name, cb)
    return cb
}

// HTML Dashboard (optional)
func (h *CircuitDashboardHandler) renderHTML(w http.ResponseWriter, status *DashboardStatus) {
    html := `
<!DOCTYPE html>
<html>
<head>
    <title>Circuit Breaker Dashboard</title>
    <style>
        .healthy { background: #4CAF50; }
        .degraded { background: #FFC107; }
        .unhealthy { background: #F44336; }
        .service { padding: 10px; margin: 5px; border-radius: 4px; color: white; }
    </style>
</head>
<body>
    <h1>Circuit Breaker Dashboard</h1>
    <div id="summary">
        <span class="healthy">Healthy: {{.Summary.Healthy}}</span>
        <span class="degraded">Degraded: {{.Summary.Degraded}}</span>
        <span class="unhealthy">Unhealthy: {{.Summary.Unhealthy}}</span>
    </div>
    <div id="services">
        {{range .Services}}
        <div class="service {{.State}}">
            <h3>{{.Name}}</h3>
            <p>State: {{.State}}</p>
            <p>Success Rate: {{printf "%.1f" .SuccessRate}}%</p>
            <p>Requests: {{.Requests}} ({{.Successes}} success, {{.Failures}} failed)</p>
        </div>
        {{end}}
    </div>
    <script>
        // Auto-refresh every 5 seconds
        setTimeout(() => location.reload(), 5000);
    <\/script>
</body>
</html>`

    tmpl := template.Must(template.New("dashboard").Parse(html))
    w.Header().Set("Content-Type", "text/html")
    tmpl.Execute(w, status)
}

// Usage in BFF setup
func setupBFF() *BFF {
    registry := NewCircuitBreakerRegistry()

    // Create circuit breakers for each backend service
    productCB := registry.CreateCircuitBreaker("product-service", gobreaker.Settings{
        Name:        "product-service",
        MaxRequests: 3,
        Interval:    10 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures > 5
        },
    })

    userCB := registry.CreateCircuitBreaker("user-service", gobreaker.Settings{
        Name:        "user-service",
        MaxRequests: 3,
        Interval:    10 * time.Second,
        Timeout:     30 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures > 5
        },
    })

    orderCB := registry.CreateCircuitBreaker("order-service", gobreaker.Settings{
        Name:        "order-service",
        MaxRequests: 3,
        Interval:    10 * time.Second,
        Timeout:     60 * time.Second,
        ReadyToTrip: func(counts gobreaker.Counts) bool {
            return counts.ConsecutiveFailures > 3
        },
    })

    return &BFF{
        productClient: NewProductClient(productCB),
        userClient:    NewUserClient(userCB),
        orderClient:   NewOrderClient(orderCB),
        dashboardHandler: NewCircuitDashboardHandler(registry),
    }
}
```

### Junior -> FAANG: Making the Most of Complete Solutions

Complete solutions are learning tools, not copy-paste sources. For each exercise, read the solution fully before re-implementing it from scratch without looking. Then compare your implementation against the solution and identify the three specific things you missed or implemented differently.

For Exercise 1 (adaptive quality), the most commonly missed detail in first attempts is the `Downlink` header parsing. Most candidates implement the `ECT` and `Save-Data` checks but miss `Downlink`, which provides a numeric bandwidth estimate. Handling all three header sources and combining them into a single quality value is the production-correct implementation.

For Exercise 2 (circuit breaker dashboard), the most commonly missed detail is the `OnStateChange` callback hooking into alerting. The circuit breaker state is useless for operations if state transitions do not generate alerts. A circuit breaker that opens at 2am without triggering a PagerDuty alert means the on-call engineer does not know until users start complaining. Wire state changes to alerting from the start.

The `CircuitBreakerRegistry.CreateCircuitBreaker` method is the most reusable pattern in Exercise 2. It encapsulates both registration (so the dashboard can find the breaker) and configuration (so the state change callback is always wired). In production, every circuit breaker in the BFF should be created through this factory, never directly via `gobreaker.NewCircuitBreaker`.

### Senior @ FAANG: Production Extensions Not Covered by the Solutions

Both exercises are simplified for clarity. Production implementations require additional capabilities that the solutions leave out.

For Exercise 1 (adaptive quality), the production extension is client-side quality reporting with server-side validation. The BFF accepts the client's reported network quality but also maintains its own estimate based on response times it has observed for that client's IP prefix. If the client reports "wifi" but the BFF's IP-based estimate says "cellular," use the more conservative estimate. This prevents apps from gaming the quality header to always request high-quality responses on metered plans.

The production extension for compression in the adaptive handler is to use `compress/flate` with a compression level that scales with quality: higher quality responses (which are larger) use level 6 compression, while lower quality responses (which are already small) use level 1. The compute cost of level 6 compression is justified for large payloads but wasteful for small ones. Make this configurable via the `AdaptiveConfig` struct.

For Exercise 2 (circuit breaker dashboard), the production extension is persistence. The state change history is stored in memory and lost on BFF restart. For a monitoring tool to be useful during incidents, the history must survive restarts. Persist state changes to Redis or a time-series database (InfluxDB, Prometheus remote write) and read them back on startup. This gives the on-call engineer a complete picture of the circuit's behavior leading up to and through the incident, not just the current state.

The dashboard's `handleAction` method currently only acknowledges reset requests. A production dashboard should support forced circuit closure (for when the on-call engineer knows the service is healthy and wants to let traffic through before the circuit's normal half-open probe cycle). Implement `force_close` by wrapping the circuit breaker in a custom type that exposes a manual reset method, since `gobreaker` does not provide one natively. This requires a thin wrapper around `gobreaker.CircuitBreaker` with an additional `Reset()` method protected by a mutex.

---
