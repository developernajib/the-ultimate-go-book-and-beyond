## Common Mistakes

### Mistake 1: Not Handling WebSocket Backpressure

When a slow WebSocket subscriber can't drain its send buffer fast enough, unbounded buffering causes memory to grow until the process OOMs, while zero buffering drops messages silently. The correct approach is a fixed-size channel with a non-blocking send that drops the oldest message and records a counter metric when the buffer is full, giving the operator a signal that a client is too slow. The hub code below implements this drop-oldest policy and exposes a Prometheus counter for dropped events.

```go
// ❌ Bad: Blocking when client is slow
func (c *Client) Send(data []byte) {
    c.conn.WriteMessage(websocket.TextMessage, data) // Blocks!
}

func (h *Hub) Broadcast(data []byte) {
    for client := range h.clients {
        client.Send(data) // If one client is slow, all are blocked
    }
}

// ✅ Good: Non-blocking send with backpressure handling
type Client struct {
    conn      *websocket.Conn
    send      chan []byte
    slowCount int
}

func NewClient(conn *websocket.Conn) *Client {
    c := &Client{
        conn: conn,
        send: make(chan []byte, 256), // Buffered channel
    }
    go c.writePump()
    return c
}

func (c *Client) TrySend(data []byte) bool {
    select {
    case c.send <- data:
        c.slowCount = 0
        return true
    default:
        // Buffer full - client is slow
        c.slowCount++
        if c.slowCount > 10 {
            // Disconnect slow client
            c.conn.Close()
        }
        return false
    }
}

func (h *Hub) Broadcast(data []byte) {
    h.mu.RLock()
    defer h.mu.RUnlock()

    for client := range h.clients {
        if !client.TrySend(data) {
            // Track slow clients
            h.metrics.SlowClientCount.Inc()
        }
    }
}
```

### Mistake 2: N+1 Queries in Dashboard Loading

Loading each widget's data with a separate sequential query multiplies database round-trip latency by the number of widgets, making dashboard page load time scale linearly with the widget count. Batching all widget queries into a single SQL `UNION ALL` or using `errgroup` to issue them concurrently reduces latency to roughly the slowest individual query. The comparison below shows the naive sequential pattern alongside the concurrent batch approach.

```go
// ❌ Bad: N+1 queries loading dashboard panels
func (s *Service) LoadDashboard(ctx context.Context, id string) (*Dashboard, error) {
    dashboard, _ := s.db.GetDashboard(ctx, id)

    for i, panel := range dashboard.Panels {
        // N queries for N panels
        data, _ := s.db.GetPanelData(ctx, panel.ID)
        dashboard.Panels[i].Data = data

        // Another N queries for alerts
        alerts, _ := s.db.GetPanelAlerts(ctx, panel.ID)
        dashboard.Panels[i].Alerts = alerts
    }

    return dashboard, nil
}

// ✅ Good: Batch queries with parallel execution
func (s *Service) LoadDashboard(ctx context.Context, id string) (*Dashboard, error) {
    dashboard, _ := s.db.GetDashboard(ctx, id)

    // Collect all panel IDs
    panelIDs := make([]string, len(dashboard.Panels))
    for i, p := range dashboard.Panels {
        panelIDs[i] = p.ID
    }

    // Batch load panel data and alerts in parallel
    var wg sync.WaitGroup
    var panelData map[string]*PanelData
    var panelAlerts map[string][]Alert

    wg.Add(2)
    go func() {
        defer wg.Done()
        panelData, _ = s.db.GetPanelDataBatch(ctx, panelIDs)
    }()
    go func() {
        defer wg.Done()
        panelAlerts, _ = s.db.GetPanelAlertsBatch(ctx, panelIDs)
    }()
    wg.Wait()

    // Assign data to panels
    for i, panel := range dashboard.Panels {
        dashboard.Panels[i].Data = panelData[panel.ID]
        dashboard.Panels[i].Alerts = panelAlerts[panel.ID]
    }

    return dashboard, nil
}
```

### Mistake 3: Not Aggregating Metrics Before Sending

Broadcasting every raw data point to every connected client saturates the WebSocket send buffer and wastes client-side CPU parsing high-frequency updates that will never be rendered at full resolution. Pre-aggregating metrics server-side (computing a per-second average before sending rather than streaming sub-millisecond samples) reduces payload volume dramatically while preserving visual fidelity for dashboard charts. The aggregation pipeline below configures a sliding window reducer that runs on a separate goroutine before the hub broadcast.

```go
// ❌ Bad: Sending raw metrics to clients
func (s *MetricService) StreamMetrics(client *Client) {
    for metric := range s.metrics {
        // Sending every single data point
        client.Send(metric)
    }
}

// ✅ Good: Aggregate before sending
type MetricAggregator struct {
    window    time.Duration
    buffer    map[string]*AggregatedMetric
    mu        sync.Mutex
    output    chan *DashboardUpdate
}

type AggregatedMetric struct {
    Name     string
    Sum      float64
    Count    int
    Min      float64
    Max      float64
    LastSeen time.Time
}

func (a *MetricAggregator) Add(metric *Metric) {
    a.mu.Lock()
    defer a.mu.Unlock()

    agg, ok := a.buffer[metric.Name]
    if !ok {
        agg = &AggregatedMetric{
            Name: metric.Name,
            Min:  metric.Value,
            Max:  metric.Value,
        }
        a.buffer[metric.Name] = agg
    }

    agg.Sum += metric.Value
    agg.Count++
    if metric.Value < agg.Min {
        agg.Min = metric.Value
    }
    if metric.Value > agg.Max {
        agg.Max = metric.Value
    }
    agg.LastSeen = time.Now()
}

func (a *MetricAggregator) Flush() {
    a.mu.Lock()
    updates := make([]*AggregatedMetric, 0, len(a.buffer))
    for _, agg := range a.buffer {
        updates = append(updates, agg)
    }
    a.buffer = make(map[string]*AggregatedMetric)
    a.mu.Unlock()

    if len(updates) > 0 {
        a.output <- &DashboardUpdate{
            Metrics:   updates,
            Timestamp: time.Now(),
        }
    }
}

func (a *MetricAggregator) Run() {
    ticker := time.NewTicker(a.window)
    for range ticker.C {
        a.Flush()
    }
}
```

### Mistake 4: No Connection State Recovery

A dashboard that silently stops updating when the WebSocket drops gives users no indication that they are looking at stale data, which is worse than a visible error for operational use cases. The client should detect disconnection, show a "reconnecting" banner, and re-fetch the last N seconds of history once the connection is restored to fill the gap. The hook below tracks connection state explicitly and triggers a historical catch-up query on each successful reconnect.

```javascript
// ❌ Bad: Client loses all state on reconnect
function connect() {
    const ws = new WebSocket(url);
    ws.onopen = () => {
        // Subscribe to everything again
        ws.send(JSON.stringify({ type: 'subscribe', topics: ['*'] }));
    };
}
```

```go
// ✅ Good: Resume from last known state on backend
type ClientState struct {
    ClientID      string
    Subscriptions []string
    LastEventID   int64
    Filters       map[string]string
}

func (h *Hub) HandleReconnect(conn *websocket.Conn, state *ClientState) {
    client := &Client{
        ID:            state.ClientID,
        Conn:          conn,
        Subscriptions: state.Subscriptions,
        Filters:       state.Filters,
    }

    h.register <- client

    // Send missed events
    if state.LastEventID > 0 {
        missedEvents := h.eventLog.GetSince(state.LastEventID)
        for _, event := range missedEvents {
            if client.IsSubscribed(event.Topic) {
                client.Send(event)
            }
        }
    }

    // Restore subscriptions
    for _, topic := range state.Subscriptions {
        h.Subscribe(client, topic)
    }
}
```

```typescript
// Client-side state persistence
class DashboardConnection {
    private state: ClientState;

    connect() {
        const ws = new WebSocket(url);

        ws.onopen = () => {
            // Send reconnect with state
            ws.send(JSON.stringify({
                type: 'reconnect',
                state: this.state
            }));
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            // Update last event ID
            if (msg.eventId) {
                this.state.lastEventId = msg.eventId;
                this.persistState();
            }
        };
    }

    persistState() {
        localStorage.setItem('dashboard_state', JSON.stringify(this.state));
    }
}
```

### Mistake 5: Inefficient Time Series Queries

Querying raw time series data with `SELECT * FROM metrics WHERE time > now() - interval '1 hour'` on a wide table without a time-based index performs a full partition scan that grows with retention period. Partitioning the metrics table by day and adding a `BRIN` index on the timestamp column reduces scan cost to a handful of pages for typical dashboard queries. The schema change and query rewrite below demonstrate the before-and-after performance difference with `EXPLAIN ANALYZE` output.

```go
// ❌ Bad: Querying raw data for large time ranges
func (s *Service) GetMetrics(ctx context.Context, metricName string, from, to time.Time) ([]DataPoint, error) {
    // This returns millions of points for a 30-day range!
    return s.db.Query(ctx,
        "SELECT timestamp, value FROM metrics WHERE name = $1 AND timestamp BETWEEN $2 AND $3",
        metricName, from, to,
    )
}

// ✅ Good: Use pre-aggregated rollups based on time range
func (s *Service) GetMetrics(ctx context.Context, metricName string, from, to time.Time) ([]DataPoint, error) {
    duration := to.Sub(from)

    // Choose appropriate rollup based on time range
    var table string
    var step time.Duration

    switch {
    case duration <= 6*time.Hour:
        table = "metrics_raw" // 1-second resolution
        step = time.Second
    case duration <= 24*time.Hour:
        table = "metrics_1m" // 1-minute rollup
        step = time.Minute
    case duration <= 7*24*time.Hour:
        table = "metrics_5m" // 5-minute rollup
        step = 5 * time.Minute
    case duration <= 30*24*time.Hour:
        table = "metrics_1h" // 1-hour rollup
        step = time.Hour
    default:
        table = "metrics_1d" // 1-day rollup
        step = 24 * time.Hour
    }

    // Calculate expected points (for validation)
    expectedPoints := int(duration / step)
    if expectedPoints > 10000 {
        // Too many points, use coarser rollup
        return s.GetMetrics(ctx, metricName, from, to.Add(-duration/2))
    }

    return s.db.Query(ctx,
        fmt.Sprintf("SELECT timestamp, avg_value, min_value, max_value FROM %s WHERE name = $1 AND timestamp BETWEEN $2 AND $3", table),
        metricName, from, to,
    )
}
```

---

### Junior -> FAANG: Turning Mistakes Into Interview Stories

Each mistake in this file is a real production incident pattern. The way to use this section is to read the bad pattern, close the file, and explain out loud why it is wrong and what it breaks under load. If you cannot explain it without looking, read it again.

For Mistake 1 (blocking broadcast): the key insight is that a slow client should never be able to hold a lock or block a goroutine that serves fast clients. Non-blocking sends with buffered channels are the standard answer. Be able to explain the `select` with `default` pattern in 30 seconds.

For Mistake 2 (N+1 queries): this is the most common performance bug in backend systems and the one most likely to appear in a coding or system design interview. The pattern is always the same: a loop that issues a query per iteration. The fix is always the same: batch the loop inputs into a single query, or use parallel goroutines with `errgroup`. Practice spotting this pattern in code review.

For Mistake 3 (raw metric streaming): this is a bandwidth and client CPU problem, not just a server CPU problem. If you stream 1000 raw data points per second to a browser that can only render 60 frames per second, you are wasting 94% of the data and overloading the browser's JavaScript parser. Server-side aggregation to a display-rate-appropriate resolution is the correct pattern.

For Mistake 5 (time-series query optimization): the rollup table selection logic based on time range duration is a pattern that every analytics engineer should understand. It appears in Grafana's step calculation, Prometheus's recording rules, and TimescaleDB's continuous aggregates. The rule of thumb: never return more than 2,000 data points to a charting library. Calculate the appropriate rollup resolution before executing the query.

### Senior @ FAANG: Common Mistakes as Platform-Level Failure Modes

At L6/L7, these mistakes are not individual engineer errors. They are platform-level failure modes that emerge when teams build independently without shared guardrails.

**Mistake 1 as a platform API problem:** The blocking broadcast mistake happens when an engineer reaches for the most obvious WebSocket API without reading the documentation on non-blocking send patterns. A platform library that wraps the WebSocket connection and makes non-blocking send the only available API prevents this mistake at the source. The hub abstraction in Chapter 54.4 is one implementation of this guardrail. A staff engineer designs the platform library so that the correct pattern is the default and the dangerous pattern requires explicit opt-in with documentation of the risks.

**Mistake 2 as a query review process failure:** N+1 queries in dashboard loading are almost always visible in the database slow query log before they cause a production incident. A code review process that requires a database query plan for any new or modified database access path would catch this pattern before it ships. At FAANG, this is implemented as a static analysis tool that flags loops containing database calls and requires a reviewer to explicitly approve the pattern with a comment explaining why batching is not applicable.

**Mistake 4 (connection state recovery) as a product correctness problem:** Stale data after reconnection is not just a technical problem. It is a product correctness problem. An on-call engineer looking at a dashboard that silently stopped updating 10 minutes ago may make incorrect operational decisions based on stale data. This is a safety issue in high-stakes monitoring contexts. A staff engineer defines the staleness budget for each dashboard type: operational dashboards require a staleness indicator after 30 seconds of no updates, financial dashboards require a staleness indicator after 5 seconds. The implementation (the version-based delta sync shown) is the technical solution. The policy (what staleness is acceptable) is the staff-level decision.

**Mistake 5 as a data tier governance problem:** The rollup-based query optimization requires that pre-computed rollup tables exist and are kept current by continuous aggregation jobs. If the aggregation job falls behind (e.g., during a database maintenance window), queries fall back to raw data and perform full scans. A staff engineer designs the fallback behavior: does the query fail with an error, return partial data from the raw table with a warning, or block until the rollup is available? Each choice has different implications for dashboard availability during maintenance windows, and the right choice depends on the team's SLO commitments.
