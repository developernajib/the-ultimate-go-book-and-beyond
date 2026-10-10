## Part 15: Performance Optimization

A chat application can easily become a bottleneck at the database layer because every message triggers a write operation. When thousands of users are chatting simultaneously, inserting each message individually creates enormous pressure on PostgreSQL. In this section, you will implement message batching, a technique that collects messages in memory and flushes them to the database in bulk at regular intervals. This dramatically reduces the number of database round-trips and allows your system to handle significantly higher message throughput without upgrading hardware.

### 15.1 Message Batching

The message batcher collects incoming messages in a buffered channel and flushes them to PostgreSQL in bulk inserts on a configurable interval or when the batch reaches a size threshold. This reduces per-message write overhead by an order of magnitude.

```go
// Batch messages to reduce database writes
type MessageBatcher struct {
	messages chan *models.Message
	store    *storage.PostgresStore
	batchSize int
	flushInterval time.Duration
}

func NewMessageBatcher(store *storage.PostgresStore) *MessageBatcher {
	b := &MessageBatcher{
		messages:      make(chan *models.Message, 1000),
		store:         store,
		batchSize:     100,
		flushInterval: time.Second,
	}
	go b.run()
	return b
}

func (b *MessageBatcher) run() {
	batch := make([]*models.Message, 0, b.batchSize)
	ticker := time.NewTicker(b.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case msg := <-b.messages:
			batch = append(batch, msg)
			if len(batch) >= b.batchSize {
				b.flush(batch)
				batch = make([]*models.Message, 0, b.batchSize)
			}

		case <-ticker.C:
			if len(batch) > 0 {
				b.flush(batch)
				batch = make([]*models.Message, 0, b.batchSize)
			}
		}
	}
}

func (b *MessageBatcher) flush(batch []*models.Message) {
	// Bulk insert messages
	ctx := context.Background()
	if err := b.store.BulkInsertMessages(ctx, batch); err != nil {
		log.Printf("Error flushing message batch: %v", err)
	}
}
```

### 15.2 Connection Pooling

Connection pool tuning ensures the application does not exhaust database connections under peak load. The settings below cap the pool size, set idle connection timeouts, and limit connection lifetime to prevent stale connections.

```go
// Optimized database connection pooling
func initOptimizedDB(cfg config.DatabaseConfig) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}

	// Production-optimized settings
	db.SetMaxOpenConns(100)        // Max connections
	db.SetMaxIdleConns(25)         // Idle connections
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(10 * time.Minute)

	return db, nil
}

// Connection pooling for Redis
func initOptimizedRedis(cfg config.RedisConfig) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:         cfg.Addr,
		Password:     cfg.Password,
		DB:           cfg.DB,
		PoolSize:     50,              // Connections per CPU
		MinIdleConns: 10,
		MaxRetries:   3,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolTimeout:  4 * time.Second,
	})
}
```

### Junior → FAANG: Performance Optimization as a Measurement Discipline

The message batching optimization in this chapter is the right solution to the right problem (too many individual INSERT operations). But the lesson is not "always batch writes." The lesson is: measure first, then optimize the measured bottleneck.

Before implementing batching, confirm that the bottleneck is individual INSERT throughput. Run `EXPLAIN ANALYZE` on a single INSERT and measure the actual execution time. If individual inserts are completing in under 1ms, batching may not be necessary at your current scale. If they are taking 5-10ms due to write-ahead log synchronization, batching will help.

Batching introduces a tradeoff: message delivery is now delayed by up to the batch interval (typically 50-100ms). For a chat application, 100ms additional latency may be acceptable for high-throughput scenarios but noticeable for low-throughput direct messages. Document this tradeoff and consider making the batch size and interval configurable per traffic pattern.

### Senior @ FAANG: Performance Optimization as a Platform Service

At senior level, the message batching pattern is generalized into a platform primitive: a write buffer service that accepts high-throughput writes, buffers them, and flushes to the downstream store at configurable intervals. Application teams configure the buffer size and flush interval. The platform team owns the reliability guarantees: at-least-once delivery, bounded memory usage, and graceful shutdown that flushes the buffer before exit.

Connection pooling is the second performance lever for the storage layer. PostgreSQL connections are expensive: each connection requires a process (or thread on PostgreSQL 14+), memory allocation, and authentication overhead. A connection pool reuses established connections across requests. The optimal pool size is determined by the number of concurrent database operations, not the number of concurrent WebSocket connections. Measuring pool wait time (how long requests wait for a free connection) is the metric that tells you when to increase the pool size.

Memory allocation profiling is the performance discipline most junior engineers skip. In Go, the garbage collector can introduce latency spikes when it runs on a heavily allocated heap. For a low-latency chat path, allocating a new struct per message per connection per operation adds up. Using `sync.Pool` for frequently allocated, short-lived objects (message buffers, event structs) reduces GC pressure significantly. Profile first with `pprof` to confirm allocation is the bottleneck before adding pool complexity.

---
