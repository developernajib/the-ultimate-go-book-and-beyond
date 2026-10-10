## Section 2: Extractors

### 2.1 Postgres CDC Extractor

Extractors are responsible for pulling data from source systems (databases, APIs, files) and emitting uniform records into the pipeline. The generic extractor implementations below support database cursor streaming, paginated REST API polling, and CSV file reading, each respecting backpressure through channel blocking.

```go
package etl

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

// PostgresExtractor reads records from Postgres using cursor-based pagination.
type PostgresExtractor struct {
	db          *sql.DB
	table       string
	watermark   string // column for incremental extraction (e.g., updated_at)
	batchSize   int
	checkpoint  CheckpointStore
}

// CheckpointStore persists the last-processed watermark for resumability.
type CheckpointStore interface {
	Load(ctx context.Context, key string) (string, error)
	Save(ctx context.Context, key string, value string) error
}

func NewPostgresExtractor(db *sql.DB, table, watermark string, batchSize int, ck CheckpointStore) *PostgresExtractor {
	return &PostgresExtractor{
		db:         db,
		table:      table,
		watermark:  watermark,
		batchSize:  batchSize,
		checkpoint: ck,
	}
}

// Extract streams records from Postgres, resuming from last checkpoint.
func (e *PostgresExtractor) Extract(ctx context.Context) (<-chan Record, error) {
	ckKey := "postgres:" + e.table
	lastWatermark, _ := e.checkpoint.Load(ctx, ckKey)

	out := make(chan Record, 1024)

	go func() {
		defer close(out)

		var cursor string
		if lastWatermark != "" {
			cursor = lastWatermark
		} else {
			cursor = "1970-01-01T00:00:00Z"
		}

		for {
			query := fmt.Sprintf(
				`SELECT * FROM %s WHERE %s > $1 ORDER BY %s ASC LIMIT $2`,
				e.table, e.watermark, e.watermark,
			)
			rows, err := e.db.QueryContext(ctx, query, cursor, e.batchSize)
			if err != nil {
				out <- Record{Err: fmt.Errorf("query %s: %w", e.table, err)}
				return
			}

			cols, err := rows.Columns()
			if err != nil {
				rows.Close()
				out <- Record{Err: err}
				return
			}

			count := 0
			var lastSeen string

			for rows.Next() {
				values := make([]any, len(cols))
				pointers := make([]any, len(cols))
				for i := range values {
					pointers[i] = &values[i]
				}
				if err := rows.Scan(pointers...); err != nil {
					rows.Close()
					out <- Record{Err: err}
					return
				}

				data := make(map[string]any, len(cols))
				for i, col := range cols {
					data[col] = values[i]
				}

				// Track watermark
				if wv, ok := data[e.watermark]; ok {
					lastSeen = fmt.Sprintf("%v", wv)
				}

				id := ""
				if idv, ok := data["id"]; ok {
					id = fmt.Sprintf("%v", idv)
				}

				select {
				case out <- Record{
					ID:        id,
					Source:    "postgres:" + e.table,
					Data:      data,
					Timestamp: time.Now(),
				}:
				case <-ctx.Done():
					rows.Close()
					return
				}
				count++
			}
			rows.Close()

			if count == 0 {
				break // no more data
			}

			// Save checkpoint
			if lastSeen != "" {
				cursor = lastSeen
				e.checkpoint.Save(ctx, ckKey, lastSeen)
			}

			if count < e.batchSize {
				break // last batch
			}
		}
	}()

	return out, nil
}

// RedisCheckpointStore persists checkpoints in Redis.
type RedisCheckpointStore struct {
	client interface {
		Get(ctx context.Context, key string) (string, error)
		Set(ctx context.Context, key string, value any, expiration time.Duration) error
	}
	prefix string
}

func NewRedisCheckpointStore(client interface {
	Get(context.Context, string) (string, error)
	Set(context.Context, string, any, time.Duration) error
}, prefix string) *RedisCheckpointStore {
	return &RedisCheckpointStore{client: client, prefix: prefix}
}

func (s *RedisCheckpointStore) Load(ctx context.Context, key string) (string, error) {
	return s.client.Get(ctx, s.prefix+key)
}

func (s *RedisCheckpointStore) Save(ctx context.Context, key string, value string) error {
	return s.client.Set(ctx, s.prefix+key, value, 0)
}

// FileCheckpointStore persists checkpoints in a JSON file (simple/local).
type FileCheckpointStore struct {
	path string
	data map[string]string
	mu   sync.Mutex
}

func NewFileCheckpointStore(path string) (*FileCheckpointStore, error) {
	store := &FileCheckpointStore{
		path: path,
		data: make(map[string]string),
	}
	if data, err := os.ReadFile(path); err == nil {
		json.Unmarshal(data, &store.data)
	}
	return store, nil
}

func (s *FileCheckpointStore) Load(_ context.Context, key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data[key], nil
}

func (s *FileCheckpointStore) Save(_ context.Context, key string, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = value
	data, _ := json.MarshalIndent(s.data, "", "  ")
	return os.WriteFile(s.path, data, 0644)
}
```

### 2.2 Kafka Extractor

The Kafka extractor consumes messages from a topic using consumer-group offset management. Unlike the Postgres extractor which polls in batches, this one runs a continuous fetch loop. Each message is deserialized into a `Record` and sent downstream. Kafka offsets are committed only after the record is accepted by the output channel, which preserves at-least-once delivery guarantees. A pluggable deserializer function allows switching between JSON, Avro, or Protobuf without changing the extractor logic.

```go
package etl

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaExtractor reads records from a Kafka topic.
type KafkaExtractor struct {
	reader      *kafka.Reader
	deserialize func([]byte) (map[string]any, error)
}

// NewKafkaExtractor creates an extractor that reads from Kafka.
func NewKafkaExtractor(brokers []string, topic, groupID string) *KafkaExtractor {
	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:         brokers,
		Topic:           topic,
		GroupID:         groupID,
		MinBytes:        1,
		MaxBytes:        10 << 20, // 10 MiB
		MaxWait:         500 * time.Millisecond,
		CommitInterval:  time.Second,
		StartOffset:     kafka.LastOffset,
	})

	return &KafkaExtractor{
		reader: reader,
		deserialize: func(b []byte) (map[string]any, error) {
			var m map[string]any
			return m, json.Unmarshal(b, &m)
		},
	}
}

// WithDeserializer sets a custom deserializer function.
func (e *KafkaExtractor) WithDeserializer(fn func([]byte) (map[string]any, error)) *KafkaExtractor {
	e.deserialize = fn
	return e
}

// Extract streams records from Kafka.
func (e *KafkaExtractor) Extract(ctx context.Context) (<-chan Record, error) {
	out := make(chan Record, 1024)

	go func() {
		defer close(out)
		defer e.reader.Close()

		for {
			msg, err := e.reader.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				out <- Record{Err: fmt.Errorf("kafka fetch: %w", err)}
				time.Sleep(time.Second) // brief backoff on error
				continue
			}

			data, err := e.deserialize(msg.Value)
			if err != nil {
				out <- Record{
					ID:     fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset),
					Source: "kafka:" + msg.Topic,
					Err:    fmt.Errorf("deserialize: %w", err),
				}
				e.reader.CommitMessages(ctx, msg)
				continue
			}

			record := Record{
				ID:        fmt.Sprintf("%s:%d:%d", msg.Topic, msg.Partition, msg.Offset),
				Source:    "kafka:" + msg.Topic,
				Data:      data,
				Timestamp: msg.Time,
				Metadata: map[string]string{
					"partition": fmt.Sprintf("%d", msg.Partition),
					"offset":    fmt.Sprintf("%d", msg.Offset),
				},
			}

			select {
			case out <- record:
				e.reader.CommitMessages(ctx, msg)
			case <-ctx.Done():
				return
			}
		}
	}()

	return out, nil
}
```

### Junior to FAANG: what an extractor actually does

An extractor is the boundary between "someone else's system" and "your pipeline". That boundary is where most bugs live, because you are reasoning about a system whose internals you do not control. The Postgres extractor above reads rows in order of an `updated_at` watermark, writes a checkpoint after each batch, and resumes from the checkpoint on restart. Trace the control flow. On first run the checkpoint is empty so the cursor starts at the Unix epoch. The extractor queries `WHERE updated_at > epoch ORDER BY updated_at ASC LIMIT batch_size`. It streams rows to the output channel. After the batch it writes the maximum `updated_at` seen to the checkpoint store. The loop repeats until a batch returns fewer rows than `batch_size`, which signals the end of the currently available data.

Three subtle points matter for a junior reading this code. First, the `SELECT *` is convenient but dangerous. When the source adds a column your pipeline now carries an unexpected field, which may break downstream schema validation or pollute the warehouse. Always enumerate columns explicitly when you cross a trust boundary. Second, the checkpoint is written after the batch is pushed to the channel but before the downstream load has actually succeeded. If the process crashes between "channel accepted the row" and "warehouse wrote the row", the checkpoint advances but the row is lost. This is the "at-most-once" anti-pattern. Correct extractors either checkpoint after end-to-end acknowledgment or rely on idempotent loads so that reprocessing is safe. Third, equal watermark values are a trap. If ten rows share the same `updated_at` timestamp and your batch size is five, the second batch queries `updated_at > cursor` where cursor equals that timestamp, and the remaining five rows are skipped. Fix with `>=` plus a secondary key tiebreaker (`WHERE updated_at > ? OR (updated_at = ? AND id > ?)`), or use a strictly monotonic cursor like a sequence or LSN.

Worked example. Suppose the source emits 1,000 rows per second and your pipeline needs sub-minute freshness. Batch size of 1,000 and a loop that sleeps one second between batches is approximately correct. Batch size of 100,000 with a sleep of 60 seconds has the same throughput but 60 seconds of lag. The lesson is that freshness is a property of batch size and loop frequency together, and cost scales with the number of queries rather than the number of rows. Run fewer, larger queries if the source can handle them. Run more, smaller queries if the source is shared with OLTP traffic and you need to stay under the lock footprint.

Interview entry point. "Your extractor reads from Postgres and the CEO reports that the dashboard is missing rows. How do you debug?" A strong answer walks the chain. Check the DLQ for validation failures. Check the checkpoint value against the source's `MAX(updated_at)` to see if the extractor is behind. Check if a schema change added a column with a default that did not update `updated_at`. Check if a deploy restarted the pipeline and lost in-flight rows. Check if the row actually exists in the warehouse staging table but failed at the final merge. That chain is the whole job. Hiring managers probe for the chain, not for a single answer.

### Senior at FAANG: watermarks, pagination, CDC, and the failure catalog

At staff level, extractor design is dominated by three concerns. What is the correctness model. What is the cost and rate profile against the source. What is the observability posture when the source misbehaves. Every design decision maps to one of those three.

Cursor semantics drive correctness. A timestamp cursor works only if the source guarantees that `updated_at` is set on every row change and is monotonic per row. Postgres triggers, application code paths that forget to touch `updated_at`, and database clock skew after failover all break that assumption. A monotonically increasing ID cursor (`id > ?`) is correct for append-only sources but misses updates to old rows. A composite cursor (`(updated_at, id) > ?`) handles the duplicate-timestamp case but requires the source to have an index on the composite key or you pay a full scan. The correct cursor for transactional sources is the database's own replication position. Postgres gives you an LSN from `pg_logical_emit_message` and from logical replication slots. MySQL gives you a GTID or a binlog file plus position. SQL Server gives you an LSN via CDC tables. Debezium wraps these into a Kafka event stream so that downstream consumers do not have to speak the native replication protocol. If your source is a transactional database and you care about deletes, use CDC. Polling cursors cannot see deletes because a deleted row no longer exists to be selected.

CDC has its own failure catalog. Replication slots in Postgres hold WAL from being recycled until the slot advances. A Debezium consumer that stops advancing its slot will fill the primary's disk in hours on a busy database. Every production Postgres CDC setup needs alerting on `pg_replication_slots.confirmed_flush_lsn` lag, on `pg_wal_lsn_diff`, and on slot inactivity. MySQL binlog has a configurable retention (`binlog_expire_logs_seconds`). A CDC consumer that falls behind retention loses data, and the recovery path is a full resnapshot of the source followed by resume-from-new-binlog-position. Debezium's snapshot mode can be configured as `initial`, `never`, or `when_needed`, and the choice determines whether a restart incurs a minutes-to-hours reread of the source. AWS DMS and Fivetran wrap these decisions in a managed product but the underlying physics is identical.

Pagination for APIs deserves its own discipline. Offset pagination (`?page=5&size=100`) is the anti-pattern. It is O(N) per page on the server and it shifts rows under you when writes happen mid-scan, producing duplicates and gaps. Keyset pagination (`?after_id=12345&limit=100`) is O(log N) per page and stable under concurrent writes. Cursor pagination (`?starting_after=opaque_token`) is the form most mature APIs (Stripe, Shopify, GitHub) expose. Treat the cursor as opaque. Do not parse it, do not assume it is a timestamp or an ID, do not try to resume pagination from a cursor from a previous day without confirming the API supports it. Since-timestamp pagination (`?updated_since=2026-04-22T10:00:00Z`) is the fallback for APIs that offer nothing better, and it has all the pitfalls of a timestamp cursor plus the API's own clock and rounding behavior.

Rate limiting against external APIs is a shared fate with every other consumer of that API. The `golang.org/x/time/rate.Limiter` is the right primitive for per-process limits. For distributed rate limiting across replicas, a Redis-backed token bucket (`redis-cell` module or a Lua script) keeps the fleet under the vendor's global quota. Always honor `Retry-After` over your own backoff schedule. Always jitter your retries. Full jitter (a random duration between zero and the exponential backoff cap) outperforms equal jitter and no jitter in every measured benchmark, because it spreads retries uniformly across the backoff window rather than clustering them. If the API returns 429 with a `Retry-After` of five minutes, wait five minutes. If the API returns 503 without `Retry-After`, apply full jitter with a cap of 60 seconds and a maximum attempt count. Past the maximum, do not keep retrying. Route to DLQ and alert. Silent infinite retries are how a brief vendor outage becomes a multi-hour self-inflicted outage.

Schema drift detection at extract time is cheap and saves days of debugging. For Postgres, query `information_schema.columns` before each run and diff against the last known schema, stored in the checkpoint store. For REST APIs, keep a hash of the set of keys observed in the last N responses and alert when new keys appear or known keys disappear. For Kafka, use a schema registry with a compatibility policy (`BACKWARD`, `FORWARD`, `FULL`, or `NONE`) and fail the extractor when a message does not conform. The goal is not to prevent schema changes, which are inevitable, but to route them through a human review rather than absorbing them silently. A pipeline that silently ignores new columns will one year later have a warehouse table missing an important field that nobody noticed.

The extract-validate-load separation matters at this scale. The code above does all three in one process with in-memory channels. For a pipeline that handles more than a few million records per day, land the extracted records in object storage first. S3 or GCS with a prefix like `raw/source=postgres.orders/date=2026-04-22/batch=00042.parquet`. Each batch gets a manifest row in a small Postgres or DynamoDB table with columns for batch ID, source, row count, checksum, and schema version. The validator reads from the manifest, validates, and writes validated batches to a `validated/` prefix. The loader reads from `validated/` and writes to the warehouse with MERGE semantics. This decomposition gives you three properties that the monolithic pipeline cannot. Replay of any stage without re-hitting the source. Forensic debugging of any record by looking it up in S3. Parallel validation and load across batches when the source rate exceeds the loader's throughput.

Finally, the Kafka extractor above commits offsets after the channel accepts the record but before the downstream load acknowledges. That is at-most-once in the loader's failure model. The correct pattern for at-least-once is to commit the Kafka offset only after the loader confirms the record is durable in the sink. That requires threading an acknowledgment back up through the channel topology, either by using a second channel that the loader writes to when it has persisted a batch, or by moving offset commits into the loader itself. The simpler alternative, which most production pipelines use, is to make the sink idempotent via a deterministic key, so that a redelivery after a restart produces no duplicates at the sink. Idempotent sinks are cheaper than exactly-once protocols and buy you the same operational property: the output is correct after any number of retries. That is the design goal. Protocols are a means to it, not an end.

---
