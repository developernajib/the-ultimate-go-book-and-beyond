## 55.2 Project Architecture

### System Overview

A production real-time dashboard must handle bursty ingestion from many metric sources while simultaneously serving a large number of WebSocket subscribers, making architectural choices about buffering and fan-out critical from the start. The system overview here separates concerns across four pillars: ingestion, caching, delivery, and observability, each of which can be scaled independently. The diagram and struct definitions below capture this architecture before diving into the implementation of each pillar.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         REAL-TIME DASHBOARD                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────────────────┐  │
│  │   Metrics    │────►│   Ingestion  │────►│   Time-Series Database   │  │
│  │   Sources    │     │   Service    │     │   (TimescaleDB/InfluxDB) │  │
│  └──────────────┘     └──────────────┘     └──────────────────────────┘  │
│                              │                         │                 │
│                              ▼                         ▼                 │
│                       ┌──────────────┐         ┌──────────────┐          │
│                       │    Redis     │◄───────►│  Aggregation │          │
│                       │   Pub/Sub    │         │   Service    │          │
│                       └──────────────┘         └──────────────┘          │
│                              │                         │                 │
│                              ▼                         ▼                 │
│  ┌──────────────┐     ┌──────────────┐         ┌──────────────┐          │
│  │    React     │◄───►│  WebSocket   │◄────────│   Query API  │          │
│  │   Frontend   │     │   Server     │         │   Service    │          │
│  └──────────────┘     └──────────────┘         └──────────────┘          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Project Structure

A clean directory layout separates concerns before the codebase grows, with Go backend packages in `internal/`, frontend source under `frontend/`, and shared infrastructure configuration at the root. Following this structure from the start avoids the later pain of untangling business logic from HTTP handlers or build artifacts from source files. The tree below shows the canonical layout for this application and explains the role of each top-level directory.

```
realtime-dashboard/
├── backend/
│   ├── cmd/
│   │   ├── api/
│   │   │   └── main.go
│   │   ├── ingestion/
│   │   │   └── main.go
│   │   └── aggregator/
│   │       └── main.go
│   ├── internal/
│   │   ├── metrics/
│   │   │   ├── handler.go
│   │   │   ├── service.go
│   │   │   ├── repository.go
│   │   │   └── models.go
│   │   ├── ingestion/
│   │   │   ├── handler.go
│   │   │   ├── processor.go
│   │   │   └── validator.go
│   │   ├── aggregation/
│   │   │   ├── service.go
│   │   │   ├── workers.go
│   │   │   └── scheduler.go
│   │   ├── websocket/
│   │   │   ├── hub.go
│   │   │   ├── client.go
│   │   │   └── messages.go
│   │   ├── cache/
│   │   │   ├── redis.go
│   │   │   └── local.go
│   │   └── observability/
│   │       ├── metrics.go
│   │       ├── tracing.go
│   │       └── logging.go
│   ├── pkg/
│   │   ├── config/
│   │   ├── database/
│   │   └── middleware/
│   ├── migrations/
│   ├── go.mod
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Dashboard/
│   │   │   ├── Charts/
│   │   │   ├── Widgets/
│   │   │   └── Layout/
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useMetrics.ts
│   │   │   └── useRealtime.ts
│   │   ├── store/
│   │   │   ├── slices/
│   │   │   └── api/
│   │   ├── types/
│   │   └── utils/
│   ├── package.json
│   └── vite.config.ts
├── docker-compose.yml
├── docker-compose.prod.yml
└── Makefile
```

---

### Junior -> FAANG: Reading Architecture Diagrams as Communication Artifacts

The diagram and directory layout here are not just documentation. They are the primary communication artifact between the engineer who designed the system and every engineer who touches it afterward. Learning to read them critically is a first-job skill that most programs do not teach.

When you encounter an architecture diagram at a new job, ask three questions: where does user traffic enter, where is state stored, and where can each component fail independently? In this diagram, traffic enters the WebSocket server, state is in TimescaleDB and Redis, and the ingestion service can fail without taking down the WebSocket server. That independence is a design choice, not an accident.

For the directory layout: the separation of `cmd/` (entrypoints) from `internal/` (packages) from `pkg/` (shared utilities) follows the standard Go project layout that most Go shops use. If you see a project where `main.go` imports directly from business logic files in the same directory, that is a signal that the project has not yet invested in package separation. It is not always wrong, but it does make testing harder.

Interview tip: when given a system design prompt for a "real-time analytics dashboard," sketch the separation shown here before writing any code. An ingestion service separate from a query service separate from a WebSocket server gives you three independent scaling axes. That separation is worth naming explicitly in an interview, because it shows you understand why the components are split, not just that they are.

### Senior @ FAANG: Evaluating Architecture Decisions at Organizational Scale

The architecture diagram here represents one team's design for one dashboard. A staff engineer's concern is whether this architecture can be the foundation for a platform that ten teams use.

**Independent scaling axes:** The separation of ingestion, aggregation, and WebSocket delivery into separate `cmd/` entrypoints means each can be deployed and scaled independently. This is not just a nice-to-have. It is the design decision that prevents a spike in metric ingestion (e.g., a new agent rollout pushing 10x normal volume) from degrading WebSocket delivery latency for existing dashboard users. A staff engineer reviewing this architecture would ask: are these components deployed as separate Kubernetes deployments with separate HPA (Horizontal Pod Autoscaler) configurations, or are they colocated in a way that couples their resource consumption?

**Data flow and backpressure governance:** The flow from metrics sources through ingestion into TimescaleDB and then to the WebSocket server has three potential backpressure points: the ingestion service's channel buffer, the database write throughput, and the Redis Pub/Sub delivery rate. A staff engineer would produce a written capacity model for each: "ingestion service can absorb X events/second before dropping with a batch size of Y and Z flush workers, given a database that handles W writes/second." That model does not need to be precise. It needs to exist so that teams can reason about their headroom before launching a new metric source.

**Migration path for existing consumers:** If three product teams already have dashboards using a simpler architecture (polling REST endpoints every 30 seconds), the staff engineer's job is to define the migration path to this WebSocket-based platform: what client libraries are provided, what the auth story is for the WebSocket upgrade, and what the timeline and support window looks like for the old REST endpoints. Architecture decisions without migration plans are aspirations, not decisions.

**ADR: why TimescaleDB instead of InfluxDB or Prometheus remote write:** This is exactly the kind of decision that should be in a written ADR. TimescaleDB uses PostgreSQL's query planner, which makes ad-hoc joins with relational data (user permissions, dashboard configurations) straightforward. InfluxDB has its own query language (Flux/InfluxQL) and a separate operational footprint. Prometheus remote write is optimized for Prometheus-style queries but not arbitrary time-range aggregations. The right choice depends on team familiarity, existing PostgreSQL operational knowledge, and query patterns. The ADR should document which of these factors drove the decision, so that the team can revisit it when the context changes.
