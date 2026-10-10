## Further Reading

- **Gorilla WebSocket Documentation**: Reference for the `websocket.Upgrader`, ping/pong handlers, and connection lifecycle management used throughout this chapter: https://pkg.go.dev/github.com/gorilla/websocket
- **Prometheus Client Go**: API reference for `promauto`, histogram bucket configuration, and custom collector patterns: https://pkg.go.dev/github.com/prometheus/client_golang
- **Redis Pub/Sub Patterns**: Official Redis documentation on Pub/Sub semantics, including message ordering guarantees and subscriber behavior during disconnection: https://redis.io/docs/interact/pubsub/
- **"Designing Data-Intensive Applications" by Martin Kleppmann**: Chapters 3 (Storage) and 11 (Stream Processing) cover the time-series storage, partitioning, and stream processing patterns applied in the ingestion and caching layers.
- **"Site Reliability Engineering" by Google**: Chapters on monitoring, alerting, and load testing provide the operational culture framework that Pillar 4 draws from.
- **LTTB Downsampling Algorithm**: Sveinn Steinarsson's original paper describing the Largest Triangle Three Buckets algorithm used in the time-series downsampling interview question.
- **TimescaleDB Continuous Aggregation**: Documentation on materialized views with automatic refresh policies for pre-computed metric rollups: https://docs.timescale.com/use-timescale/latest/continuous-aggregates/

### Junior -> FAANG: How to Use This Reading List

Do not try to read everything here before moving to the next chapter. Use this list as a reference when a specific concept from the chapter comes up in practice.

The Gorilla WebSocket documentation is the first thing to read if you are implementing a WebSocket server for the first time. The ping/pong handler section and the connection lifecycle section answer the questions that come up most frequently in code review. Read these two sections completely before writing any production WebSocket code.

"Designing Data-Intensive Applications" is the most cited book in backend engineering interviews at FAANG. Chapters 3 and 11 are directly relevant to this chapter. If you can only read one technical book this year, this is the one. It is dense and rewards slow reading with annotation.

The SRE book is the operational culture reference for Pillar 4. The chapters on monitoring and alerting (Chapters 6 and 10 in the original edition) provide the vocabulary and framework for designing alerts that are actionable rather than noisy. Read these after you have your first on-call rotation, when the concepts will be immediately applicable.

For the LTTB algorithm: read the original paper (it is short, well-written, and includes visual examples) before implementing the downsampling code. The visual intuition from the paper makes the implementation much easier to verify as correct.

### Senior @ FAANG: Extending the Reading List for Staff-Level Concerns

The reading list here covers the technical foundations well. At L6/L7, additional reading fills in the governance, capacity planning, and organizational dimensions.

**"The Site Reliability Workbook" (O'Reilly):** The companion to the SRE book contains more concrete implementation guidance, including chapters on SLO implementation, error budget policy, and production readiness reviews. The PRR chapter is directly applicable to the Four Pillars framework and provides a template that staff engineers can adapt for their own teams.

**Brendan Gregg's "Systems Performance":** The performance analysis methodology in this book (USE method: Utilization, Saturation, Errors for every resource) is the systematic framework that makes the difference between an engineer who finds bottlenecks and an engineer who guesses. The chapter on memory analysis is particularly relevant for understanding Go GC behavior at scale.

**"Distributed Systems Observability" by Cindy Sridharan (O'Reilly, free online):** A concise treatment of the three pillars of observability (logs, metrics, traces) with a focus on how they complement each other. The discussion of high-cardinality data and the limits of metrics-only observability is directly relevant to the cardinality and exemplar topics covered in this chapter.

**Prometheus documentation on recording rules and alert design:** The official Prometheus documentation on recording rules (pre-computing expensive PromQL expressions) and alert design (multi-window burn-rate alerts for SLO compliance) is required reading for any engineer responsible for a monitoring platform. The multi-window burn-rate alert design in particular is the current best practice at FAANG for SLO alerting and replaces the simpler threshold-based alerts shown in this chapter.

**NATS documentation on JetStream:** If the platform requires durable message delivery (financial dashboards, audit logs, billing events), NATS JetStream is the most operationally simple option that provides at-least-once delivery with replay. The JetStream documentation's section on consumer ack policies and delivery guarantees is the reference for designing durable real-time pipelines in Go.
