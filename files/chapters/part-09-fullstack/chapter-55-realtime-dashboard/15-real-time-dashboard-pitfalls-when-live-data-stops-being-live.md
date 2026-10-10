## Real-Time Dashboard Pitfalls: When Live Data Stops Being Live

### Pitfall 1: WebSocket Connection Leak on Page Navigation

**Incident Report**: E-commerce dashboard showed correct metrics initially but gradually consumed all server memory over 8 hours. Investigation revealed WebSocket connections weren't being closed when users navigated away from the dashboard page.

```go
// WRONG: No connection cleanup tracking
type DashboardServer struct {
    connections map[string]*websocket.Conn
    mu          sync.RWMutex
}

func (s *DashboardServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, _ := upgrader.Upgrade(w, r, nil)
    userID := r.Context().Value("userID").(string)

    s.mu.Lock()
    s.connections[userID] = conn  // Old connection orphaned if user reconnects
    s.mu.Unlock()

    // Problem: Browser closes tab, connection stays in map forever
    for {
        _, msg, err := conn.ReadMessage()
        if err != nil {
            break  // Connection lost but never removed from map
        }
        s.handleMessage(msg)
    }
}

// CORRECT: Proper connection lifecycle management
type DashboardServer struct {
    connections map[string]map[string]*websocket.Conn  // userID -> connID -> conn
    mu          sync.RWMutex
    metrics     *prometheus.GaugeVec
}

func (s *DashboardServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }

    userID := r.Context().Value("userID").(string)
    connID := uuid.New().String()

    // Register connection
    s.mu.Lock()
    if s.connections[userID] == nil {
        s.connections[userID] = make(map[string]*websocket.Conn)
    }
    s.connections[userID][connID] = conn
    s.mu.Unlock()

    s.metrics.WithLabelValues("active").Inc()

    // Ensure cleanup happens no matter how connection ends
    defer func() {
        s.mu.Lock()
        delete(s.connections[userID], connID)
        if len(s.connections[userID]) == 0 {
            delete(s.connections, userID)
        }
        s.mu.Unlock()

        s.metrics.WithLabelValues("active").Dec()
        conn.Close()
    }()

    // Set read deadline to detect dead connections
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // Ping ticker to keep connection alive and detect dead clients
    pingTicker := time.NewTicker(30 * time.Second)
    defer pingTicker.Stop()

    done := make(chan struct{})
    go func() {
        defer close(done)
        for {
            _, msg, err := conn.ReadMessage()
            if err != nil {
                return
            }
            s.handleMessage(userID, msg)
        }
    }()

    for {
        select {
        case <-done:
            return
        case <-pingTicker.C:
            if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
                return
            }
        }
    }
}
```

### Pitfall 2: Dashboard Update Storm During High Traffic

**Incident Report**: Monitoring dashboard became unresponsive during Black Friday sale. Every metric update triggered a broadcast to all connected clients, causing exponential message amplification when traffic spiked.

```go
// WRONG: Broadcasting every metric update immediately
func (s *DashboardServer) RecordMetric(name string, value float64) {
    s.metrics[name] = value

    // Problem: 1000 metrics/sec × 500 clients = 500,000 messages/sec
    s.broadcastToAll(map[string]any{
        "type":  "metric_update",
        "name":  name,
        "value": value,
    })
}

func (s *DashboardServer) broadcastToAll(msg any) {
    data, _ := json.Marshal(msg)
    s.mu.RLock()
    defer s.mu.RUnlock()

    for _, conn := range s.connections {
        conn.WriteMessage(websocket.TextMessage, data)  // Blocks on slow clients
    }
}

// CORRECT: Batched updates with adaptive throttling
type MetricAggregator struct {
    pending    map[string]float64
    mu         sync.Mutex
    flushTimer *time.Timer
    minDelay   time.Duration
    maxDelay   time.Duration
    server     *DashboardServer
}

func NewMetricAggregator(server *DashboardServer) *MetricAggregator {
    return &MetricAggregator{
        pending:  make(map[string]float64),
        minDelay: 100 * time.Millisecond,
        maxDelay: 1 * time.Second,
        server:   server,
    }
}

func (a *MetricAggregator) RecordMetric(name string, value float64) {
    a.mu.Lock()
    defer a.mu.Unlock()

    a.pending[name] = value

    // Start flush timer if not already running
    if a.flushTimer == nil {
        a.flushTimer = time.AfterFunc(a.minDelay, a.flush)
    }
}

func (a *MetricAggregator) flush() {
    a.mu.Lock()
    if len(a.pending) == 0 {
        a.flushTimer = nil
        a.mu.Unlock()
        return
    }

    // Take snapshot and reset
    batch := a.pending
    a.pending = make(map[string]float64)
    a.flushTimer = nil
    a.mu.Unlock()

    // Broadcast batched update
    a.server.broadcastBatched(batch)
}

func (s *DashboardServer) broadcastBatched(metrics map[string]float64) {
    data, _ := json.Marshal(map[string]any{
        "type":    "metric_batch",
        "metrics": metrics,
        "ts":      time.Now().UnixMilli(),
    })

    s.mu.RLock()
    defer s.mu.RUnlock()

    for connID, conn := range s.connections {
        // Non-blocking send with per-connection buffer
        select {
        case s.sendBuffers[connID] <- data:
        default:
            // Client too slow, drop update (dashboard will catch up)
            s.metrics.WithLabelValues("dropped_updates").Inc()
        }
    }
}
```

### Pitfall 3: Stale Data After WebSocket Reconnection

**Incident Report**: Users reported dashboard showing outdated data after network blips. The WebSocket would reconnect but only receive new updates, missing all changes during disconnection.

```go
// WRONG: No state sync after reconnection
func (s *DashboardServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, _ := upgrader.Upgrade(w, r, nil)

    // Problem: Client has no idea what happened while disconnected
    s.addConnection(conn)
    s.startMessageLoop(conn)
}

// CORRECT: Full state sync on connection with incremental updates
type DashboardState struct {
    Metrics   map[string]float64 `json:"metrics"`
    Alerts    []Alert            `json:"alerts"`
    Version   int64              `json:"version"`
    Timestamp time.Time          `json:"timestamp"`
}

type DashboardServer struct {
    state      *DashboardState
    stateMu    sync.RWMutex
    changeLog  []StateChange  // Keep recent changes for delta sync
    maxLogSize int
}

func (s *DashboardServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }

    // Client can request sync from specific version
    lastVersion := int64(0)
    if v := r.URL.Query().Get("lastVersion"); v != "" {
        lastVersion, _ = strconv.ParseInt(v, 10, 64)
    }

    // Send initial state or delta
    s.stateMu.RLock()
    if lastVersion == 0 || lastVersion < s.state.Version-int64(len(s.changeLog)) {
        // Full sync required
        conn.WriteJSON(map[string]any{
            "type":  "full_sync",
            "state": s.state,
        })
    } else {
        // Delta sync possible
        changes := s.getChangesSince(lastVersion)
        conn.WriteJSON(map[string]any{
            "type":    "delta_sync",
            "changes": changes,
            "version": s.state.Version,
        })
    }
    s.stateMu.RUnlock()

    s.addConnection(conn)
    s.startMessageLoop(conn)
}

func (s *DashboardServer) UpdateMetric(name string, value float64) {
    s.stateMu.Lock()
    s.state.Metrics[name] = value
    s.state.Version++
    s.state.Timestamp = time.Now()

    // Log change for delta sync
    s.changeLog = append(s.changeLog, StateChange{
        Version: s.state.Version,
        Type:    "metric",
        Key:     name,
        Value:   value,
    })
    if len(s.changeLog) > s.maxLogSize {
        s.changeLog = s.changeLog[1:]
    }
    s.stateMu.Unlock()

    s.broadcastChange(name, value, s.state.Version)
}
```

### Pitfall 4: Memory Explosion from Unbounded Chart History

**Incident Report**: Dashboard server crashed after running for 3 days. Each connected client was accumulating unlimited time-series data for charts, consuming 2GB+ per connection.

```go
// WRONG: Unbounded data accumulation
type ChartData struct {
    Timestamps []time.Time
    Values     []float64
}

func (c *ChartData) AddPoint(t time.Time, v float64) {
    // Problem: Grows forever, never cleaned up
    c.Timestamps = append(c.Timestamps, t)
    c.Values = append(c.Values, v)
}

// CORRECT: Circular buffer with configurable retention
type ChartData struct {
    points     []DataPoint
    head       int
    size       int
    capacity   int
    resolution time.Duration
    lastPoint  time.Time
}

type DataPoint struct {
    Timestamp time.Time `json:"t"`
    Value     float64   `json:"v"`
}

func NewChartData(retention time.Duration, resolution time.Duration) *ChartData {
    capacity := int(retention / resolution)
    return &ChartData{
        points:     make([]DataPoint, capacity),
        capacity:   capacity,
        resolution: resolution,
    }
}

func (c *ChartData) AddPoint(t time.Time, v float64) {
    // Downsample: only keep one point per resolution interval
    if !c.lastPoint.IsZero() && t.Sub(c.lastPoint) < c.resolution {
        // Update last point with latest value
        idx := (c.head + c.size - 1) % c.capacity
        c.points[idx].Value = v
        return
    }

    // Add new point to circular buffer
    if c.size < c.capacity {
        c.points[c.size] = DataPoint{Timestamp: t, Value: v}
        c.size++
    } else {
        // Overwrite oldest point
        c.points[c.head] = DataPoint{Timestamp: t, Value: v}
        c.head = (c.head + 1) % c.capacity
    }
    c.lastPoint = t
}

func (c *ChartData) GetPoints(since time.Time) []DataPoint {
    result := make([]DataPoint, 0, c.size)
    for i := 0; i < c.size; i++ {
        idx := (c.head + i) % c.capacity
        if c.points[idx].Timestamp.After(since) {
            result = append(result, c.points[idx])
        }
    }
    return result
}

// Memory usage: 24 bytes per point × capacity
// 1 hour retention @ 1 second resolution = 3600 × 24 = 86KB per metric
// 100 metrics per client = 8.6MB (bounded)
```

### Pitfall 5: Dashboard Crashes Taking Down the Whole App

**Incident Report**: A malformed JSON message from a client caused the dashboard handler to panic, crashing the entire application and taking down all API endpoints.

```go
// WRONG: No panic recovery, shared process with API
func (s *DashboardServer) handleMessage(conn *websocket.Conn, msg []byte) {
    var request DashboardRequest
    json.Unmarshal(msg, &request)  // Panic on malformed JSON

    switch request.Type {
    case "subscribe":
        s.handleSubscribe(conn, request.Topics)  // Panic on nil Topics
    }
}

// CORRECT: Isolated panic recovery and request validation
func (s *DashboardServer) handleMessage(conn *websocket.Conn, msg []byte) {
    defer func() {
        if r := recover(); r != nil {
            s.metrics.WithLabelValues("panic").Inc()
            log.Printf("Dashboard handler panic recovered: %v\nStack: %s", r, debug.Stack())

            // Send error to client but keep connection alive
            conn.WriteJSON(map[string]any{
                "type":  "error",
                "error": "internal_error",
            })
        }
    }()

    var request DashboardRequest
    if err := json.Unmarshal(msg, &request); err != nil {
        conn.WriteJSON(map[string]any{
            "type":  "error",
            "error": "invalid_json",
        })
        return
    }

    // Validate request before processing
    if err := s.validateRequest(&request); err != nil {
        conn.WriteJSON(map[string]any{
            "type":  "error",
            "error": err.Error(),
        })
        return
    }

    switch request.Type {
    case "subscribe":
        if request.Topics == nil {
            conn.WriteJSON(map[string]any{
                "type":  "error",
                "error": "topics_required",
            })
            return
        }
        s.handleSubscribe(conn, request.Topics)
    }
}

func (s *DashboardServer) validateRequest(req *DashboardRequest) error {
    if req.Type == "" {
        return errors.New("type_required")
    }

    validTypes := map[string]bool{
        "subscribe": true, "unsubscribe": true, "ping": true,
    }
    if !validTypes[req.Type] {
        return errors.New("invalid_type")
    }

    return nil
}
```

### Quick Reference: Real-Time Dashboard Pitfalls

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Connection leak | Memory grows, FD exhaustion | Proper lifecycle management with defer cleanup |
| Update storm | CPU spike, unresponsive UI | Batch updates with adaptive throttling |
| Stale data | Outdated metrics after reconnect | Version-based state sync with delta updates |
| Memory explosion | OOM after days of uptime | Circular buffers with bounded retention |
| Crash propagation | Full app restart on error | Panic recovery and request validation |

---

### Junior -> FAANG: Learning to Recognize Pitfall Patterns in Code Review

Code review is where pitfall recognition pays off. Before approving any WebSocket-related code, run through this file's checklist mentally: is there a deferred cleanup? is there a fixed-size send buffer with a non-blocking send? is there a staleness indicator? is there a memory bound on chart history?

The connection leak pitfall is the most common WebSocket bug for engineers who are new to the pattern. The key diagnostic question is: what happens when the browser tab closes without sending a clean close frame? In mobile or unstable network conditions, this is the normal case, not the exception. Your code must handle it without leaking goroutines or map entries.

For the update storm pitfall: before writing any code that calls a broadcast function, ask "what is the maximum rate this function will be called?" If the answer is "it depends on the metric ingest rate," and the metric ingest rate is unbounded, you have an update storm waiting to happen. Always decouple the ingest rate from the broadcast rate with a time-window aggregator.

For the crash propagation pitfall: in Go, a panic in any goroutine that is not recovered crashes the entire process. A panic in a WebSocket message handler that is not recovered will take down every other connection on the same server. The `defer recover()` pattern in the correct example is not optional for network-facing handlers. Apply it to every goroutine that handles external input.

First-job habit: add a `recover` to every goroutine that handles external input. Log the panic with a stack trace at ERROR level. Increment a metric labeled "panic". Notify the client with an error message. Keep the connection alive. This pattern should be a standard function in your team's shared utilities package.

### Senior @ FAANG: Pitfalls as Signals About Platform Maturity

Each pitfall in this file is also a signal about where a team falls on the operational maturity spectrum.

**Connection leak as a process failure:** A connection leak that runs for 8 hours before causing OOM means the team's alerting did not catch the growing connection count. A mature team has an alert on `dashboard_ws_connections_active` that fires when the rate of increase is abnormal (e.g., connections growing by more than 1% per minute for 10 consecutive minutes without a corresponding growth in active users). The incident is a symptom. The root cause is the absence of a proactive alert on a leading indicator. A staff engineer's job after this incident is to add that alert, write the runbook for it, and ensure the same class of alert exists for every resource that can leak (database connections, goroutines, file descriptors).

**Update storm as a missing capacity model failure:** The update storm happened because nobody had computed the worst-case message rate before launch. A mature team's pre-launch checklist includes a back-of-envelope capacity calculation: N metrics per second times M clients equals X messages per second. If X exceeds the server's throughput limit, the design requires aggregation. This calculation should be in the design document, not discovered during a Black Friday incident.

**Stale data as a product quality SLO gap:** The stale data pitfall reveals that the team had no SLO for dashboard freshness. A mature team defines freshness SLOs for each dashboard type (operational dashboards: data no older than 5 seconds under normal conditions, reporting dashboards: data no older than 5 minutes) and enforces them with client-side staleness indicators and server-side freshness probes. The version-based state sync is the technical mechanism. The SLO is the governance artifact that defines when the mechanism is required.

**Memory explosion as a capacity planning failure:** The 2GB per connection memory explosion happened because nobody had computed the memory cost of unbounded chart history before deployment. At FAANG, every new data structure that grows over the lifetime of a connection or request requires a documented bound: "this ring buffer holds at most 3600 points at 24 bytes each, so maximum memory per metric series per connection is 86KB. With 100 metric series per connection and 50,000 connections, maximum client-side buffer memory is 430GB on the server." That calculation reveals immediately that 100 metric series per connection is not viable at 50k connections. The bound must be defined before the code ships, not after the OOM alert fires.
