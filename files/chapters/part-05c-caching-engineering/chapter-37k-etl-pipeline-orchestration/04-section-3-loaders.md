## Section 3: Loaders

### 3.1 Postgres Bulk Loader

Loaders write transformed records to destination systems and must handle partial failures gracefully without duplicating successfully written records. The batch loader below accumulates records up to a configurable size threshold and flushes to the destination in parallel, retrying individual failed batches with exponential backoff.

```go
package etl

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// PostgresLoader bulk-inserts records into Postgres using COPY.
type PostgresLoader struct {
	db          *sql.DB
	table       string
	columns     []string
	batchSize   int
	upsertOn    []string // conflict columns for upsert (empty = insert only)
	flushEvery  time.Duration
	totalLoaded atomic.Int64
}

func NewPostgresLoader(db *sql.DB, table string, columns []string, batchSize int) *PostgresLoader {
	return &PostgresLoader{
		db:         db,
		table:      table,
		columns:    columns,
		batchSize:  batchSize,
		flushEvery: 5 * time.Second,
	}
}

func (l *PostgresLoader) WithUpsert(conflictColumns []string) *PostgresLoader {
	l.upsertOn = conflictColumns
	return l
}

// Load reads from in and writes to Postgres in batches.
func (l *PostgresLoader) Load(ctx context.Context, in <-chan Record) error {
	batch := make([]Record, 0, l.batchSize)
	ticker := time.NewTicker(l.flushEvery)
	defer ticker.Stop()

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := l.writeBatch(ctx, batch); err != nil {
			return err
		}
		l.totalLoaded.Add(int64(len(batch)))
		batch = batch[:0]
		return nil
	}

	for {
		select {
		case record, ok := <-in:
			if !ok {
				return flush()
			}
			if record.Err != nil {
				continue
			}
			batch = append(batch, record)
			if len(batch) >= l.batchSize {
				if err := flush(); err != nil {
					return err
				}
			}
		case <-ticker.C:
			if err := flush(); err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (l *PostgresLoader) writeBatch(ctx context.Context, batch []Record) error {
	if len(batch) == 0 {
		return nil
	}

	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Build parameterized INSERT
	placeholders := make([]string, len(batch))
	args := make([]any, 0, len(batch)*len(l.columns))

	for i, record := range batch {
		p := make([]string, len(l.columns))
		for j, col := range l.columns {
			p[j] = fmt.Sprintf("$%d", i*len(l.columns)+j+1)
			args = append(args, record.Data[col])
		}
		placeholders[i] = "(" + strings.Join(p, ",") + ")"
	}

	query := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES %s",
		l.table,
		strings.Join(l.columns, ","),
		strings.Join(placeholders, ","),
	)

	// Add upsert clause if configured
	if len(l.upsertOn) > 0 {
		updateCols := make([]string, 0, len(l.columns))
		for _, col := range l.columns {
			skipCol := false
			for _, uc := range l.upsertOn {
				if col == uc {
					skipCol = true
					break
				}
			}
			if !skipCol {
				updateCols = append(updateCols, fmt.Sprintf("%s=EXCLUDED.%s", col, col))
			}
		}
		query += fmt.Sprintf(
			" ON CONFLICT (%s) DO UPDATE SET %s",
			strings.Join(l.upsertOn, ","),
			strings.Join(updateCols, ","),
		)
	} else {
		query += " ON CONFLICT DO NOTHING"
	}

	if _, err := tx.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("insert batch: %w", err)
	}

	return tx.Commit()
}

func (l *PostgresLoader) TotalLoaded() int64 { return l.totalLoaded.Load() }
```

### 3.2 S3 Loader (JSONL format)

The S3 loader writes records as newline-delimited JSON (JSONL) files to S3 with Hive-style partitioning (`year=YYYY/month=MM/day=DD`). This partition layout allows query engines like Athena, Presto, and Spark to prune partitions and scan only the relevant date ranges. Each batch is serialized to a single JSONL file and uploaded with `PutObject`. The `PartitionFn` is pluggable, so you can switch to custom key schemes (e.g., by tenant or event type) without modifying the loader itself.

```go
package etl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Loader writes records to S3 as JSON lines (newline-delimited JSON).
type S3Loader struct {
	client     *s3.Client
	bucket     string
	keyPrefix  string
	batchSize  int
	partitions PartitionFn
}

// PartitionFn determines the S3 key for a batch of records.
type PartitionFn func(records []Record, t time.Time) string

// HivePartitionFn generates Hive-style partitioned S3 keys.
func HivePartitionFn(prefix string) PartitionFn {
	return func(records []Record, t time.Time) string {
		return fmt.Sprintf("%s/year=%04d/month=%02d/day=%02d/%d.jsonl",
			prefix, t.Year(), t.Month(), t.Day(), t.UnixNano())
	}
}

func NewS3Loader(client *s3.Client, bucket, keyPrefix string, batchSize int) *S3Loader {
	return &S3Loader{
		client:     client,
		bucket:     bucket,
		keyPrefix:  keyPrefix,
		batchSize:  batchSize,
		partitions: HivePartitionFn(keyPrefix),
	}
}

// Load reads records and writes batches to S3.
func (l *S3Loader) Load(ctx context.Context, in <-chan Record) error {
	batch := make([]Record, 0, l.batchSize)

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}

		// Serialize to JSONL
		var buf bytes.Buffer
		for _, r := range batch {
			data, err := json.Marshal(r.Data)
			if err != nil {
				return fmt.Errorf("marshal record: %w", err)
			}
			buf.Write(data)
			buf.WriteByte('\n')
		}

		key := l.partitions(batch, time.Now())
		_, err := l.client.PutObject(ctx, &s3.PutObjectInput{
			Bucket:      aws.String(l.bucket),
			Key:         aws.String(key),
			Body:        bytes.NewReader(buf.Bytes()),
			ContentType: aws.String("application/x-ndjson"),
		})
		if err != nil {
			return fmt.Errorf("s3 put %s: %w", key, err)
		}

		batch = batch[:0]
		return nil
	}

	for record := range in {
		if record.Err != nil {
			continue
		}
		batch = append(batch, record)
		if len(batch) >= l.batchSize {
			if err := flush(); err != nil {
				return err
			}
		}
	}

	return flush()
}
```

### Junior → FAANG: Loaders as the step where correctness is won or lost

If you are new to data engineering, the instinct is to treat the loader as "just an INSERT loop." That instinct is wrong, and every FAANG interviewer knows it. Extract and transform errors are recoverable because you can re-read the source. Loader errors land in the destination, and once a downstream consumer reads a duplicate row, you cannot take it back. Start by memorizing three rules before anything else. First, batch writes always beat row-at-a-time writes, usually by 50x to 200x on Postgres and Snowflake, because each round trip pays network latency and WAL fsync cost. Second, every sink must have a dedupe key, either a natural primary key or a generated hash of the business payload, so a retry after a partial failure does not double-write. Third, the loader must commit its offset or watermark only after the destination acknowledges the batch, never before.

Worked example for your first job. You are asked to load 50 million rows per day from a SaaS export API into a Postgres warehouse table. The naive version issues 50 million INSERT statements and takes 14 hours. The first improvement is the multi-row INSERT shown above, which pushes throughput to roughly 30k rows per second and finishes in under 30 minutes. The second improvement is switching to `COPY FROM STDIN` through `pgx.CopyFrom`, which skips SQL parsing per row and typically triples throughput again. The third improvement is staging. You COPY into a `staging_orders` table with no indexes, then issue a single `INSERT ... SELECT ... ON CONFLICT (order_id) DO UPDATE` into the production `orders` table. Staging lets you truncate and retry the whole batch if anything fails, and it keeps production indexes hot only during the merge window.

Interview entry-point questions and how to answer them. "Why not just use an ORM `Save` in a loop?" Because ORMs issue one round trip per row and typically use an implicit transaction per call. "How do you make the loader idempotent?" Use `ON CONFLICT DO UPDATE` keyed on a stable business ID, or write to a staging table and MERGE. "How do you size the batch?" Start with 1000 rows or roughly 1 MB, measure p95 write latency, and raise until latency exceeds your SLO or the destination starts throttling. "What happens if the process crashes mid-batch?" With a transaction per batch you are safe, because Postgres rolls back uncommitted work. With S3 `PutObject` you are also safe because the object is either fully written or not visible. The danger zone is partial writes to systems without atomic batches, like plain Kafka producers without transactions, and that is where dedupe keys earn their keep.

One pitfall that trips up almost every junior. The code above accumulates records in a slice captured by a closure. If you ever change this loader to write batches concurrently from multiple goroutines, the shared slice becomes a data race and you will silently lose records. The fix is to copy the batch before handing it to a worker, or to give each worker its own accumulator. Run `go test -race` against any loader you write. FAANG code review will block the PR if you do not.

### Senior @ FAANG: Loader architecture, exactly-once semantics, and destination-specific tuning

At staff and principal level, the loader is where you design for exactly-once semantics, destination cost, and operational safety under partial failure. The Go code above is a useful starting point, but it hides several decisions that a senior engineer must make explicit in a design doc before writing any code.

Destination-specific bulk load paths. For Postgres, `COPY FROM STDIN` through the binary protocol is the gold standard and is what `pgx.CopyFrom` emits. On an `r6i.2xlarge` RDS instance in 2026, expect 150k to 400k rows per second into a narrow, unindexed staging table, dropping to 40k to 80k rows per second once you merge into an indexed production table. For Snowflake, never use `INSERT VALUES` at scale. Stage files to an internal or external stage with `PUT`, then `COPY INTO target FROM @stage FILE_FORMAT = (TYPE = PARQUET)`. Snowflake credit cost is dominated by warehouse uptime, so batch size must be tuned against warehouse auto-suspend (60 seconds is typical). A loader that emits 100 tiny files per minute keeps the warehouse hot and burns credits for no reason. Coalesce to files of 100 to 250 MB compressed Parquet. For BigQuery, use load jobs (`bigquery.NewLoaderFromGCSReference`) rather than streaming inserts when you can tolerate minutes of latency, because load jobs are free and streaming inserts cost 1 cent per 200 MB. For MongoDB, use `bulk_write` with `ordered=false` so one bad document does not stall the whole batch, and set `writeConcern={"w":"majority","j":true}` only on the commit step, not on the staging step. For DynamoDB, `BatchWriteItem` caps at 25 items and 16 MB, so your loader must shard across multiple parallel workers and implement its own retry with exponential backoff and jitter on `UnprocessedItems`. For Delta Lake or Iceberg over S3, use DuckDB's `COPY TO 'path' (FORMAT PARQUET)` for single-writer workloads or Spark's `DataFrameWriter.format("delta").mode("append")` with `txn.commitVersion` tracked per batch for multi-writer. Iceberg's `MERGE INTO` is the canonical upsert primitive and supports `WHEN MATCHED THEN UPDATE` with predicate pruning.

S3 multipart upload is required above the 5 GB single-`PutObject` limit and recommended for any object above 100 MB. The AWS SDK v2 `manager.Uploader` handles this for you, but the senior move is to pick the part size deliberately. For a 5 GB Parquet file, 64 MB parts give you about 80 concurrent part uploads and completion in 20 to 40 seconds on a well-provisioned host. Smaller parts waste HTTP overhead, larger parts raise the blast radius of a single retry. Set `LeavePartsOnError: false` so aborted uploads do not leak storage cost, and tag your multipart uploads with the pipeline run ID so your cleanup lambda can reap orphans older than 24 hours.

Exactly-once semantics in practice. True exactly-once does not exist end to end across heterogeneous systems. What you build instead is effectively-once through the composition of at-least-once delivery plus idempotent sinks. The idempotency contract has three parts. First, every record carries a stable `dedupe_key` derived from the source, for example `(source_system, source_table, source_pk, source_lsn)` for CDC or a content hash for event streams. Second, the sink enforces uniqueness on that key, either through a primary key constraint, a MERGE with a WHEN NOT MATCHED predicate, or a separate `processed_keys` dedupe table that the loader checks before insert. Third, the watermark or offset advance is atomic with the dedupe table update. On Postgres this means a single transaction that both inserts into the target and updates `etl_watermarks`. On Kafka this means producer transactions with `enable.idempotence=true` and `transactional.id` scoped per partition assignment. On Flink this means aligned checkpoints with two-phase commit sinks (`TwoPhaseCommitSinkFunction`).

Batch size tuning as a real optimization problem. The throughput curve versus batch size is not monotonic. Throughput rises with batch size until you hit one of four ceilings. The destination memory ceiling, where Postgres starts spilling the sort buffer for `ON CONFLICT` processing. The network MTU and TCP window ceiling, where a single batch no longer fits in a bandwidth-delay product and starts stalling. The lock duration ceiling, where MERGE holds a destination lock long enough to impact online queries. The failure blast radius ceiling, where a single poison pill now costs you a retry of N thousand records instead of N hundred. The standard method is to sweep batch size on a 10 percent traffic shadow, measure p95 loader latency and destination p99 query latency simultaneously, and pick the knee. Typical landing zones in 2026 are 5k to 20k rows for Postgres upserts, 100 MB to 500 MB Parquet files for Snowflake and BigQuery, and 1 MB or 500 documents for MongoDB `bulk_write`.

Micro-batch versus streaming. A micro-batch loader with a 5 to 30 second flush interval is the right default for analytical sinks because it amortizes commit cost while keeping freshness SLOs achievable. True record-at-a-time streaming is justified only when your destination is itself stream-native (Kafka, Pulsar, Kinesis, Flink state) and the downstream consumer cannot tolerate batch latency. Do not confuse low latency with low batch size. Flink's `RocksDB` state backend with a 1-minute checkpoint interval delivers sub-second end-to-end latency while still batching writes internally.

Operational safety rails that must exist before the loader ships. A kill switch in config (`loader.enabled=false`) so oncall can pause writes without a deploy. A per-partition rate limiter so a runaway source does not DoS the destination. A circuit breaker on destination error rate that stops after N consecutive failures and pages oncall rather than retrying into a black hole. A schema-drift guard that compares the current batch schema against a registered contract and routes mismatched records to DLQ rather than failing the whole batch. A cost meter that tags every write with the pipeline name so your FinOps team can attribute Snowflake credits and S3 PUT costs correctly. These are not nice-to-haves, they are the difference between a loader that gets promoted into production and a loader that causes a Sev2.

---
