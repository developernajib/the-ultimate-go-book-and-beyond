## 37D.13 Monitoring & Observability

### Command Monitoring with OpenTelemetry

Observability in a MongoDB-backed service depends on capturing driver-level command events and translating them into structured metrics and traces. The following implementation hooks into the MongoDB driver's `CommandMonitor` to emit OpenTelemetry spans and Prometheus histograms for every database operation.

```go
package mongodb

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/event"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// CommandMonitor tracks MongoDB operation metrics
type CommandMonitor struct {
	log          *slog.Logger
	tracer       trace.Tracer
	opsCounter   metric.Int64Counter
	latencyHist  metric.Float64Histogram
	errorCounter metric.Int64Counter
	mu           sync.Mutex
	inFlight     map[int64]commandStart
}

type commandStart struct {
	Name      string
	StartTime time.Time
}

func NewCommandMonitor(log *slog.Logger, meter metric.Meter) (*event.CommandMonitor, error) {
	opsCounter, _ := meter.Int64Counter("mongodb.operations.total",
		metric.WithDescription("Total MongoDB operations"))
	latencyHist, _ := meter.Float64Histogram("mongodb.operation.duration_ms",
		metric.WithDescription("MongoDB operation latency in milliseconds"))
	errorCounter, _ := meter.Int64Counter("mongodb.errors.total",
		metric.WithDescription("Total MongoDB errors"))

	m := &CommandMonitor{
		log:          log,
		opsCounter:   opsCounter,
		latencyHist:  latencyHist,
		errorCounter: errorCounter,
		inFlight:     make(map[int64]commandStart),
	}

	return &event.CommandMonitor{
		Started: func(ctx context.Context, evt *event.CommandStartedEvent) {
			m.mu.Lock()
			m.inFlight[evt.RequestID] = commandStart{
				Name:      evt.CommandName,
				StartTime: time.Now(),
			}
			m.mu.Unlock()
		},
		Succeeded: func(ctx context.Context, evt *event.CommandSucceededEvent) {
			m.mu.Lock()
			start, ok := m.inFlight[evt.RequestID]
			if ok {
				delete(m.inFlight, evt.RequestID)
			}
			m.mu.Unlock()
			if !ok {
				return
			}

			latency := time.Since(start.StartTime).Seconds() * 1000
			m.opsCounter.Add(ctx, 1,
				metric.WithAttributes(
					attribute.String("command", start.Name),
					attribute.String("status", "success"),
				))
			m.latencyHist.Record(ctx, latency,
				metric.WithAttributes(attribute.String("command", start.Name)))

			// Log slow queries
			if latency > 100 {
				log.Warn("slow mongodb query",
					"command", start.Name,
					"latency_ms", latency,
				)
			}
		},
		Failed: func(ctx context.Context, evt *event.CommandFailedEvent) {
			m.mu.Lock()
			start, ok := m.inFlight[evt.RequestID]
			if ok {
				delete(m.inFlight, evt.RequestID)
			}
			m.mu.Unlock()
			if !ok {
				return
			}

			m.errorCounter.Add(ctx, 1,
				metric.WithAttributes(attribute.String("command", start.Name)))
			log.Error("mongodb command failed",
				"command", start.Name,
				"failure", evt.Failure,
			)
		},
	}, nil
}
```

### Junior to FAANG: Observability Prerequisites and Entry Points

Before you can debug a MongoDB latency spike, you need to know which tool answers which question. Juniors often reach for `mongostat` when the right call is `db.currentOp()`, or stare at Atlas charts when the slow-query log already named the culprit. Memorize this decision tree.

- `mongostat -h host --rowcount 30` prints per-second throughput (inserts, queries, updates, deletes, getmore, command, flushes, dirty, used, queued reads and writes, net in and out, connections, replica state). Use it when you suspect a host is saturated and you do not yet know which operation dominates.
- `mongotop 5` breaks read and write time by namespace. Use it when `mongostat` shows load but you need to know *which collection* is hot.
- `db.currentOp({"secs_running": {$gte: 5}})` lists operations running longer than five seconds. Use it when a specific query is stuck and you need the `opid` to call `db.killOp(opid)`.
- `db.collection.find(q).explain("executionStats")` returns `totalKeysExamined`, `totalDocsExamined`, `nReturned`, and `executionTimeMillis`. The FAANG ratio junior engineers memorize is `totalDocsExamined / nReturned`. If this is greater than ten you have a missing or suboptimal index.
- The slow-query log (operations exceeding `slowms`, default 100 ms) is the single most useful artifact for a first-job incident write-up. Atlas surfaces it under Profiler. Self-hosted clusters read it from `system.profile` when `db.setProfilingLevel(1, { slowms: 50 })` is on.

Worked example. You join a team. p99 on `/feed` jumps from 40 ms to 900 ms. The reflex is: (1) Atlas Performance Advisor tab, look for "Create Index" recommendations on the feed collection. (2) If none, open the Profiler, filter by namespace, sort by duration descending. (3) Pick the top query, paste it into Compass, run `.explain("executionStats")`. (4) If `totalDocsExamined` equals the collection size, you have a COLLSCAN. (5) Create the index in a rolling fashion with `{ background: true }` equivalent (MongoDB 4.2 plus builds indexes online by default, but on a sharded 8.0 cluster you still stagger the build per shard to avoid primary stalls).

"Why did this fail?" reflex for juniors. Every slow query log line has `planSummary`. Values to recognize immediately: `COLLSCAN` (no index used, almost always a bug in production), `IXSCAN { field: 1 }` (index used, good), `FETCH` wrapping an `IXSCAN` (index covers the filter but not the projection, so the server still loads the full document), `SORT` not wrapped by `IXSCAN` (in-memory sort, fails with error 292 once it exceeds 100 MB unless you pass `allowDiskUse`). Knowing these four phrases puts you ahead of most first-year engineers.

Interview entry point. Typical L3 to L4 screen: "A query is slow. Walk me through diagnosis." The expected answer names `explain`, the `examined to returned` ratio, the existence of the profiler, and the difference between `queryPlanner`, `executionStats`, and `allPlansExecution` verbosity. Mentioning `serverStatus().metrics.queryExecutor.scannedObjects` counter as a cluster-wide smoke signal earns bonus points.

### Senior at FAANG: Observability Maturity, Governance, and ADRs

Staff and principal engineers own the observability contract for MongoDB, not the dashboards. The contract is what downstream teams, SREs, and finance rely on when the platform scales past a single replica set. Build it along four axes.

1. Signal taxonomy. Every MongoDB deployment must emit four signal classes with fixed cardinality budgets. RED (rate, errors, duration) from the driver `CommandMonitor`. USE (utilization, saturation, errors) from `serverStatus` exposed by `mongodb_exporter`. Business KPIs (documents written per tenant, oplog lag per shard) from custom exporters. Audit (who ran what, from where) from the native auditing subsystem piped to a SIEM. A common anti-pattern is emitting a Prometheus label per `request_id`, which explodes cardinality. Enforce label budgets at the exporter layer, not at Prometheus scrape time.

2. Maturity model. Publish this ladder as an ADR and hold teams to it during production readiness review.
   - L1 single replica set, Atlas free or M10, basic alerts on primary election and disk 80 percent. Appropriate for a pre-product startup.
   - L2 three-node replica set with dedicated analytics secondary, slow-query alerts at p99 greater than 200 ms, Ops Manager or Atlas backup with point-in-time recovery verified quarterly.
   - L3 sharded cluster with explicit shard key ADR, `mongodb_exporter` scraped by Prometheus, Datadog MongoDB integration on the same cluster for cross-checking, synthetic canaries for each collection hot path, index review CI gate that fails a PR introducing a query without a matching index.
   - L4 multi-region with zone sharding for data residency, change-streams replicated to Kafka via Debezium for downstream consumers, schema registry enforced by a pre-commit lint, quarterly game-days that kill a primary and measure election time against SLO.
   - L5 self-service Atlas governance. Every team spins up clusters through a platform API that enforces encryption at rest with customer-managed keys, private endpoints, auditing on, TLS 1.3 only, and a tag-based chargeback model. Capacity planning is automated from historical `serverStatus` trend data. Schema lint and shard-key lint run in CI for every repo that imports the Mongo driver.

3. ADR template for MongoDB observability. At staff level, the document matters more than the dashboard. A canonical ADR covers: context (service SLO, regulatory scope), decision (Atlas vs self-hosted, exporter, tracing backend), alternatives considered (Percona PMM, native Cloud Manager, Datadog DBM), consequences (cost model, on-call impact, cardinality), rollout (per-environment gating), and a revisit date. Without this, every new service re-litigates the exporter choice and the on-call rotation drowns in inconsistent alerts.

4. Governance and cost. `mongodb_exporter` default config scrapes hundreds of metrics per mongod. At fleet scale this is tens of millions of active series. Enforce a metric allowlist, drop histogram buckets you do not alert on, and push `collStats` and `indexStats` to a cold lake instead of Prometheus. Datadog DBM at roughly seventy USD per host per month is often cheaper than a self-hosted equivalent once you include SRE time, but only if you set up the usage allocation tags correctly. Principal engineers own the chargeback spreadsheet.

The trace boundary matters. Inject OTEL context into MongoDB operations using the comment field: `opts.SetComment(traceparent)`. MongoDB 8.0 surfaces the comment in the profiler and slow log, so a span in Tempo or Datadog APM joins with a slow-query line in Atlas Profiler on the same id. This is the closest MongoDB gets to true distributed tracing of a query and is the signal that separates an L5 platform from an L3 one.

---
