## 52H.5 Redis Streams - XADD, XREAD, XLEN

Redis Streams are a native Redis data structure: an append-only, time-ordered log. Each entry has a unique ID in `millisecondsTimestamp-sequenceNumber` format. Entries are immutable once written.

> **Senior track**: Everything in this section applies unchanged to **Valkey**, the Linux Foundation fork of Redis 7.2 that most cloud providers (AWS ElastiCache, GCP Memorystore, Oracle OCI) defaulted to after the March 2024 Redis license change. XADD, XREADGROUP, XACK, XPENDING, XAUTOCLAIM, and XINFO are wire-compatible. The gap shows up only in the Redis 8.x-only features (idempotent stream production, some newer observability commands). if you target cloud-managed caches, write against the Redis 7.2 command surface and you stay portable across both ecosystems. The `go-redis/v9` client speaks the RESP protocol and works against Valkey without code changes.

### Stream IDs

- Auto-generated: `XADD mystream * field value` - Redis assigns `<now_ms>-<seq>`
- Partial: `XADD mystream 1699000000000-*` - pin timestamp, auto-increment sequence
- `"$"` in XREAD - only messages arriving after this XREAD call
- `"0-0"` or `"0"` - start from the beginning of the stream

The `Producer` wraps `XADD` with optional `MAXLEN` trimming to keep streams bounded. `AppendBatch` uses Redis pipelining to send multiple `XADD` commands in a single round trip. Below the producer, `SimpleReader` provides non-group reads via `XREAD` (useful for single-consumer scenarios or debugging), and `RangeReader` supports time-window queries by converting Go `time.Time` values to Redis Stream IDs.

```go
// file: internal/redis/streams/producer.go
package streams

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Producer writes entries to a Redis Stream.
type Producer struct {
	client *redis.Client
	stream string
	maxLen int64 // MAXLEN for approximate trimming (0 = no limit)
	logger *slog.Logger
}

// NewProducer creates a stream producer.
// maxLen=0 disables MAXLEN - use a positive value (e.g., 1_000_000) for bounded streams.
func NewProducer(client *redis.Client, stream string, maxLen int64, logger *slog.Logger) *Producer {
	return &Producer{
		client: client,
		stream: stream,
		maxLen: maxLen,
		logger: logger,
	}
}

// Entry represents a single stream entry's field-value pairs.
type Entry map[string]any

// Append adds an entry to the stream and returns the assigned entry ID.
func (p *Producer) Append(ctx context.Context, entry Entry) (string, error) {
	args := &redis.XAddArgs{
		Stream: p.stream,
		ID:     "*", // auto-generate ID
		Values: entry,
	}

	if p.maxLen > 0 {
		args.MaxLen = p.maxLen
		args.Approx = true // ~ prefix: faster, approximate trimming
	}

	id, err := p.client.XAdd(ctx, args).Result()
	if err != nil {
		return "", fmt.Errorf("xadd to stream %s: %w", p.stream, err)
	}

	p.logger.Debug("entry appended",
		slog.String("stream", p.stream),
		slog.String("id", id),
	)
	return id, nil
}

// AppendBatch adds multiple entries in a pipelined transaction.
func (p *Producer) AppendBatch(ctx context.Context, entries []Entry) ([]string, error) {
	if len(entries) == 0 {
		return nil, nil
	}

	pipe := p.client.Pipeline()
	cmds := make([]*redis.StringCmd, len(entries))

	for i, entry := range entries {
		args := &redis.XAddArgs{
			Stream: p.stream,
			ID:     "*",
			Values: entry,
		}
		if p.maxLen > 0 {
			args.MaxLen = p.maxLen
			args.Approx = true
		}
		cmds[i] = pipe.XAdd(ctx, args)
	}

	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("pipeline xadd to %s: %w", p.stream, err)
	}

	ids := make([]string, len(cmds))
	for i, cmd := range cmds {
		id, err := cmd.Result()
		if err != nil {
			return nil, fmt.Errorf("xadd result %d: %w", i, err)
		}
		ids[i] = id
	}

	p.logger.Debug("batch appended",
		slog.String("stream", p.stream),
		slog.Int("count", len(ids)),
	)
	return ids, nil
}

// Len returns the current number of entries in the stream.
func (p *Producer) Len(ctx context.Context) (int64, error) {
	n, err := p.client.XLen(ctx, p.stream).Result()
	if err != nil {
		return 0, fmt.Errorf("xlen %s: %w", p.stream, err)
	}
	return n, nil
}

// SimpleReader reads from a stream without consumer groups (one reader, no coordination).
type SimpleReader struct {
	client    *redis.Client
	stream    string
	lastID    string
	batchSize int64
	logger    *slog.Logger
}

// NewSimpleReader creates a reader starting from "0" (all messages) or "$" (new only).
func NewSimpleReader(client *redis.Client, stream string, startFromNew bool, batchSize int64, logger *slog.Logger) *SimpleReader {
	lastID := "0"
	if startFromNew {
		lastID = "$"
	}
	return &SimpleReader{
		client:    client,
		stream:    stream,
		lastID:    lastID,
		batchSize: batchSize,
		logger:    logger,
	}
}

// ReadOnce reads up to batchSize entries from the stream. Returns immediately.
func (r *SimpleReader) ReadOnce(ctx context.Context) ([]redis.XMessage, error) {
	result, err := r.client.XRead(ctx, &redis.XReadArgs{
		Streams: []string{r.stream, r.lastID},
		Count:   r.batchSize,
	}).Result()

	if err != nil {
		if err == redis.Nil {
			return nil, nil // No new messages
		}
		return nil, fmt.Errorf("xread from %s: %w", r.stream, err)
	}

	if len(result) == 0 || len(result[0].Messages) == 0 {
		return nil, nil
	}

	messages := result[0].Messages
	// Advance cursor to the last received ID.
	r.lastID = messages[len(messages)-1].ID

	return messages, nil
}

// BlockingRead blocks up to blockTimeout waiting for new messages.
// Use blockTimeout=0 to block indefinitely (not recommended in production - use a timeout).
func (r *SimpleReader) BlockingRead(ctx context.Context, blockTimeout time.Duration) ([]redis.XMessage, error) {
	if blockTimeout == 0 {
		blockTimeout = 5 * time.Second // Safety: never block forever.
	}

	result, err := r.client.XRead(ctx, &redis.XReadArgs{
		Streams: []string{r.stream, r.lastID},
		Count:   r.batchSize,
		Block:   blockTimeout,
	}).Result()

	if err != nil {
		if err == redis.Nil {
			return nil, nil // Timeout - no messages arrived.
		}
		if ctx.Err() != nil {
			return nil, nil // Context canceled - not an error.
		}
		return nil, fmt.Errorf("xread block from %s: %w", r.stream, err)
	}

	if len(result) == 0 || len(result[0].Messages) == 0 {
		return nil, nil
	}

	messages := result[0].Messages
	r.lastID = messages[len(messages)-1].ID
	return messages, nil
}

// RangeReader reads entries by ID range (for time-window queries or replay).
type RangeReader struct {
	client *redis.Client
	stream string
	logger *slog.Logger
}

// NewRangeReader creates a range reader.
func NewRangeReader(client *redis.Client, stream string, logger *slog.Logger) *RangeReader {
	return &RangeReader{client: client, stream: stream, logger: logger}
}

// ReadRange returns entries between start and end IDs (inclusive).
// Use "-" for start-of-stream, "+" for end-of-stream.
func (rr *RangeReader) ReadRange(ctx context.Context, start, end string, count int64) ([]redis.XMessage, error) {
	messages, err := rr.client.XRange(ctx, rr.stream, start, end).Result()
	if err != nil {
		return nil, fmt.Errorf("xrange %s [%s, %s]: %w", rr.stream, start, end, err)
	}

	if count > 0 && int64(len(messages)) > count {
		messages = messages[:count]
	}

	return messages, nil
}

// ReadTimeWindow reads entries within a wall-clock time window.
func (rr *RangeReader) ReadTimeWindow(ctx context.Context, from, to time.Time, count int64) ([]redis.XMessage, error) {
	// Redis Stream IDs embed millisecond timestamps.
	startID := fmt.Sprintf("%d-0", from.UnixMilli())
	endID := fmt.Sprintf("%d-+", to.UnixMilli())
	return rr.ReadRange(ctx, startID, endID, count)
}
```

### Junior -> FAANG: Getting XADD and XREAD Right the First Time

Redis Streams have a few sharp edges that trip up engineers who come from Kafka or JetStream backgrounds.

The first: `XREAD` with `"$"` as the starting ID only returns messages that arrive after the `XREAD` call itself. If your reader starts up 5 minutes after messages were published, `"$"` means you miss all of them. Use `"0"` to read from the beginning of the stream, and advance your cursor with each batch. The `SimpleReader.lastID` field in the code above tracks this cursor. Never hardcode `"$"` in a reader that needs to catch up after a restart.

The second: approximate trimming (`MAXLEN ~ 1000000`) is almost always correct, and exact trimming (`MAXLEN = 1000000`) is almost always wrong for production. Exact trimming blocks Redis while it compacts the stream to the precise length. Approximate trimming allows the stream to overshoot by a small factor (typically less than 10%) and trims lazily during normal write operations. The performance difference is significant at high write rates.

The third: `BlockingRead` with a non-zero timeout is the right default. The `blockTimeout = 5 * time.Second` safety default in the code above prevents goroutine leaks when the application shuts down and the context is canceled but a blocking XREAD is still waiting. Always verify that your shutdown path calls `cancel()` before the XREAD goroutine would otherwise block indefinitely.

### Senior @ FAANG: Designing Redis Streams Producers for Reliability and Observability

The `Producer` type here covers the basic write path, but a platform-grade producer needs three capabilities the code does not include.

The first is write latency instrumentation. Every `XADD` call should record its latency in a histogram. At high write rates, P99 latency spikes before P50 does, and without histograms you cannot distinguish a slow Redis (P99 increasing) from a blocked client (P50 increasing). The histogram labels should include the stream name so you can distinguish slow streams from fast ones in a multi-stream deployment.

The second is producer-side idempotency. The `Append` method generates a new auto-ID on every call. If the caller retries after a network error, the entry is written twice. For streams that feed event-sourcing projections or billing systems, duplicate entries are correctness failures. The mitigation is for the caller to generate a deterministic entry ID before calling `Append`, and for `Append` to pass that ID to `XADD` instead of `"*"`. Redis Stream IDs must be monotonically increasing, so the deterministic ID must be derived from something that increases over time (a UUID with an embedded timestamp is common, as long as you serialize writes for a given producer to avoid clock skew conflicts).

The third is stream depth monitoring from the producer side. The `Len` method provides a point-in-time count, but a useful producer emits a Prometheus gauge of `XLEN` after every batch of writes and alerts when the depth exceeds a threshold proportional to `MAXLEN`. This gives you advance warning before the stream starts trimming entries that a slow consumer might not have processed yet. Embed this in the `Producer` as an optional background goroutine that polls `XLen` on a configurable interval and exports the result.

---
