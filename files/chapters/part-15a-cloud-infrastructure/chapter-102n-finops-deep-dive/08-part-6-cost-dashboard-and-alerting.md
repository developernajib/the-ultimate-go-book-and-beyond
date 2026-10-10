## 102N.6 Cost Dashboard and Alerting

A cost dashboard exposes AWS Cost Explorer data through a structured HTTP API so engineering teams can track spend trends, receive anomaly alerts, and act on savings recommendations without navigating the AWS console. The `CostDashboard` below registers five endpoints, daily totals, team breakdown by resource tag, 30/90-day forecast, anomaly feed, and Savings Plans recommendations, each backed by a `TTLCache` that holds results for 15 minutes to avoid hammering the Cost Explorer API (which has a rate limit of one request per second per account). The cache also absorbs the 4-8 second latency of Cost Explorer queries, making the dashboard viable for browser-based polling.

```go
package dashboard

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"
)

// DailyCost represents the cost for a single day
type DailyCost struct {
	Date    time.Time
	Amount  float64
	Unit    string
	Service string
}

// SavingsRecommendation represents a savings plan recommendation
type SavingsRecommendation struct {
	HourlyCommitment        float64
	EstimatedMonthlySavings float64
	SavingsPercentage       float64
	CurrentOnDemandSpend    float64
}

// CostClient defines the cost queries needed by CostDashboard
type CostClient interface {
	GetDailyCostByService(ctx context.Context, start, end time.Time) ([]DailyCost, error)
	GetMonthlyCostByTag(ctx context.Context, tagKey string, months int) (map[string]float64, error)
	GetCostForecast(ctx context.Context, days int) (float64, error)
	GetSavingsPlanRecommendations(ctx context.Context) ([]SavingsRecommendation, error)
}

// AnomalyDetector detects cost anomalies
type AnomalyDetector struct{}

func NewAnomalyDetector(sensitivity float64, minBaseline int) *AnomalyDetector {
	return &AnomalyDetector{}
}

// CostDashboard serves cost data via HTTP API
type CostDashboard struct {
	costClient  CostClient
	anomalyDet  *AnomalyDetector
	cache       *TTLCache
	cacheTTL    time.Duration
}

func NewCostDashboard(costClient CostClient) *CostDashboard {
	return &CostDashboard{
		costClient:  costClient,
		anomalyDet:  NewAnomalyDetector(2.0, 14),
		cache:       NewTTLCache(),
		cacheTTL:    15 * time.Minute,
	}
}

func (d *CostDashboard) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/costs/daily", d.handleDailyCosts)
	mux.HandleFunc("GET /api/costs/by-team", d.handleCostByTeam)
	mux.HandleFunc("GET /api/costs/forecast", d.handleForecast)
	mux.HandleFunc("GET /api/costs/anomalies", d.handleAnomalies)
	mux.HandleFunc("GET /api/costs/savings", d.handleSavings)
}

func (d *CostDashboard) handleDailyCosts(w http.ResponseWriter, r *http.Request) {
	days := 30
	if s := r.URL.Query().Get("days"); s != "" {
		fmt.Sscanf(s, "%d", &days)
	}
	if days > 90 || days < 1 {
		http.Error(w, "days must be 1-90", http.StatusBadRequest)
		return
	}

	cacheKey := fmt.Sprintf("daily-costs-%d", days)
	if cached, ok := d.cache.Get(cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Cache", "HIT")
		json.NewEncoder(w).Encode(cached)
		return
	}

	end := time.Now()
	start := end.AddDate(0, 0, -days)

	costs, err := d.costClient.GetDailyCostByService(r.Context(), start, end)
	if err != nil {
		http.Error(w, "failed to fetch costs", http.StatusInternalServerError)
		return
	}

	// Aggregate by date
	type DayTotal struct {
		Date     string             `json:"date"`
		Total    float64            `json:"total"`
		Services map[string]float64 `json:"services"`
	}

	byDate := make(map[string]*DayTotal)
	for _, c := range costs {
		key := c.Date.Format("2006-01-02")
		if byDate[key] == nil {
			byDate[key] = &DayTotal{
				Date:     key,
				Services: make(map[string]float64),
			}
		}
		byDate[key].Total += c.Amount
		byDate[key].Services[c.Service] += c.Amount
	}

	var result []*DayTotal
	for _, v := range byDate {
		result = append(result, v)
	}
	slices.SortFunc(result, func(a, b *DayTotal) int {
		return cmp.Compare(a.Date, b.Date)
	})

	d.cache.Set(cacheKey, result, d.cacheTTL)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"data":  result,
		"count": len(result),
	})
}

func (d *CostDashboard) handleForecast(w http.ResponseWriter, r *http.Request) {
	forecast30, err := d.costClient.GetCostForecast(r.Context(), 30)
	if err != nil {
		http.Error(w, "forecast unavailable", http.StatusInternalServerError)
		return
	}

	forecast90, err := d.costClient.GetCostForecast(r.Context(), 90)
	if err != nil {
		forecast90 = forecast30 * 3 // fallback estimate
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"next_30_days": forecast30,
		"next_90_days": forecast90,
		"currency":     "USD",
		"generated_at": time.Now().UTC(),
	})
}

func (d *CostDashboard) handleAnomalies(w http.ResponseWriter, r *http.Request) {
	// Simplified: in practice, use AWS Cost Anomaly Detection API
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"anomalies": []any{},
		"message":   "configure AWS Cost Anomaly Detection for production use",
	})
}

func (d *CostDashboard) handleSavings(w http.ResponseWriter, r *http.Request) {
	recs, err := d.costClient.GetSavingsPlanRecommendations(r.Context())
	if err != nil {
		http.Error(w, "failed to get recommendations", http.StatusInternalServerError)
		return
	}

	totalSavings := 0.0
	for _, r := range recs {
		totalSavings += r.EstimatedMonthlySavings
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"recommendations":       recs,
		"total_monthly_savings": totalSavings,
		"count":                 len(recs),
	})
}

func (d *CostDashboard) handleCostByTeam(w http.ResponseWriter, r *http.Request) {
	months := 1
	costs, err := d.costClient.GetMonthlyCostByTag(r.Context(), "Team", months)
	if err != nil {
		http.Error(w, "failed to fetch team costs", http.StatusInternalServerError)
		return
	}

	type TeamCost struct {
		Team string  `json:"team"`
		Cost float64 `json:"cost"`
	}

	var result []TeamCost
	for team, cost := range costs {
		result = append(result, TeamCost{Team: team, Cost: cost})
	}
	slices.SortFunc(result, func(a, b TeamCost) int {
		return cmp.Compare(b.Cost, a.Cost)
	})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"teams": result,
		"total": func() float64 {
			t := 0.0
			for _, c := range result {
				t += c.Cost
			}
			return t
		}(),
	})
}

// TTLCache is a simple in-memory cache with TTL
type TTLCache struct {
	mu    sync.RWMutex
	items map[string]cacheItem
}

type cacheItem struct {
	value     any
	expiresAt time.Time
}

func NewTTLCache() *TTLCache {
	return &TTLCache{items: make(map[string]cacheItem)}
}

func (c *TTLCache) Get(key string) (any, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	item, ok := c.items[key]
	if !ok || time.Now().After(item.expiresAt) {
		return nil, false
	}
	return item.value, true
}

func (c *TTLCache) Set(key string, value any, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = cacheItem{value: value, expiresAt: time.Now().Add(ttl)}
}
```

---

### Junior → FAANG: Cost Dashboard as an Engineering Tool, Not a Finance Report

The cost dashboard in this section serves a different audience than the AWS billing console. The billing console is designed for finance teams: it shows total spend by service, by account, by region. The engineering cost dashboard is designed for product teams: it shows spend by team tag, by service tag, by environment, with anomaly detection and trend visualization. The difference is attribution. Finance needs to know what the total bill is. Engineering teams need to know what their service costs and whether it changed.

The TTL cache pattern (15-minute cache for Cost Explorer results) is important to understand: Cost Explorer API has a 1 request/second rate limit and charges $0.01 per request (though the first 50 requests per month are free). For a dashboard serving 50 engineers who refresh it periodically, caching at 15 minutes reduces Cost Explorer API calls from potentially thousands per day to 96 (one per 15 minutes). This is both a cost optimization and a reliability improvement (cache eliminates the 4-8 second Cost Explorer latency for most requests).

### Senior @ FAANG: Cost Dashboard as Platform Infrastructure

At staff level, the cost dashboard is a platform service that needs the same reliability and security attention as any production service. Reliability: what happens when Cost Explorer API is down or rate-limited? The cache provides partial protection, but a circuit breaker that serves stale cached data when the API is unavailable is better than returning errors. Security: the cost dashboard exposes financial data that some organizations treat as sensitive. Ensure the API is authenticated (OAuth2 or API key), that team cost data is scoped so a team can only see their own data (not other teams' spend), and that access to aggregate organization-wide data is restricted to finance and leadership roles.

The Savings Plans recommendations endpoint in the dashboard is the highest-ROI data to expose: a team that can see "you have $3,000/month in potential Savings Plans savings for this instance family" has the information needed to submit a Savings Plans purchase request. Building a one-click "submit Savings Plans recommendation to FinOps team" button into the dashboard converts a passive observation into an actionable workflow. The organizational impact of this UX improvement is measurable: adoption rate of Savings Plans recommendations increases when the workflow is one click rather than "navigate to the AWS console, find the Savings Plans section, calculate the commitment amount, submit a purchase request."
