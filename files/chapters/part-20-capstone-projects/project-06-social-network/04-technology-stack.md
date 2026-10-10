## Technology Stack

> **Why `github.com/google/uuid` and not the Go 1.27 stdlib `uuid` package?** This project stores `uuid.UUID` values in struct fields that are scanned from the database and passed as query arguments. That path requires the `sql.Scanner` and `driver.Valuer` interfaces, which the standard library type deliberately does not implement. The third-party package remains the right choice wherever UUIDs cross a `database/sql` boundary. Projects in this book whose UUIDs stay in memory or serialize as strings (the URL shortener, API gateway, and ML platform) use the stdlib package instead.


Building a social network at scale requires a carefully chosen set of technologies, each selected to solve a specific problem well. Go serves as the primary language because of its strong concurrency model and efficient memory usage, which are essential when handling thousands of simultaneous connections. The supporting infrastructure includes multiple databases, each optimized for a different access pattern: relational data in PostgreSQL, graph traversals in Neo4j, fast lookups in Redis, and full-text search in Elasticsearch.

### Core Technologies
The `go.mod` file lists the project's dependencies: PostgreSQL and Neo4j drivers, Redis client, Elasticsearch client, and supporting libraries for JWT authentication and WebSocket support.

```text
// go.mod
module github.com/yourname/socialnet

go 1.27

require (
    // Web Framework
    github.com/go-chi/chi/v5 v5.0.12
    github.com/go-chi/cors v1.2.1
    github.com/go-chi/jwtauth/v5 v5.3.0

    // Database
    github.com/jackc/pgx/v5 v5.5.4
    github.com/jmoiron/sqlx v1.3.5

    // Redis
    github.com/redis/go-redis/v9 v9.5.1

    // Neo4j
    github.com/neo4j/neo4j-go-driver/v5 v5.17.0

    // Elasticsearch
    github.com/elastic/go-elasticsearch/v8 v8.12.1

    // WebSocket
    github.com/gorilla/websocket v1.5.1

    // Message Queue
    github.com/nats-io/nats.go v1.33.1

    // Object Storage
    github.com/minio/minio-go/v7 v7.0.69

    // Image Processing
    github.com/disintegration/imaging v1.6.2

    // Validation
    github.com/go-playground/validator/v10 v10.19.0

    // Logging
    go.uber.org/zap v1.27.0

    // Metrics
    github.com/prometheus/client_golang v1.19.0

    // Tracing
    go.opentelemetry.io/otel v1.24.0

    // Testing
    github.com/stretchr/testify v1.9.0
    github.com/testcontainers/testcontainers-go v0.28.0

    // Utilities
    github.com/google/uuid v1.6.0
    github.com/oklog/ulid/v2 v2.1.0
    golang.org/x/crypto v0.21.0
    golang.org/x/sync v0.6.0
)
```

### Infrastructure - **Database**: PostgreSQL 16 (primary data store)
- **Cache**: Redis 7 (feed cache, session storage)
- **Graph DB**: Neo4j 5 (social graph)
- **Search**: Elasticsearch 8 (full-text search)
- **Message Queue**: NATS (event streaming)
- **Object Storage**: MinIO (S3-compatible)
- **Load Balancer**: nginx
- **Monitoring**: Prometheus + Grafana
- **Tracing**: Jaeger

### Junior → FAANG: Multi-Database Architecture as a Design Pattern

Using multiple specialized databases (PostgreSQL for relational data, Neo4j for graph traversals, Redis for caching and counters, Elasticsearch for full-text search) is the correct pattern for a system with diverse data access requirements. The key insight is that no single database technology excels at all access patterns.

For interviews, justify each database choice: "I use Neo4j for the social graph because follow relationships form a graph with millions of vertices and billions of edges. Graph queries like 'friends of friends' are O(n) in a relational database (join chain grows with hop count) but O(1) per hop in a native graph database because the adjacency is stored explicitly." That level of justification demonstrates genuine architecture thinking.

The polyglot persistence approach introduces operational complexity: each database has its own operational model, upgrade path, and failure mode. As a junior engineer, be aware of this tradeoff and be able to state it in an interview.

### Senior @ FAANG: Polyglot Persistence as an Operational Commitment

At senior level, each database in the stack is an operational commitment. Neo4j's operational model (cluster management, APOC procedures, query optimization) is completely different from PostgreSQL's. Running both in production means your team needs expertise in both or you rely on managed services (Neo4j Aura, Amazon Neptune) that abstract operational complexity at the cost of less control and higher cost.

The technology stack ADR must answer: which databases are managed services (operational burden on vendor) versus self-managed (operational burden on your team)? For a startup team, managed services for every stateful component is the right default: it concentrates operational expertise on the application rather than the infrastructure. For a FAANG team with dedicated database infrastructure teams, self-managed is often preferred for cost efficiency and control.

Neo4j as the social graph database is a debatable choice. At LinkedIn/Facebook scale, the social graph is stored in custom graph stores (LinkedIn's Voldemort, Facebook's TAO) rather than commercial graph databases, because commercial graph databases do not scale to billions of users. The ADR for social graph storage should document the scaling ceiling of Neo4j (typically tens of millions of nodes for complex traversals) and define the migration path when that ceiling is approached.

---
