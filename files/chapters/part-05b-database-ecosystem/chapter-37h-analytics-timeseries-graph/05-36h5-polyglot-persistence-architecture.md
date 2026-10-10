## 37H.5 Polyglot Persistence Architecture

### Combining Multiple Databases

Real production services rarely use a single database for everything. PostgreSQL handles ACID transactions, Redis serves cached reads in under a millisecond, ClickHouse runs analytical aggregations across billions of rows, Elasticsearch powers full-text search with faceted filtering, and Neo4j traverses relationship graphs for recommendations. Polyglot persistence is not about adopting every database you have heard of - it is about matching the *access pattern* (point lookup vs range scan vs multi-hop traversal vs aggregate-over-billions) to the engine whose internal data structures are built for it, then paying the operational cost of one more system only when the gain justifies it.

**The hard part is data synchronization.** When PostgreSQL is the source of truth and ClickHouse / Elasticsearch / Neo4j are downstream projections, you need a reliable way to propagate changes without dual writes that can diverge on partial failure. Two patterns dominate:

- **Change Data Capture (CDC)**: tail the PostgreSQL WAL with Debezium, ship to Kafka, and fan out to each downstream consumer. Eventual consistency, survives crashes, no application changes.
- **Transactional outbox**: in the same transaction that writes to PostgreSQL, append an event to an `outbox` table. A separate relay process reads the outbox and publishes to Kafka or directly to downstreams. Simpler than CDC, works with any database, but adds a relay.

The `ProductService` below routes each operation to the database best suited for it, keeping PostgreSQL as the source of truth while offloading specialized workloads. For clarity the example propagates downstream writes via `go func()` goroutines. In production, replace those with an outbox write inside the same transaction and a dedicated relay consumer.

```go
package polyglot

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
	pgPool "github.com/jackc/pgx/v5/pgxpool"
	chDriver "github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	es "github.com/elastic/go-elasticsearch/v8"
	neo4jDriver "github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

// ProductService demonstrates polyglot persistence
// Each database used for what it's best at

type ProductService struct {
	pg        *pgPool.Pool     // primary data store (OLTP)
	redis     *redis.Client    // caching + rate limiting
	ch        chDriver.Conn    // analytics queries (OLAP)
	elastic   *es.Client       // full-text search
	neo4j     neo4jDriver.DriverWithContext // recommendations
	log       *slog.Logger
}

// GetProduct: multi-layer cache strategy
// L1: Redis cache (1ms) → L2: PostgreSQL (5ms) → side-load to Redis
func (s *ProductService) GetProduct(ctx context.Context, id string) (*Product, error) {
	// L1: Redis cache
	cached, err := s.redis.Get(ctx, "product:"+id).Result()
	if err == nil {
		var p Product
		if err := json.Unmarshal([]byte(cached), &p); err == nil {
			return &p, nil
		}
	}

	// L2: PostgreSQL (source of truth)
	var p Product
	err = s.pg.QueryRow(ctx,
		`SELECT id, name, description, price_cents, stock, category FROM products WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.PriceCents, &p.Stock, &p.Category)
	if err != nil {
		return nil, fmt.Errorf("get product from pg: %w", err)
	}

	// Populate Redis cache
	if b, err := json.Marshal(p); err == nil {
		s.redis.Set(ctx, "product:"+id, b, 5*time.Minute)
	}
	return &p, nil
}

// SearchProducts: Elasticsearch for full-text + faceted search
func (s *ProductService) SearchProducts(ctx context.Context, query string, filters SearchFilters) ([]Product, error) {
	// Delegate to Elasticsearch
	// Results are product IDs with relevance scores
	ids, err := s.searchProductIDs(ctx, query, filters)
	if err != nil {
		return nil, err
	}

	// Fetch full details from PostgreSQL (or Redis cache)
	var products []Product
	for _, id := range ids {
		p, err := s.GetProduct(ctx, id)
		if err != nil {
			s.log.Warn("failed to fetch product", "id", id, "err", err)
			continue
		}
		products = append(products, *p)
	}
	return products, nil
}

// PurchaseProduct: PostgreSQL for ACID transaction + side effects
func (s *ProductService) PurchaseProduct(ctx context.Context, userID, productID string, qty int) error {
	// 1. PostgreSQL: ACID transaction (deduct stock, create order)
	tx, err := s.pg.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var stock int
	err = tx.QueryRow(ctx,
		`SELECT stock FROM products WHERE id = $1 FOR UPDATE`, productID,
	).Scan(&stock)
	if err != nil {
		return err
	}
	if stock < qty {
		return fmt.Errorf("insufficient stock")
	}

	_, err = tx.Exec(ctx,
		`UPDATE products SET stock = stock - $1 WHERE id = $2`, qty, productID)
	if err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// 2. Redis: invalidate cache
	s.redis.Del(ctx, "product:"+productID)

	// 3. ClickHouse: record analytics event (async)
	go func() {
		ctx := context.Background()
		_ = s.recordPurchaseEvent(ctx, userID, productID, qty)
	}()

	// 4. Neo4j: record relationship for recommendations (async)
	go func() {
		ctx := context.Background()
		_ = s.recordPurchaseGraph(ctx, userID, productID)
	}()

	// 5. Elasticsearch: may need to update stock availability
	go func() {
		ctx := context.Background()
		_ = s.updateSearchIndex(ctx, productID)
	}()

	return nil
}

// GetRecommendations: Neo4j for graph traversal
func (s *ProductService) GetRecommendations(ctx context.Context, userID string) ([]Product, error) {
	// Get product IDs from graph recommendation
	session := s.neo4j.NewSession(ctx, neo4jDriver.SessionConfig{AccessMode: neo4jDriver.AccessModeRead})
	defer session.Close(ctx)

	result, err := session.ExecuteRead(ctx, func(tx neo4jDriver.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MATCH (me:User {id: $uid})-[:FOLLOWS*1..2]->(other:User)
			MATCH (other)-[:PURCHASED]->(p:Product)
			WHERE NOT (me)-[:PURCHASED]->(p)
			WITH p.id AS product_id, count(*) AS score
			ORDER BY score DESC LIMIT 10
			RETURN product_id
		`, map[string]any{"uid": userID})
		if err != nil {
			return nil, err
		}
		return result.Collect(ctx)
	})
	if err != nil {
		return nil, err
	}

	var products []Product
	for _, record := range result.([]*neo4jDriver.Record) {
		pid := record.Values[0].(string)
		p, err := s.GetProduct(ctx, pid)
		if err == nil {
			products = append(products, *p)
		}
	}
	return products, nil
}

// GetAnalytics: ClickHouse for fast OLAP queries
func (s *ProductService) GetProductAnalytics(ctx context.Context, productID string, from, to time.Time) (*ProductAnalytics, error) {
	row := s.ch.QueryRow(ctx, `
		SELECT
			count() AS total_purchases,
			sum(quantity) AS total_units,
			sum(total_price_cents) AS total_revenue_cents,
			avg(total_price_cents) AS avg_order_value_cents,
			uniqExact(user_id) AS unique_buyers
		FROM orders_analytics
		WHERE product_id = ?
		  AND created_at BETWEEN ? AND ?
	`, productID, from, to)

	var analytics ProductAnalytics
	err := row.Scan(&analytics.TotalPurchases, &analytics.TotalUnits,
		&analytics.TotalRevenueCents, &analytics.AvgOrderValueCents, &analytics.UniqueBuyers)
	return &analytics, err
}

func (s *ProductService) searchProductIDs(ctx context.Context, query string, filters SearchFilters) ([]string, error) {
	return nil, nil
}

func (s *ProductService) recordPurchaseEvent(ctx context.Context, userID, productID string, qty int) error {
	return nil
}

func (s *ProductService) recordPurchaseGraph(ctx context.Context, userID, productID string) error {
	return nil
}

func (s *ProductService) updateSearchIndex(ctx context.Context, productID string) error {
	return nil
}

type Product struct {
	ID          string
	Name        string
	Description string
	PriceCents  int64
	Stock       int
	Category    string
}

type SearchFilters struct {
	Category      string
	MinPriceCents int64
	MaxPriceCents int64
}

type ProductAnalytics struct {
	TotalPurchases      int64
	TotalUnits          int64
	TotalRevenueCents   int64
	AvgOrderValueCents  int64
	UniqueBuyers        int64
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

The sample code above uses `go func()` fire-and-forget goroutines to update ClickHouse, Neo4j, and Elasticsearch after the Postgres commit. This is the **dual-write anti-pattern** in its most naked form, and it is exactly what you must not do in production. If the process crashes between `tx.Commit` and the downstream goroutines running, Postgres has the new state and the other systems do not. If a downstream write fails, nothing retries it. If the process is restarted, the retry state is gone. You will diverge, quietly, for months, until someone notices the recommendation engine suggesting products the user already bought.

The first-job version of the fix is the **transactional outbox**. In the same Postgres transaction that updates `products`, insert a row into an `outbox` table with the event payload. A separate worker polls `outbox` (or uses `LISTEN/NOTIFY`), publishes each event to Kafka, and marks it as sent. Because the outbox insert is in the same transaction as the business write, they commit or roll back together. The worker can retry forever until Kafka accepts the message. Downstream consumers are idempotent (key by event ID) so duplicate deliveries do not double-count. Study this pattern. You will implement it at least three times in your career.

Worked example of the access-pattern reasoning. You are asked to build a product page that shows price, reviews count, recommended products, search suggestions, and a purchase-per-day chart. Five panels, five access patterns. Price is a point lookup on a unique key, so Postgres with a primary-key index (or Redis cache in front) is right. Reviews count is a frequently-read aggregate on an append-heavy table, so you cache the count in Redis with an invalidation on write, or denormalize it in the products table. Recommended products is "people who bought X also bought Y," a multi-hop traversal, so Neo4j. Search suggestions are prefix and fuzzy match on product names, so Elasticsearch or Meilisearch. The daily chart is a GROUP BY date on millions of orders, so ClickHouse. Five engines on one page is not over-engineering, it is matching tool to job. The anti-pattern is using one engine for all five because you are afraid of operational complexity.

Interview entry-points. What is a system of record versus a system of reference. (SoR is the source of truth, SoReference is a derived projection optimized for a read pattern.) Why is dual-write wrong. (Partial failure causes divergence.) What does Debezium do. (Tails the Postgres WAL and emits change events to Kafka.) What is eventual consistency and when is it acceptable. (When the business tolerates a few seconds of staleness between the SoR and projections, which is most read-heavy workloads.) How do you make downstream consumers idempotent. (Key events by a stable ID, track applied IDs in the consumer, or use upsert semantics on the sink.)

First-job traps to avoid. Forgetting to invalidate caches on write leads to stale reads that are hard to reproduce. Using `go func()` for cross-database writes leads to silent drops on crash. Letting the downstream sink's schema drift from the source leads to runtime deserialization errors that only fire in production. Not putting a dead-letter queue behind Kafka consumers means one poison message stops the pipeline. Build the DLQ on day one.

### Senior @ FAANG: CDC Fan-out, Event Sourcing as Glue, and Polyglot Sprawl

At staff level the question is not "which databases" but "what is the data-flow topology and where does truth live." The canonical pattern is **Postgres as system of record, Debezium as CDC extractor, Kafka as the durable log, and downstream sinks as systems of reference.** Debezium runs as a Kafka Connect source connector, uses logical replication slots on Postgres (pgoutput plugin since Postgres 10), and emits one Kafka topic per source table with before-image and after-image payloads and a schema registry reference. Downstream consumers are independent: a ClickHouse sink (clickhouse-kafka-connect or the native Kafka table engine with MaterializedView), an Elasticsearch sink (Elastic's own connector or a custom consumer with bulk API), a Neo4j sink (neo4j-streams or custom Cypher apply), and a Redis cache invalidator. Each consumer tracks its own offset, can replay from any point in the log, and can be rebuilt by resetting to offset zero. This is the pattern Netflix uses with DBLog, LinkedIn with Brooklin, Shopify with their own CDC tooling, and Uber with the schemaless-to-pinot pipeline.

Replication slot hygiene is where staff engineers earn their salary. A stalled or dropped Debezium consumer causes the WAL to accumulate on Postgres because the slot retains all WAL since the slot's last confirmed LSN. I have seen this fill a 2 TB disk in six hours during an outage. Mitigations: `max_slot_wal_keep_size` in Postgres 13+ caps the retention at a hard limit (slot is invalidated if exceeded, which trades consumer recoverability for primary stability, the right trade for an unattended weekend), monitor `pg_replication_slots.confirmed_flush_lsn` lag as a first-class alert, and run Debezium in high availability mode with offset storage in Kafka so connector restarts do not lose position. For high-throughput tables (>10k inserts/sec) evaluate **wal2json** vs **pgoutput** plugin choice, and consider sharding the publication so one slow consumer does not back-pressure all tables.

Event sourcing as polyglot glue. The escalation from CDC is to make the event log itself the system of record. Commands go through a command handler that appends events to an event store (Kafka with compaction, EventStore DB, or Postgres as an append-only log). Postgres, ClickHouse, Neo4j, Elasticsearch, Redis are all projections derived by replaying events. This buys you time-travel debugging (replay to any point), easy addition of new projections (new consumer, replay from zero), and a clean model of what happened versus what is. Costs: event schema evolution becomes a hard problem (upcasters, versioning, lensing), projection rebuild time on large event logs can be days, and the impedance mismatch between event-native thinking and CRUD-trained developers is real. Event sourcing is right for accounting, order management, audit-heavy domains, fraud rings. It is wrong for simple CRUD apps, analytics warehouses, and low-value data. Staff engineers know when to reach for it and when to stay with CDC.

**Dual-write anti-pattern, quantified.** Consider a 99.9%-available Postgres and a 99.9%-available Kafka. If your code does `pgTx.Commit()` then `kafka.Produce(event)` as two independent operations, the probability that both succeed is 0.999 * 0.999 = 0.998, and the probability of divergence (one succeeded, the other failed) is 2 * 0.999 * 0.001 = 0.002, or 0.2%. At 1000 events per second, that is 2 divergences per second, 172,800 per day. Now retry: if Kafka fails and you retry, you may double-publish (if the first actually succeeded but the ACK was lost). Idempotent Kafka producers help, but they require producer transactions with exactly-once semantics, which adds latency and complexity. The outbox pattern collapses this to a single transaction, and the polling worker handles retries safely because idempotency is at the sink, not the producer. If you take nothing else from this section, take this: **never call two storage systems in sequence from application code and pretend it is atomic.**

CDC fan-out topology at scale. For a 1000-microservice architecture you do not want each service owning its own Debezium connector and its own downstream pipelines. You build a **data platform team** that runs Debezium on a central Kafka Connect cluster, publishes raw CDC topics, and offers a self-service portal where teams subscribe to the topics they need and declare sinks. Schemas live in a central registry (Confluent Schema Registry, Apicurio, or AWS Glue Schema Registry), evolution is governed by compatibility rules (backward-compatible by default), and access control is enforced at topic level via ACLs. This is the pattern at Airbnb (the Jitney/SpinalTap lineage), LinkedIn (Brooklin), Uber (uReplicator then Kafka MirrorMaker 2), and Shopify. Once you have this, adding a new downstream database is a PR, not a project.

**Polyglot sprawl**, the failure mode. The most common staff-level mistake is adopting a new database for each new use case without retiring the old one, ending up with Postgres, MySQL, MongoDB, DynamoDB, Cassandra, Redis, Memcached, Elasticsearch, OpenSearch, ClickHouse, Druid, Pinot, Neo4j, Neptune, and TimescaleDB all in production. Each is on-call burden, each has a different backup and DR story, each has a different security model, each needs upgrades, each has a SPOF if misoperated. At Netflix the internal rule is roughly "one engine per access pattern, and you justify any exception." At Amazon the "use the right tool" culture has been tempered by platform teams that consolidate on a short list. Your job at staff is to resist adopting the shiny new engine for a workload the existing one handles adequately. The question is not "can X do this better" but "does X do this enough better to pay the operational tax for five years." Usually the answer is no.

Cross-cutting concerns that bite polyglot architectures. **Transactions across engines do not exist**, so you design every cross-engine write as eventually consistent with compensating actions. **Cross-database joins** are done in application code or in a query federation layer (Trino, Presto, DuckDB MotherDuck), never by moving data at query time. **Backup and restore** must be coordinated, with a common point-in-time-recovery story, or you end up with a Postgres snapshot from 2 pm and an Elasticsearch snapshot from 3 pm that disagree. **Schema evolution** is hardest in polyglot systems because a field rename in Postgres must propagate through Debezium, schema registry, five consumers, five sink schemas, and five dashboards. Build schema CI that validates compatibility before merge. **Observability** needs a correlation ID that flows through every hop (OpenTelemetry W3C traceparent propagated into Kafka headers, logged by every consumer, surfaced in traces across engines). Without that, debugging a stale read takes days.

When polyglot is the wrong answer. A 20-person startup with 10k daily active users does not need five databases. Postgres with proper indexes, extensions (pg_trgm for search, pgvector for embeddings, TimescaleDB for time-series, Apache AGE for graph), and materialized views handles 80% of the access patterns at that scale. The operational overhead of Postgres plus Redis is an order of magnitude less than Postgres plus Redis plus ClickHouse plus Elasticsearch plus Neo4j, and the performance gap at low scale is invisible. Staff engineers know to push back on "let us add ClickHouse" until the Postgres materialized view has actually become a bottleneck, measured in concrete p99 numbers, not speculation. Adopt the next engine when you have data showing the current stack fails, not before.

---
