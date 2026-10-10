## Interview Questions

### Question 1: How would you design a real-time dashboard that handles 100,000 concurrent connections?

**What FAANG expects:** Capacity numbers grounded in reality (30-50k per Go process depending on write rate), horizontal scaling with sticky sessions, a shared bus (Redis Pub/Sub, NATS, or Kafka) for cross-node fanout, and the failure mode thinking: what happens when the bus is down? Bonus for knowing that Discord serves ~5M concurrent per node on Elixir, and that Go's `nhooyr/websocket` and `gobwas/ws` both outperform `gorilla/websocket` at this scale.

**Answer:** A single Go process can handle roughly 30,000-50,000 concurrent WebSocket connections depending on message rate and payload size. To reach 100,000, you need horizontal scaling: multiple WebSocket server instances behind a load balancer with sticky sessions, coordinated through Redis Pub/Sub so a broadcast from the ingestion layer reaches clients on every server. The architecture below splits the connection pool across three servers with Redis as the shared message bus.

```go
// Scalable WebSocket architecture
type ScalableDashboard struct {
    // Horizontally scaled WebSocket servers
    servers   []*WSServer
    lb        *LoadBalancer

    // Redis for cross-server communication
    redis     *redis.ClusterClient
    pubsub    *redis.PubSub

    // Metrics aggregation layer
    aggregator *MetricAggregator
}

// Architecture:
/*
                    ┌─────────────────────────────────────┐
                    │           Load Balancer             │
                    │    (Sticky sessions by client ID)   │
                    └───────────────┬─────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
    ┌───────▼───────┐       ┌───────▼───────┐       ┌───────▼───────┐
    │  WS Server 1  │       │  WS Server 2  │       │  WS Server 3  │
    │  33K clients  │       │  33K clients  │       │  33K clients  │
    └───────┬───────┘       └───────┬───────┘       └───────┬───────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
                    ┌───────────────▼───────────────┐
                    │       Redis Cluster           │
                    │   (Pub/Sub + State Store)     │
                    └───────────────────────────────┘
*/

// Each server handles ~33K connections
type WSServer struct {
    id        string
    hub       *Hub
    redis     *redis.ClusterClient
    metrics   *prometheus.Registry
}

func (s *WSServer) Start() {
    // Subscribe to Redis for cross-server messages
    pubsub := s.redis.Subscribe(ctx, "dashboard:broadcast")
    go s.handleRedisMessages(pubsub)

    // Local hub for this server's clients
    go s.hub.Run()
}

func (s *WSServer) Broadcast(topic string, data []byte) {
    // Publish to Redis - all servers will receive
    s.redis.Publish(ctx, "dashboard:broadcast", &Message{
        Topic:  topic,
        Data:   data,
        Server: s.id,
    })
}

func (s *WSServer) handleRedisMessages(pubsub *redis.PubSub) {
    for msg := range pubsub.Channel() {
        var m Message
        json.Unmarshal([]byte(msg.Payload), &m)

        // Broadcast to local clients subscribed to this topic
        s.hub.BroadcastToTopic(m.Topic, m.Data)
    }
}

// Connection limit per server
const MaxConnectionsPerServer = 35000

func (s *WSServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    if s.hub.ConnectionCount() >= MaxConnectionsPerServer {
        http.Error(w, "Server at capacity", http.StatusServiceUnavailable)
        return
    }

    // Upgrade and handle connection
    conn, _ := upgrader.Upgrade(w, r, nil)
    client := NewClient(conn)
    s.hub.Register(client)
}
```

Key design decisions:
1. **Horizontal scaling**: Multiple WebSocket servers behind a load balancer
2. **Sticky sessions**: Same client always connects to same server (avoids state sync issues)
3. **Redis Pub/Sub**: Cross-server message delivery
4. **Connection limits**: Prevent server overload (35K per server is reasonable for Go)
5. **Graceful degradation**: Return 503 when at capacity

**Follow-ups:**
- *Sticky sessions seem fragile, what breaks when a node dies?* Its ~33k connections reconnect to surviving nodes, potentially overloading them in a thundering herd. Mitigate with connection-rate limits on reconnect and client-side exponential backoff.
- *Why Redis Pub/Sub instead of Kafka?* Pub/Sub is fire-and-forget with at-most-once delivery, perfect for live dashboard fanout where a missed tick does not matter. Kafka adds persistence you do not need here and tail-latency you do not want.
- *What memory footprint should you budget per connection?* Roughly 10-30KB per idle Go WebSocket with default buffers. 100k connections = 1-3GB just for buffers. Shrink buffers (`ReadBufferSize`/`WriteBufferSize`) if your message sizes are small.

---

### Question 2: How do you handle metric cardinality explosion in dashboards?

**What FAANG expects:** Explain the mechanic: storage cost scales with `unique(metric_name × tag values)`, and one unbounded tag (user ID, request path with query strings, container ID) can blow up a Prometheus instance. Name three mitigations: bounded-cardinality labels (reject or bucket excess), aggregation before ingestion (histogram buckets instead of raw values), and cardinality monitoring with alerts *before* the blast radius grows. Bonus for citing Prometheus `prometheus_tsdb_symbol_table_size_bytes` and Mimir/Thanos sharding strategies.

**Answer:** Cardinality explosion occurs when tag values (like user IDs, request paths with query parameters, or container IDs) create an unbounded number of unique time series. Each unique combination of metric name and tag values produces a separate series in the storage engine, and storage/query cost scales linearly with series count. Three strategies address this: capping unique values per tag key (replacing excess values with `"__other__"`), hash-bucketing high-cardinality values into a fixed number of bins, and monitoring cardinality in real time to alert before it becomes a problem.

```go
// Cardinality management strategy
type CardinalityManager struct {
    limits    map[string]int          // tag key -> max values
    counters  map[string]map[string]int // tag key -> value -> count
    overflow  map[string]int          // tag key -> overflow count
    mu        sync.RWMutex
}

// Strategy 1: Tag value limits
func (m *CardinalityManager) ValidateTags(tags map[string]string) map[string]string {
    m.mu.Lock()
    defer m.mu.Unlock()

    result := make(map[string]string)

    for key, value := range tags {
        limit, hasLimit := m.limits[key]
        if !hasLimit {
            result[key] = value
            continue
        }

        values := m.counters[key]
        if values == nil {
            values = make(map[string]int)
            m.counters[key] = values
        }

        if _, exists := values[value]; exists {
            // Already seen this value
            values[value]++
            result[key] = value
        } else if len(values) < limit {
            // Under limit, add new value
            values[value] = 1
            result[key] = value
        } else {
            // Over limit, use "other"
            m.overflow[key]++
            result[key] = "__other__"
        }
    }

    return result
}

// Strategy 2: Hash-based aggregation for high-cardinality tags
type HashAggregator struct {
    buckets int
}

func (h *HashAggregator) BucketValue(value string) string {
    hash := fnv.New32a()
    hash.Write([]byte(value))
    bucket := hash.Sum32() % uint32(h.buckets)
    return fmt.Sprintf("bucket_%d", bucket)
}

// Strategy 3: Automatic cardinality detection and alerting
type CardinalityMonitor struct {
    db       *sql.DB
    alerter  *Alerter
}

func (m *CardinalityMonitor) CheckCardinality(ctx context.Context) {
    // Query unique values per tag
    rows, _ := m.db.QueryContext(ctx, `
        SELECT tag_key, COUNT(DISTINCT tag_value) as cardinality
        FROM metric_tags
        WHERE created_at > NOW() - INTERVAL '1 hour'
        GROUP BY tag_key
        HAVING COUNT(DISTINCT tag_value) > 1000
    `)

    for rows.Next() {
        var tagKey string
        var cardinality int
        rows.Scan(&tagKey, &cardinality)

        m.alerter.Send(Alert{
            Severity: "warning",
            Title:    "High cardinality tag detected",
            Message:  fmt.Sprintf("Tag '%s' has %d unique values", tagKey, cardinality),
        })
    }
}
```

**Follow-ups:**
- *Why is `request_path` a classic cardinality trap?* Paths with IDs or query strings (`/users/123`, `/search?q=abc`) produce one series per variant. Normalize to route templates (`/users/:id`) before emitting metrics.
- *Histograms vs summaries, which helps with cardinality?* Histograms aggregate at collection with fixed buckets. Summaries compute quantiles client-side and do not aggregate cleanly across instances. Prometheus native histograms (GA 2024) reduce bucket overhead by 5-10x.
- *What does "bucket hashing" lose?* You can no longer filter on the original value, only on the bucket. Acceptable for noisy high-cardinality dimensions (trace_id), not for dimensions operators need to slice on (tenant_id).

---

### Question 3: How do you implement efficient time-series downsampling?

**What FAANG expects:** LTTB (Largest Triangle Three Buckets) as the visual-fidelity-preserving downsample, plus continuous aggregates at multiple resolutions (1m/5m/1h/1d) so queries hit pre-computed rollups. Bonus for noting that simple average/max downsampling hides spikes (alarms stop firing after rollup) while LTTB keeps them, and for mentioning TimescaleDB's hierarchical continuous aggregates (`CAGG on CAGG` since 2.9) that compute higher-resolution rollups from lower ones.

**Answer:** Dashboards typically display 500-2,000 pixels of width, so rendering more than ~2,000 data points per series wastes bandwidth and CPU without improving visual fidelity. The LTTB (Largest Triangle Three Buckets) algorithm preserves the visual shape of a time series while reducing point count to a target number. It works by dividing the series into buckets and selecting the point in each bucket that forms the largest triangle with its neighbors, keeping peaks and valleys that matter visually. For long-term storage, pre-computed rollups at multiple resolutions (1-minute, 5-minute, 1-hour, 1-day) using TimescaleDB's continuous aggregation avoid recomputing aggregates at query time.

```go
// Time series downsampling strategies
type Downsampler struct {
    db *TimeSeriesDB
}

// LTTB (Largest Triangle Three Buckets) algorithm
// Preserves visual shape of data while reducing points
func (d *Downsampler) LTTB(data []DataPoint, targetPoints int) []DataPoint {
    if len(data) <= targetPoints {
        return data
    }

    // Always keep first and last points
    result := make([]DataPoint, 0, targetPoints)
    result = append(result, data[0])

    bucketSize := float64(len(data)-2) / float64(targetPoints-2)

    a := 0 // Point before current bucket

    for i := 0; i < targetPoints-2; i++ {
        // Calculate bucket range
        bucketStart := int(float64(i+1)*bucketSize) + 1
        bucketEnd := int(float64(i+2)*bucketSize) + 1
        if bucketEnd > len(data)-1 {
            bucketEnd = len(data) - 1
        }

        // Calculate average of next bucket (for triangle calculation)
        nextBucketStart := bucketEnd
        nextBucketEnd := int(float64(i+3)*bucketSize) + 1
        if nextBucketEnd > len(data)-1 {
            nextBucketEnd = len(data) - 1
        }

        avgX, avgY := d.bucketAverage(data[nextBucketStart:nextBucketEnd])

        // Find point in bucket that creates largest triangle
        maxArea := float64(0)
        maxAreaPoint := bucketStart

        for j := bucketStart; j < bucketEnd; j++ {
            area := d.triangleArea(
                float64(a), data[a].Value,
                float64(j), data[j].Value,
                avgX, avgY,
            )
            if area > maxArea {
                maxArea = area
                maxAreaPoint = j
            }
        }

        result = append(result, data[maxAreaPoint])
        a = maxAreaPoint
    }

    result = append(result, data[len(data)-1])
    return result
}

func (d *Downsampler) triangleArea(x1, y1, x2, y2, x3, y3 float64) float64 {
    return math.Abs((x1*(y2-y3) + x2*(y3-y1) + x3*(y1-y2)) / 2)
}

// Pre-computed rollups using continuous aggregation
func (d *Downsampler) CreateRollups(ctx context.Context) {
    // 1-minute rollup
    d.db.Exec(ctx, `
        CREATE MATERIALIZED VIEW metrics_1m AS
        SELECT
            time_bucket('1 minute', timestamp) AS bucket,
            name,
            tags,
            AVG(value) AS avg_value,
            MIN(value) AS min_value,
            MAX(value) AS max_value,
            COUNT(*) AS sample_count
        FROM metrics_raw
        GROUP BY bucket, name, tags
        WITH DATA;
    `)

    // Set up continuous aggregation
    d.db.Exec(ctx, `
        SELECT add_continuous_aggregate_policy('metrics_1m',
            start_offset => INTERVAL '2 hours',
            end_offset => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute'
        );
    `)

    // Create indexes
    d.db.Exec(ctx, `
        CREATE INDEX metrics_1m_name_time ON metrics_1m (name, bucket DESC);
    `)
}
```

**Follow-ups:**
- *Why LTTB instead of `AVG` per bucket?* `AVG` smooths out spikes, which is catastrophic for alerting dashboards where the spike is the signal. LTTB preserves the visual peaks because they form the largest triangles.
- *How do you handle downsampling at query time vs ingest time?* Ingest-time rollups (TimescaleDB continuous aggregates, Prometheus recording rules) pay compute once and reuse forever, fast queries but fixed resolution. Query-time downsampling (LTTB) is flexible but expensive over raw data. Combine: rollups for coarse views, LTTB over rollups for zoom.
- *What about exemplars?* Native histograms in Prometheus support exemplars (trace IDs attached to samples). When a dashboard point is a rollup, clicking it should still jump to the original trace, so carry an exemplar through the aggregation pipeline.

---

### Junior -> FAANG: Practicing the Right Answer Structure

Each of the three questions here has a structure you should internalize: state the scale constraint, state the core design choice, state the failure modes, and answer follow-ups without getting defensive.

For Question 1 (100k concurrent connections): start with the number (30-50k per Go process), then state the horizontal scaling solution (Redis Pub/Sub), then walk through what breaks under failure (thundering herd on node restart, at-most-once Redis delivery). If you can do this in under 3 minutes, you have the right depth for an L4/L5 system design interview.

For Question 2 (cardinality explosion): the most important thing to communicate is why this happens before jumping to solutions. Cardinality is the count of unique tag value combinations. Each unique combination is a separate time series in the storage engine. Storage cost and query cost both scale linearly with time series count. Once you have explained the mechanic clearly, the solutions (tag value limits, hash bucketing, cardinality monitoring) follow naturally.

For Question 3 (downsampling): the key differentiation between candidates is knowing LTTB by name and being able to explain why it preserves spike visibility while average-based downsampling does not. You do not need to implement LTTB from memory in an interview, but you should be able to explain the triangle area calculation at a conceptual level: "it picks the point in each bucket that forms the largest triangle with its neighbors, which tends to be the local maximum or minimum."

First-job habit: after any system design practice session, write down the follow-up questions the interviewer asked. Those follow-ups reveal the depth the interviewer wanted and the gaps in your current answer. Review them before your next practice session.

### Senior @ FAANG: Bar-Raiser Signals and L6 Interview Differentiation

At the L6/L7 bar, these three questions are entry points, not the destination. The bar-raiser's job is to find the depth at which your knowledge becomes uncertain, then probe whether you reason well in that uncertainty.

**Question 1 at the L6 bar:** An L4 candidate describes the architecture shown in the code. An L5 candidate adds failure modes (thundering herd, Redis Pub/Sub at-most-once). An L6 candidate goes further: they discuss the session affinity trade-off (sticky sessions simplify state but create uneven load distribution when clients disconnect, while consistent hashing improves distribution but requires clients to re-discover their server after topology changes), they mention that `nhooyr/websocket` and `gobwas/ws` both significantly outperform `gorilla/websocket` at high connection counts and name specific benchmarks, and they raise the question of whether sticky sessions are even the right model or whether stateless connection routing via a shared session store would be more operationally flexible. An L7 candidate frames the organizational question: "who owns the WebSocket platform, what is the API contract for teams building on it, and what is the deprecation process when we need to change the fan-out mechanism?"

**Question 2 at the L6 bar:** An L5 candidate explains the three mitigations. An L6 candidate raises the billing and governance angle: cardinality limits are not just a technical performance concern, they are an organizational budget control mechanism. They discuss the operational experience at Datadog scale, where a single team's cardinality spike can cause a billing variance of tens of thousands of dollars per month and degrade query performance for all other tenants. They propose a specific governance model: cardinality budgets per team, enforced at the ingestion boundary with automated alerting when a team reaches 80% of their budget. An L7 candidate asks the harder question: "what is the right cardinality limit for each tag key, and how does the organization decide that number?" The answer involves a tradeoff between query granularity (higher cardinality means more precise filtering) and storage cost, and the decision requires input from both the engineering team and the business team that owns the monitoring infrastructure budget.

**Question 3 at the L6 bar:** An L5 candidate describes LTTB and continuous aggregates. An L6 candidate adds the exemplar concern (linking dashboard points to specific traces requires carrying exemplar metadata through the aggregation pipeline, which most teams do not implement and then regret during incidents) and the hierarchical continuous aggregate optimization in TimescaleDB 2.9+ (computing higher-resolution rollups from lower-resolution rollups rather than from raw data, which dramatically reduces compute cost for very long retention periods). An L7 candidate raises the data governance question: "for a dashboard that shows aggregated metrics, what is the data lineage story? Can an engineer trace a P99 spike back to the specific traces and requests that contributed to it?" This is a platform-level concern that affects how exemplars are stored, how trace IDs are carried through aggregation, and what the user interface for drill-down looks like.
