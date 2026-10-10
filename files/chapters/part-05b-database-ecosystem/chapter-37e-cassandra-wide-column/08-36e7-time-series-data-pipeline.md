## 37E.7 Time-Series Data Pipeline

### IoT Sensor Data System

This IoT pipeline uses Cassandra's time-bucket partition pattern: sensor readings are bucketed by `(sensor_id, date)` so each partition holds exactly one day of data, bounding partition size while keeping time-range queries efficient. A worker pool of goroutines batches incoming readings and flushes them asynchronously, decoupling ingest throughput from Cassandra write latency.

```go
package timeseries

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/gocql/gocql"
	"github.com/scylladb/gocqlx/v3"
	"github.com/scylladb/gocqlx/v3/qb"
)

// SensorReading represents an IoT sensor measurement
type SensorReading struct {
	SensorID    gocql.UUID `db:"sensor_id"`
	Day         string     `db:"day"`
	Timestamp   time.Time  `db:"timestamp"`
	Temperature float64    `db:"temperature"`
	Humidity    float64    `db:"humidity"`
	Pressure    float64    `db:"pressure"`
}

func toDateBucket(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

// SensorDataService handles IoT sensor data ingestion and queries
type SensorDataService struct {
	session   *gocqlx.Session
	log       *slog.Logger
	writeCh   chan SensorReading
	batchSize int
	flushInterval time.Duration
}

func NewSensorDataService(session *gocqlx.Session, log *slog.Logger) *SensorDataService {
	svc := &SensorDataService{
		session:       session,
		log:           log,
		writeCh:       make(chan SensorReading, 10000),
		batchSize:     500,
		flushInterval: 100 * time.Millisecond,
	}
	return svc
}

// Start starts the background batch writer
func (s *SensorDataService) Start(ctx context.Context) {
	go s.batchWriter(ctx)
}

// Ingest queues a sensor reading for async batch write
func (s *SensorDataService) Ingest(reading SensorReading) error {
	select {
	case s.writeCh <- reading:
		return nil
	default:
		return fmt.Errorf("write buffer full")
	}
}

// batchWriter collects readings and flushes in batches
func (s *SensorDataService) batchWriter(ctx context.Context) {
	ticker := time.NewTicker(s.flushInterval)
	defer ticker.Stop()

	var pending []SensorReading

	flush := func() {
		if len(pending) == 0 {
			return
		}
		batch := s.session.Session.NewBatch(gocql.UnloggedBatch).WithContext(ctx)
		for _, r := range pending {
			batch.Query(
				`INSERT INTO sensor_readings (sensor_id, day, timestamp, temperature, humidity, pressure) VALUES (?, ?, ?, ?, ?, ?) USING TTL 2592000`,
				r.SensorID, r.Day, r.Timestamp, r.Temperature, r.Humidity, r.Pressure,
			)
		}
		if err := s.session.Session.ExecuteBatch(batch); err != nil {
			s.log.Error("sensor batch write failed", "count", len(pending), "err", err)
		} else {
			s.log.Debug("sensor batch written", "count", len(pending))
		}
		pending = pending[:0]
	}

	for {
		select {
		case <-ctx.Done():
			flush() // final flush
			return

		case r := <-s.writeCh:
			r.Day = toDateBucket(r.Timestamp)
			pending = append(pending, r)
			if len(pending) >= s.batchSize {
				flush()
			}

		case <-ticker.C:
			flush()
		}
	}
}

// QueryRange retrieves sensor data for a time range (spanning multiple day partitions)
func (s *SensorDataService) QueryRange(ctx context.Context, sensorID gocql.UUID, from, to time.Time) ([]SensorReading, error) {
	// Calculate which day partitions to query
	days := daysBetween(from, to)

	type result struct {
		readings []SensorReading
		err      error
	}

	results := make(chan result, len(days))
	var wg sync.WaitGroup

	// Parallel queries across day partitions
	for _, day := range days {
		wg.Add(1)
		go func(d string) {
			defer wg.Done()

			stmt, names := qb.Select("sensor_readings").
				Columns("sensor_id", "day", "timestamp", "temperature", "humidity", "pressure").
				Where(
					qb.Eq("sensor_id"),
					qb.Eq("day"),
					qb.GtOrEq("timestamp"),
					qb.LtOrEq("timestamp"),
				).
				OrderBy("timestamp", qb.ASC).
				ToCql()

			var readings []SensorReading
			err := s.session.ContextQuery(ctx, stmt, names...).
				BindMap(qb.M{
					"sensor_id":     sensorID,
					"day":           d,
					"timestamp[0]":  from,
					"timestamp[1]":  to,
				}).
				SelectRelease(&readings)

			results <- result{readings: readings, err: err}
		}(day)
	}

	wg.Wait()
	close(results)

	var allReadings []SensorReading
	for r := range results {
		if r.err != nil {
			return nil, r.err
		}
		allReadings = append(allReadings, r.readings...)
	}

	// Sort by timestamp (parallel results may be out of order)
	sortByTimestamp(allReadings)
	return allReadings, nil
}

// Aggregate computes hourly averages using CQL aggregates
func (s *SensorDataService) HourlyAggregates(ctx context.Context, sensorID gocql.UUID, day string) ([]HourlyAggregate, error) {
	stmt := `SELECT
               dateOf(timestamp) as hour,
               avg(temperature) as avg_temp,
               min(temperature) as min_temp,
               max(temperature) as max_temp,
               avg(humidity) as avg_humidity,
               count(*) as reading_count
             FROM sensor_readings
             WHERE sensor_id = ? AND day = ?`

	// Note: In production, pre-aggregate with separate table for efficiency
	// This is for demonstration - full scans are expensive
	iter := s.session.Session.Query(stmt, sensorID, day).WithContext(ctx).Iter()

	var aggregates []HourlyAggregate
	var agg HourlyAggregate
	for iter.Scan(&agg.Hour, &agg.AvgTemp, &agg.MinTemp, &agg.MaxTemp, &agg.AvgHumidity, &agg.Count) {
		aggregates = append(aggregates, agg)
	}
	return aggregates, iter.Close()
}

type HourlyAggregate struct {
	Hour        time.Time `db:"hour"`
	AvgTemp     float64   `db:"avg_temp"`
	MinTemp     float64   `db:"min_temp"`
	MaxTemp     float64   `db:"max_temp"`
	AvgHumidity float64   `db:"avg_humidity"`
	Count       int64     `db:"reading_count"`
}

func daysBetween(from, to time.Time) []string {
	var days []string
	current := from.UTC().Truncate(24 * time.Hour)
	end := to.UTC().Truncate(24 * time.Hour)
	for !current.After(end) {
		days = append(days, current.Format("2006-01-02"))
		current = current.Add(24 * time.Hour)
	}
	return days
}

func sortByTimestamp(readings []SensorReading) {
	slices.SortFunc(readings, func(a, b SensorReading) int {
		return a.Timestamp.Compare(b.Timestamp)
	})
}
```

### Junior to FAANG: why time bucketing is the whole job

For a junior engineer, the single load-bearing idea in Cassandra time-series is that a partition is a physical storage unit with a practical size ceiling around 100 MB or 100k rows, whichever hits first. If you model a sensor as `PRIMARY KEY (sensor_id, timestamp)` without bucketing, the partition grows without bound, compaction stalls, and reads time out after a few months. The fix that appears in every FAANG IoT design question is `PRIMARY KEY ((sensor_id, day), timestamp)`, which is exactly what the code above uses. The `day` column is a bucket, not data. You compute it from the timestamp before writing, and you compute the list of buckets to fan out over at read time. A worked first-job example: a 1 Hz sensor generates 86400 points per day, a partition of roughly 5 to 10 MB, and a 30-day TTL (`USING TTL 2592000`) gives you a rolling window without a delete job. When the interviewer asks how you would store a year of data, you answer by changing the bucket granularity (hour, day, week, month) and by showing you understand that coarser buckets reduce fan-out at read time but risk partition bloat. Memorize that trade. It is the core question.

### Senior at FAANG: TTL-first design, TWCS, and CDC export

At staff level the time-series conversation quickly becomes a compaction and retention conversation. The correct compaction strategy for this table is TimeWindowCompactionStrategy (TWCS) with a window that matches the bucket, for example `compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': 1}`. TWCS groups SSTables by the write-time window, which means once a window closes no further compaction runs touch it, TTL expiry simply drops the whole SSTable when every cell is expired, and read path bloom filters stay small because each window lives in one or two SSTables. Using SizeTieredCompactionStrategy on a time-series table is a classic staff-level red flag in design review: it rewrites expired data repeatedly and doubles disk usage. Pair TWCS with `default_time_to_live` at the table level so every row inherits a TTL and you never depend on application code to set it. This is the TTL-first design principle: if a row has no business reason to live forever, its TTL is a schema concern, not a client concern.

Write path tuning matters as much as schema. The background batcher in the code uses `UnloggedBatch` over a single partition per flush, which is the correct pattern. The subtle bug waiting to happen is mixing readings from different `(sensor_id, day)` partitions into the same UNLOGGED batch, which re-creates the cross-partition coordinator fan-out problem from section 37E.6. Production code partitions the flush queue by `(sensor_id, day)` before calling `ExecuteBatch`. For ingest above 100k writes per second per node, replace the single channel with a sharded ring (N channels keyed by `hash(sensor_id) mod N`) so flush goroutines never contend on the same partition. Prepared statement caching on `gocqlx` must be enabled to avoid re-preparing on every flush, which otherwise burns coordinator CPU.

Read path fan-out is the other staff concern. `QueryRange` spawns one goroutine per day bucket, which is correct for small windows but pathological for a 365-day scan. Bound the concurrency with a `semaphore.Weighted` sized to the driver's per-host connection pool times host count, typically 32 to 64. Beyond that, fall back to rollup tables. The `HourlyAggregates` example uses CQL `avg`, `min`, `max` server-side aggregates, which are fine for a single partition but degrade when a query spans many partitions because aggregation happens at the coordinator. The production pattern is a second table `sensor_rollups_by_hour` written by a stream processor (Flink, Kafka Streams, or a Go consumer of the Cassandra CDC log) so that dashboard queries read pre-aggregated rows keyed by `(sensor_id, month)` with hour timestamps.

CDC export deserves its own staging. Cassandra 5.0 CDC writes commit log segments to `cdc_raw` once full, and the cassandra-sink Kafka Connect plugin (or Debezium's Cassandra connector for richer schema evolution) tails those segments and publishes to Kafka. For time-series, this gives you a durable event tap without re-reading Cassandra, which is critical for downstream analytics pipelines that would otherwise impose read pressure on the hot path. ScyllaDB 6.0 exposes CDC as a regular CQL table (`sensor_readings_scylla_cdc_log`), which is simpler to consume but has a 24-hour TTL by default, so your consumer must keep up or spill to Kafka. Staff-level interview signal: be able to sketch the TWCS window alignment with the bucket, explain why a `day` bucket with a 7-day TTL gives 7 or 8 active SSTables per sensor at steady state, and describe how you would migrate from a non-bucketed schema to a bucketed one without downtime (dual-write window, backfill with a scan job keyed by token ranges, cutover reads behind a feature flag).

---
