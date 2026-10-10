## Section 6: Pipeline Monitoring

### 6.1 Metrics and Alerting

A pipeline without monitoring is a pipeline waiting to fail silently. The `PipelineMonitor` below exposes per-stage counters (records in, records out, errors) in Prometheus text format via an HTTP handler. Scraping this endpoint with Prometheus and building Grafana dashboards gives you real-time visibility into throughput, error rates, and bottlenecks. The `ErrorRateAlert` function defines a threshold-based alert that fires when a stage's error ratio exceeds a configured limit - useful for catching upstream schema changes or data quality regressions before they corrupt your warehouse.

In production, metrics alone are insufficient - you also want **OpenTelemetry traces** that follow a record from extraction through every stage to the sink. Propagate W3C trace context via `Record.Metadata["traceparent"]` (Kafka and most modern message systems can carry it in headers), start a span at the entry of each stage's `Process` loop, and attach `record.id`, `record.schema`, and `record.source` as span attributes. Exported to Jaeger, Tempo, or Honeycomb, these traces answer questions that counters cannot: *which stage added those 200ms of latency for this specific record?* Alert on **rate-of-change** of error counters and DLQ size rather than absolute thresholds - steady-state failure is normal, a 10x spike in five minutes is an incident.

```go
package etl

import (
	"fmt"
	"net/http"
	"sync"
	"time"
)

// PipelineMonitor exposes pipeline metrics as Prometheus text format.
type PipelineMonitor struct {
	pipelines sync.Map // name → *PipelineMetrics
	startTime time.Time
}

func NewPipelineMonitor() *PipelineMonitor {
	return &PipelineMonitor{startTime: time.Now()}
}

// Register tracks metrics for a pipeline.
func (m *PipelineMonitor) Register(name string, metrics *PipelineMetrics) {
	m.pipelines.Store(name, metrics)
}

// MetricsHandler serves Prometheus-format metrics.
func (m *PipelineMonitor) MetricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")

		fmt.Fprintf(w, "# HELP etl_pipeline_uptime_seconds Pipeline uptime\n")
		fmt.Fprintf(w, "etl_pipeline_uptime_seconds %v\n", time.Since(m.startTime).Seconds())

		m.pipelines.Range(func(k, v any) bool {
			name := k.(string)
			metrics := v.(*PipelineMetrics)

			metrics.processed.Range(func(sk, sv any) bool {
				stage := sk.(string)
				c := sv.(*stageCounter)

				fmt.Fprintf(w, `etl_stage_records_in_total{pipeline=%q,stage=%q} %d`+"\n",
					name, stage, c.in.Load())
				fmt.Fprintf(w, `etl_stage_records_out_total{pipeline=%q,stage=%q} %d`+"\n",
					name, stage, c.out.Load())
				fmt.Fprintf(w, `etl_stage_errors_total{pipeline=%q,stage=%q} %d`+"\n",
					name, stage, c.errors.Load())
				return true
			})
			return true
		})
	})
}

// PipelineAlert defines an alerting rule for pipeline health.
type PipelineAlert struct {
	Name      string
	Condition func(*PipelineMetrics) bool
	Message   func(*PipelineMetrics) string
	Fire      func(alert string)
}

// ErrorRateAlert fires if stage error rate exceeds threshold.
func ErrorRateAlert(stageName string, threshold float64, fire func(string)) PipelineAlert {
	return PipelineAlert{
		Name: "error_rate:" + stageName,
		Condition: func(m *PipelineMetrics) bool {
			if v, ok := m.processed.Load(stageName); ok {
				c := v.(*stageCounter)
				in := c.in.Load()
				if in == 0 {
					return false
				}
				return float64(c.errors.Load())/float64(in) > threshold
			}
			return false
		},
		Message: func(m *PipelineMetrics) string {
			if v, ok := m.processed.Load(stageName); ok {
				c := v.(*stageCounter)
				return fmt.Sprintf("stage %s error rate %.2f%% > %.2f%%",
					stageName, float64(c.errors.Load())/float64(c.in.Load())*100, threshold*100)
			}
			return ""
		},
		Fire: fire,
	}
}
```

### Junior → FAANG: What to measure when the pipeline is a black box

Monitoring an ETL pipeline is harder than monitoring a web service because the failure modes are quieter. A web service that breaks returns a 500 and your error-rate dashboard lights up in seconds. A pipeline that breaks often keeps running, producing wrong numbers, and nobody notices until the CEO asks why revenue is flat. The FAANG bar is that your monitoring catches data-quality regressions and freshness breaches before a human consumer does. That requires thinking in four layers of signals, not one.

Layer one is the infrastructure layer. CPU, memory, goroutine count, GC pause, network saturation. The code above does not cover this. You get it from the Go runtime through `expvar` or the `runtime/metrics` package, scraped by Prometheus. If a stage is pegged at 100 percent CPU or climbing memory linearly, you know before the pipeline falls over.

Layer two is the pipeline throughput layer. Records in, records out, errors per stage. The code above covers this well. The rookie mistake is watching only absolute counts. Watch the ratio `records_out / records_in` per stage. A healthy filter stage has a stable ratio (say 0.95) and a sudden drop to 0.70 means either upstream content changed or the filter logic broke. Watch stage latency as a histogram, not an average. p50 is a lie, p99 is the truth.

Layer three is the data-quality layer. Row counts per batch compared to the 7-day moving median, null rates on critical columns, cardinality of enum fields, min and max of numeric fields. A pipeline that loaded 10 million rows yesterday and 100 rows today is either broken or the business collapsed, and the dashboard should fire either way.

Layer four is the freshness layer. "How old is the newest record in my warehouse compared to now." This is the single most important SLO for an analytics pipeline, and the one juniors forget to define. A freshness SLO of "p95 newest record is less than 15 minutes old" is a measurable contract your consumers can rely on.

Worked example for your first job. Your pipeline has been running fine for 3 months. One Monday the dashboard team pages you because yesterday's numbers look low. You open Prometheus. Records in is normal. Records out is normal. Errors are zero. What do you check next. Freshness. The pipeline has been loading records from 6 hours ago instead of 5 minutes ago because a Kafka consumer lag alert never fired. The root cause is that your alert watched absolute lag (records behind) instead of time lag (seconds behind), and a partition rebalance slowed throughput without changing the record count. A senior engineer writes the alert in seconds, not records, from day one.

Interview entry-point. "How do you know your pipeline is healthy." The wrong answer is "I watch the error logs." The right answer is "I have four SLOs: freshness p95 under 15 minutes, row-count delta within 20 percent of 7-day median, null-rate on PK columns under 0.01 percent, and end-to-end latency p99 under 5 minutes. Each has a page-level alert and a ticket-level alert, and the dashboard is reviewed in weekly oncall handoff."

### Senior @ FAANG: Data observability, lineage, and the SLO framework for pipelines

At senior level, pipeline monitoring is a formal SLO problem and a data-observability platform problem, not a metrics-export exercise. The Prometheus handler above is table stakes. What follows is what actually goes in your design doc.

SLO definition for data pipelines. Adopt the four-signal framework that has become standard at Meta, Google, Netflix, and Uber by 2026. Freshness SLO ("the 95th percentile of `now - max(event_time)` in the target table is less than 15 minutes, measured over rolling 1-hour windows"). Completeness SLO ("daily row count is within 20 percent of the 7-day median for 28 of the last 30 days"). Correctness SLO ("primary-key uniqueness is 100 percent, and the top-5 dimension cardinalities are within 3 standard deviations of their 30-day distribution"). Latency SLO ("end-to-end record latency, measured from source commit timestamp to sink commit timestamp, is under 5 minutes at p99"). Each SLO has an error budget expressed as a percentage of time the SLO may be violated in a 30-day window, typically 0.1 percent (43 minutes) for tier-1 pipelines and 1 percent (7.2 hours) for tier-2. The error budget drives the page-versus-ticket decision. Burning more than 2 percent of a monthly budget in under an hour is a page. Burning 10 percent in a week is a ticket.

OpenTelemetry instrumentation for pipeline jobs. The OTEL semantic conventions for messaging (`messaging.system`, `messaging.destination.name`, `messaging.message.id`, `messaging.kafka.consumer.group`) give you a standard schema that Datadog, Honeycomb, Tempo, and Grafana all understand. Start a span at the extractor, propagate the trace context through Kafka headers (the `traceparent` and `tracestate` W3C headers are wire-compatible with every major broker in 2026), and create a child span for each stage. Attach `etl.stage.name`, `etl.batch.size`, `etl.record.id`, and `etl.schema.version` as span attributes. Sampling is the senior decision. Head-based sampling at 1 percent is fine for happy-path traces. Tail-based sampling (capture all traces that include an error span) is what actually debugs production, and requires the OTEL Collector with the `tail_sampling` processor. For high-volume pipelines, use exemplar sampling where one trace per second per error class is captured verbatim and the rest are downsampled.

Lineage through OpenLineage and Marquez. Every pipeline run emits three events: `START` (with inputs and run metadata), `COMPLETE` (with outputs and row counts), and `FAIL` (with error class and stack). The events are posted to an OpenLineage endpoint (Marquez, or DataHub 0.12+, or Atlan, or Astronomer). Column-level lineage is the 2026 standard, not just dataset-level. When a product manager asks "what happens if we rename `user_id` to `account_id` in the source table," your lineage graph returns in under 5 seconds a list of every downstream dataset, dashboard, and ML feature that references that column, plus the owning team. Without column-level lineage you are guessing, and a single bad schema change can take down 40 dashboards. The instrumentation point for a Go pipeline is a Marquez client that emits events from a `PipelineRun` wrapper, and the discipline point is a CI check that fails the build if a pipeline does not declare its inputs and outputs in a manifest.

Data observability platforms (2026 landscape). Monte Carlo, Lightup, Bigeye, Datafold, and Anomalo are the commercial leaders. Open-source alternatives are Soda Core plus Soda Cloud, Great Expectations plus OpenMetadata, and Elementary (which sits on top of DBT). These platforms do three things a metrics stack cannot. First, ML-based anomaly detection on row counts, null rates, and distribution shifts, which catches "subtle" regressions that threshold-based alerts miss. Second, lineage-aware incident routing, so a ClickHouse table going stale pages the upstream Flink job owner, not the dashboard team. Third, data SLO dashboards that business stakeholders can read without needing Grafana literacy. The build-versus-buy decision is usually "buy for tier-1 pipelines, build for the long tail," because the ML detection requires a training corpus that small teams cannot assemble.

Schema drift alerts as a first-class signal. The single most common silent-failure mode is an upstream producer adding or renaming a field. Your pipeline happily ignores the new field, the warehouse schema never updates, and a month later someone notices a column is always null. The fix is a schema-fingerprint check at ingest. Compute a hash of `(field_names, field_types, required_flags)` on every batch and compare against the registered contract. Any mismatch generates a `schema_drift` event with the diff, routes the batch to a quarantine sink, and opens a ticket against the producer team. Confluent Schema Registry and AWS Glue Schema Registry enforce this at the serialization layer for Avro and Protobuf. For JSON pipelines you build it with `jsonschema` plus your own drift detector.

Pipeline cost as a monitored signal. At FAANG scale, an unmonitored pipeline is a FinOps incident waiting to happen. Tag every Snowflake query, BigQuery job, S3 PUT, Kafka topic, and Flink task with `{pipeline, team, env, tier}` labels. Export daily cost to a `pipeline_cost_usd` metric in Prometheus or Datadog. Alert on 50 percent week-over-week growth, not absolute cost, because growth indicates a regression while absolute cost indicates business reality. Cost per million rows processed is the efficiency KPI, and staff engineers are expected to reduce it 20 percent year-over-year through compression, partition pruning, predicate pushdown, and materialized views.

Row-count assertions and reconciliation. The ultimate backstop is a reconciliation job that runs hourly and compares source row counts to destination row counts, grouped by a stable dimension (tenant, date, event type). A 1 percent discrepancy on a tier-1 pipeline is a ticket. A 5 percent discrepancy is a page. The reconciliation job must itself be monitored because a broken reconciliation job is worse than no reconciliation, it gives false confidence. The 2026 standard is to run reconciliation as a DBT test plus a Great Expectations suite, with results published to OpenMetadata and surfaced in the dashboard your exec team reads on Monday morning. This is the boundary between a pipeline that merely runs and a pipeline that can be trusted.

---

