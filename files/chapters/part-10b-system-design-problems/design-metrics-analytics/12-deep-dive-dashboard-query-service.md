## Deep Dive: Dashboard Query Service

The dashboard query service ties everything together by loading a dashboard definition from PostgreSQL and then executing all of its panel queries in parallel using goroutines. A typical dashboard might have 10-20 panels, each with one or more metric queries. By running these queries concurrently through the query optimizer, the service can load an entire dashboard in roughly the time it takes to execute the single slowest query, rather than the sum of all query times. This concurrent fan-out pattern is what keeps dashboard load times under the 5-second target even for complex views.

```go
package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type QueryMetricsRequest struct {
	Metric      string
	Tags        map[string]string
	Start       time.Time
	End         time.Time
	Aggregation string
	GroupBy     []string
}

type QueryMetricsResponse struct{}

type QueryOptimizer struct{}

func (o *QueryOptimizer) OptimizedQuery(ctx context.Context, req QueryMetricsRequest) (*QueryMetricsResponse, error) {
	return &QueryMetricsResponse{}, nil
}

type DashboardService struct {
	db    *pgxpool.Pool
	query *QueryOptimizer
}

type Dashboard struct {
	ID          string
	Name        string
	OwnerID     string
	Panels      []Panel
	RefreshRate string
	TimeRange   string
}

type Panel struct {
	ID       string
	Title    string
	Type     string
	Queries  []PanelQuery
	Position struct{ X, Y, W, H int }
}

type PanelQuery struct {
	Metric      string
	Aggregation string
	Alias       string
	Tags        map[string]string
	GroupBy     []string
}

func (s *DashboardService) LoadDashboard(ctx context.Context, dashID string, tr TimeRange) (*DashboardData, error) {
	var dash Dashboard
	var panelsJSON []byte
	err := s.db.QueryRow(ctx,
		"SELECT id, name, panels FROM dashboards WHERE id = $1", dashID,
	).Scan(&dash.ID, &dash.Name, &panelsJSON)
	if err != nil {
		return nil, fmt.Errorf("load dashboard %s: %w", dashID, err)
	}
	if err := json.Unmarshal(panelsJSON, &dash.Panels); err != nil {
		return nil, fmt.Errorf("dashboard %s: bad panels: %w", dashID, err)
	}

	// Fan out one goroutine per panel query. A failed query leaves its
	// panel empty rather than failing the whole dashboard, so partial
	// data still renders during a storage incident.
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		results = make(map[string]*QueryMetricsResponse)
	)
	for _, panel := range dash.Panels {
		for _, q := range panel.Queries {
			wg.Add(1)
			go func(pid string, pq PanelQuery) {
				defer wg.Done()
				r, err := s.query.OptimizedQuery(ctx, QueryMetricsRequest{
					Metric:      pq.Metric,
					Tags:        pq.Tags,
					Start:       tr.Start,
					End:         tr.End,
					Aggregation: pq.Aggregation,
					GroupBy:     pq.GroupBy,
				})
				if err != nil {
					log.Printf("panel %s query %s failed: %v", pid, pq.Alias, err)
					return
				}
				mu.Lock()
				results[pid+":"+pq.Alias] = r
				mu.Unlock()
			}(panel.ID, q)
		}
	}
	wg.Wait()
	return &DashboardData{Dashboard: dash, Results: results}, nil
}

type DashboardData struct {
	Dashboard Dashboard
	Results   map[string]*QueryMetricsResponse
}

type TimeRange struct {
	Start, End time.Time
}
```

---
