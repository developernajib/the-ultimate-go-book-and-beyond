## 37H.3 InfluxDB v3: Purpose-Built Time-Series

### IOx Column Store with Arrow

InfluxDB v3 (distributed as **InfluxDB 3 Core** - open source, **Enterprise**, and **Cloud Serverless**) is a ground-up rewrite in Rust of the earlier Go+TSM engine that shipped as InfluxDB 1.x/2.x. The new storage engine, codenamed IOx, is built on the **FDAP stack**: Apache **F**light (transport), Apache Arrow **D**ataFusion (SQL query engine), Apache **A**rrow (in-memory columnar format), and Apache **P**arquet (on-disk columnar format, persisted to object storage like S3/GCS/Azure Blob or a local disk). The result is separation of compute and storage, unlimited tag cardinality (v1/v2 had hard limits), SQL queries alongside InfluxQL, and materially better compression than the old TSM files.

The Go client writes data using the familiar line protocol (`measurement,tag_key=val field_key=val timestamp`) and reads it back over Arrow Flight SQL for high-throughput bulk retrieval - result rows arrive as Arrow record batches rather than row-by-row JSON, which is what makes the `iterator.Value()` map cheap even for million-row scans.

```go
package influxdb

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	influxdb3 "github.com/InfluxCommunity/influxdb3-go/v2"
)

// Config for InfluxDB v3
type Config struct {
	URL      string
	Token    string
	Database string
}

// Client wraps InfluxDB v3 client
type Client struct {
	client *influxdb3.Client
	db     string
	log    *slog.Logger
}

// NewClient creates InfluxDB v3 client
func NewClient(cfg Config, log *slog.Logger) (*Client, error) {
	client, err := influxdb3.New(influxdb3.ClientConfig{
		Host:     cfg.URL,
		Token:    cfg.Token,
		Database: cfg.Database,
	})
	if err != nil {
		return nil, fmt.Errorf("influxdb client: %w", err)
	}
	return &Client{client: client, db: cfg.Database, log: log}, nil
}

// SensorPoint represents an IoT sensor measurement
type SensorPoint struct {
	Timestamp   time.Time
	SensorID    string
	Location    string
	Temperature float64
	Humidity    float64
	Pressure    float64
	BatteryPct  float64
}

// WritePoints writes sensor measurements using line protocol
func (c *Client) WritePoints(ctx context.Context, points []SensorPoint) error {
	var pointsToWrite []*influxdb3.Point

	for _, p := range points {
		point := influxdb3.NewPoint(
			"sensor_readings",             // measurement name
			map[string]string{             // tags (indexed)
				"sensor_id": p.SensorID,
				"location":  p.Location,
			},
			map[string]any{        // fields (values)
				"temperature": p.Temperature,
				"humidity":    p.Humidity,
				"pressure":    p.Pressure,
				"battery_pct": p.BatteryPct,
			},
			p.Timestamp,
		)
		pointsToWrite = append(pointsToWrite, point)
	}

	return c.client.WritePoints(ctx, pointsToWrite...)
}

// QueryLastN retrieves the last N readings for a sensor
func (c *Client) QueryLastN(ctx context.Context, sensorID string, n int) ([]SensorPoint, error) {
	query := fmt.Sprintf(`
		SELECT *
		FROM sensor_readings
		WHERE sensor_id = '%s'
		ORDER BY time DESC
		LIMIT %d
	`, sensorID, n)

	iterator, err := c.client.Query(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query last N: %w", err)
	}

	var points []SensorPoint
	for iterator.Next() {
		row := iterator.Value()
		p := SensorPoint{
			SensorID: sensorID,
		}
		if ts, ok := row["time"].(time.Time); ok {
			p.Timestamp = ts
		}
		if temp, ok := row["temperature"].(float64); ok {
			p.Temperature = temp
		}
		if hum, ok := row["humidity"].(float64); ok {
			p.Humidity = hum
		}
		points = append(points, p)
	}
	return points, iterator.Err()
}

// QueryAggregates returns windowed aggregates using SQL
func (c *Client) QueryAggregates(ctx context.Context, sensorID, window string, from, to time.Time) ([]SensorAggregate, error) {
	query := fmt.Sprintf(`
		SELECT
			DATE_BIN('%s', time, TIMESTAMP '1970-01-01') AS window_start,
			sensor_id,
			avg(temperature) AS avg_temp,
			max(temperature) AS max_temp,
			min(temperature) AS min_temp,
			avg(humidity) AS avg_humidity,
			count(*) AS sample_count
		FROM sensor_readings
		WHERE sensor_id = '%s'
		  AND time >= '%s'
		  AND time <= '%s'
		GROUP BY window_start, sensor_id
		ORDER BY window_start ASC
	`,
		window, sensorID,
		from.UTC().Format(time.RFC3339),
		to.UTC().Format(time.RFC3339),
	)

	iterator, err := c.client.Query(ctx, query)
	if err != nil {
		return nil, err
	}

	var aggs []SensorAggregate
	for iterator.Next() {
		row := iterator.Value()
		a := SensorAggregate{}
		if ws, ok := row["window_start"].(time.Time); ok {
			a.WindowStart = ws
		}
		if avg, ok := row["avg_temp"].(float64); ok {
			a.AvgTemp = avg
		}
		if max, ok := row["max_temp"].(float64); ok {
			a.MaxTemp = max
		}
		if min, ok := row["min_temp"].(float64); ok {
			a.MinTemp = min
		}
		if cnt, ok := row["sample_count"].(int64); ok {
			a.Count = cnt
		}
		aggs = append(aggs, a)
	}
	return aggs, iterator.Err()
}

type SensorAggregate struct {
	WindowStart time.Time
	AvgTemp     float64
	MaxTemp     float64
	MinTemp     float64
	AvgHumidity float64
	Count       int64
}
```

### Junior → FAANG: line protocol, tags vs fields, and avoiding cardinality suicide

InfluxDB is the database that punishes schema mistakes the hardest. The single concept a junior engineer must internalize before writing any line protocol is the difference between tags and fields. Tags are indexed. Fields are not. Every unique combination of tag values across a measurement creates a new series. Series count is the main cost driver. A naive schema with `user_id` as a tag on a user events measurement at a million users creates a million series. At ten million, your InfluxDB instance falls over. The rule of 2026, now backed by the v3 IOx engine which handles high cardinality much better than v1 and v2, is still the same mental model: tags are for low cardinality things you filter on (region, host, status, device_model), fields are for high cardinality or continuous values (user_id, latency_ms, payload_size, error_message).

Worked example to do on day one. Write 1 million points with `host` as tag (10 distinct values) and `latency` as field. Query `SELECT mean(latency) FROM requests WHERE host='web1' AND time > now() - 1h GROUP BY time(1m)`. Time it. Now rewrite with `user_id` as tag (1 million distinct values) instead. Watch ingest slow down and memory balloon. That one experiment teaches cardinality better than any documentation.

Line protocol is the ingest format: `measurement,tag1=v1,tag2=v2 field1=1.0,field2="text" timestamp_ns`. Three parts separated by spaces. Tags and fields are comma separated inside their parts. Timestamps default to nanoseconds since epoch. The Go client batches points for you, but you should understand that a batch is just a newline joined string of line protocol sent over HTTP. When your ingest stalls, curl with `--data-binary` against `/api/v2/write` to isolate whether the problem is the client or the server.

Interview entry points at observability and IoT shops: what is cardinality and why does it matter, what is the difference between InfluxQL, Flux, and SQL in InfluxDB v3, what replaced the TSM engine in v3, why did Influx move off its own storage format to Parquet, and when would you pick Influx over Prometheus. The honest answer to the last one in 2026 is that Prometheus is the right choice for ephemeral infrastructure metrics (pull based, service discovery, alerting), and InfluxDB v3 is the right choice for durable event and IoT time series where you want SQL and Parquet interop.

### Senior @ FAANG: InfluxDB v3 IOx internals, the Rust plus Arrow rewrite, and the 2026 time series matrix

InfluxDB v3 is a ground up rewrite. The previous TSM (Time Structured Merge) engine from v1 and v2 was a custom on disk format optimized for the v1 query model. It did not handle high cardinality well, it did not interop with the broader data ecosystem, and it was written in Go with GC pauses that hurt tail latency at scale. The v3 IOx engine is written in Rust, uses Apache Arrow as the in memory columnar format, Apache Parquet as the on disk format, and Apache DataFusion as the query engine. The implications are profound and a staff engineer should understand each one.

Storage on Parquet over object storage (S3, GCS, Azure Blob) means InfluxDB data is now readable by any tool that reads Parquet. You can point DuckDB at an Influx bucket and run ad hoc SQL without going through the Influx query engine. You can register Influx Parquet files as external tables in Snowflake or BigQuery. You can back up by copying S3 prefixes. This is the lakehouse convergence applied to time series, and it is the single biggest reason to pick Influx v3 over v2 for a greenfield deployment in 2026.

Arrow as the in memory format means zero copy interop with pandas, Polars, DataFusion, and any Flight SQL client. The Go client uses Arrow Flight SQL as its preferred transport, which delivers typed column batches directly rather than JSON rows. This is the same protocol ClickHouse and Dremio use, and it makes Influx a first class citizen in the Arrow ecosystem.

DataFusion as the query engine means Influx inherits a mature SQL planner and executor with predicate pushdown into Parquet, vectorized execution, and a growing catalog of window and time series functions. InfluxQL is still supported for legacy queries. Flux is deprecated. SQL is the new primary surface. If you have v1 or v2 dashboards on Flux, budget migration time.

Compaction in IOx is multi level. Incoming writes land in an in memory write buffer (the ingester tier). The ingester flushes Parquet files to object storage on a size or time threshold. A compactor service reads small Parquet files and merges them into larger ones optimized for query. A querier service reads Parquet from object storage (with local NVMe cache) and executes queries. The separation of ingester, compactor, and querier is the core scale out story, and it maps directly onto a Kubernetes deployment where each tier scales independently.

The 2026 time series competitive matrix. InfluxDB v3 versus Prometheus: Prometheus wins on pull model, service discovery, and alerting ecosystem (Alertmanager), and is the default for Kubernetes infra metrics. Influx v3 wins on durable long term storage, SQL access, and arbitrary cardinality. InfluxDB versus VictoriaMetrics: VictoriaMetrics is the Prometheus compatible long term store of choice in 2026 for cost conscious infra teams, 10x cheaper per series than Influx or Mimir, but it speaks PromQL and MetricsQL only, no SQL. InfluxDB versus QuestDB: QuestDB is the fastest raw ingest time series database in public benchmarks, speaks a SQL dialect close to Postgres, and is a strong pick for fintech tick data where ingest rate is the constraint. Its ecosystem is smaller. InfluxDB versus TimescaleDB: Timescale wins on joins with relational metadata and Postgres tooling, Influx v3 wins on ingest at high cardinality and Parquet interop. InfluxDB versus Grafana Mimir: Mimir is a horizontally scalable Prometheus backend, not a general time series database, pick it when your sources are Prometheus exporters and you want a million active series at reasonable cost. InfluxDB versus Thanos: Thanos is the older Prometheus long term store using S3 for blocks, losing ground to Mimir and VictoriaMetrics, pick only if you are already invested. InfluxDB versus ClickHouse for time series: ClickHouse has overtaken Influx for log analytics and is increasingly competitive for metrics when you have a strong SQL team, Influx still wins on line protocol ergonomics and on the native tag model for low cardinality filters.

Design decision framework for a staff engineer. First ask what the workload actually is. Infrastructure metrics with short retention and Kubernetes context: Prometheus plus VictoriaMetrics or Mimir. Business metrics, product events, IoT telemetry with long retention: InfluxDB v3 or TimescaleDB or ClickHouse. High frequency financial tick data: QuestDB or kdb+ if budget allows. General observability with logs, metrics, and traces unified: ClickHouse with OpenTelemetry. Second ask what the query surface is. PromQL only: VictoriaMetrics or Mimir. SQL with joins and relational data: TimescaleDB. SQL with Parquet interop and Arrow Flight: InfluxDB v3. SQL at billions of rows per second with sub second dashboards: ClickHouse. Third ask what the operational budget is. Managed cloud only: Influx Cloud, Timescale Cloud, ClickHouse Cloud, or Grafana Cloud. Self hosted with minimal SRE: InfluxDB v3 OSS or VictoriaMetrics single node. Self hosted at scale: ClickHouse with Keeper or Mimir on Kubernetes.

Operational gotchas in InfluxDB v3. The free OSS build has a single node limit and does not include the full compactor clustering, the Enterprise and Cloud tiers do. Schema migrations are still painful because tags and fields are sticky once written (the Parquet files on S3 carry the old schema), plan tag design carefully up front. Retention policies delete Parquet files on S3, but object storage lifecycle policies can do the same job cheaper, coordinate so you do not double delete. Arrow Flight SQL requires gRPC, which means your network policies and service meshes must allow HTTP/2, a surprising number of enterprise environments block this by default. Finally, if you are migrating from v2, the query migration from Flux to SQL is the long tail, budget it at 2x your first estimate.

---
