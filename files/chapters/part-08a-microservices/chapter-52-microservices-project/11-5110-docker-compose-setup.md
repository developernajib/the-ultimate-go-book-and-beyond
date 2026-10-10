## 52.10 Docker Compose Setup

This Compose file brings up the full platform: four infrastructure services (PostgreSQL, Redis, Kafka in KRaft mode, Consul) and seven application services. Each application service declares its dependencies with `depends_on`, and the infrastructure services include health checks so Docker can verify readiness before starting dependents. All services share a single PostgreSQL instance here for simplicity. In production, each service would have its own database (or at minimum its own schema) to enforce data ownership boundaries.

> **This Compose file is for local development only.** It has hard-coded passwords, a single-node Kafka with replication factor 1, no TLS between services, no resource limits, and no persistent volumes for Kafka. Do not ship it to production. The production deployment target is Kubernetes: each service becomes a `Deployment` behind a `Service`, Kafka and Postgres are run by operators (Strimzi, CloudNativePG) or managed services (MSK, RDS), Consul is usually replaced by Kubernetes-native service discovery, and secrets come from Vault or the cloud provider's secret manager. Kafka itself has been Zookeeper-free since 3.5, the Compose below uses **KRaft mode**, which is what Kafka 4.x (current as of April 2026) requires.

```yaml
# deployments/docker-compose.yml
# NOTE: local development only -- not hardened for production.
# `version:` is intentionally omitted - the Compose Spec (2023+) treats
# the top-level `version` key as obsolete.

services:
  # Infrastructure
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: ecommerce
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: ecommerce
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ecommerce"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Kafka 4.x in KRaft (Zookeeper-free) mode -- single-node for local dev.
  kafka:
    image: confluentinc/cp-kafka:7.9.7
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_LISTENERS: PLAINTEXT://kafka:29092,CONTROLLER://kafka:29093,PLAINTEXT_HOST://0.0.0.0:9092
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      CLUSTER_ID: "MkU3OEVBNTcwNTJENDM2Qk"
    healthcheck:
      test: ["CMD-SHELL", "kafka-topics --bootstrap-server localhost:9092 --list || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10

  consul:
    image: hashicorp/consul:1.22
    ports:
      - "8500:8500"
    command: agent -server -bootstrap-expect=1 -ui -client=0.0.0.0

  # Services
  gateway:
    build:
      context: ..
      dockerfile: cmd/gateway/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - CONSUL_URL=consul:8500
      - REDIS_URL=redis:6379
      - JWT_SECRET=your-secret-key
    depends_on:
      - consul
      - redis

  user-service:
    build:
      context: ..
      dockerfile: cmd/user-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - KAFKA_BROKERS=kafka:29092
      - CONSUL_URL=consul:8500
      - JWT_SECRET=your-secret-key
    depends_on:
      - postgres
      - kafka
      - consul

  product-service:
    build:
      context: ..
      dockerfile: cmd/product-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - CONSUL_URL=consul:8500
    depends_on:
      - postgres
      - consul

  inventory-service:
    build:
      context: ..
      dockerfile: cmd/inventory-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - KAFKA_BROKERS=kafka:29092
      - CONSUL_URL=consul:8500
    depends_on:
      - postgres
      - kafka
      - consul

  cart-service:
    build:
      context: ..
      dockerfile: cmd/cart-service/Dockerfile
    environment:
      - REDIS_URL=redis:6379
      - CONSUL_URL=consul:8500
    depends_on:
      - redis
      - consul

  order-service:
    build:
      context: ..
      dockerfile: cmd/order-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - KAFKA_BROKERS=kafka:29092
      - CONSUL_URL=consul:8500
    depends_on:
      - postgres
      - kafka
      - consul

  payment-service:
    build:
      context: ..
      dockerfile: cmd/payment-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - KAFKA_BROKERS=kafka:29092
      - CONSUL_URL=consul:8500
    depends_on:
      - postgres
      - kafka
      - consul

  notification-service:
    build:
      context: ..
      dockerfile: cmd/notification-service/Dockerfile
    environment:
      - DATABASE_URL=postgres://ecommerce:secret@postgres:5432/ecommerce?sslmode=disable
      - KAFKA_BROKERS=kafka:29092
      - CONSUL_URL=consul:8500
    depends_on:
      - postgres
      - kafka
      - consul

volumes:
  postgres_data:
```

### Junior → FAANG: What to Learn from a Docker Compose File

Docker Compose is a learning environment, not a production deployment. Reading this file with the right questions turns it into a study guide for what a real production environment requires.

**Health checks are not optional, even locally.** Every infrastructure service has a `healthcheck` block. Without it, `depends_on` only waits for the container to start, not for the service to be ready. PostgreSQL might be starting up when the user service connects and gets a "connection refused." The health check waits until `pg_isready` reports success. This pattern applies in production too: Kubernetes readiness probes are the production equivalent.

**Hard-coded secrets are acceptable here and nowhere else.** The `POSTGRES_PASSWORD: secret` and `JWT_SECRET=your-secret-key` values are visible in plain text. This is acceptable because this Compose file is for local development only and is not committed with production values. In production, secrets come from Vault, AWS Secrets Manager, or Kubernetes Secrets (backed by Vault). Committing secrets to source control is a security incident, even if the repository is private.

**The single PostgreSQL instance is the development shortcut.** All services point to the same database. In production, each service would have its own database instance (or at minimum its own logical database) so that a schema migration in the inventory service does not require a maintenance window for the order service. The production migration is: one PostgreSQL instance per service, separate connection pools, no cross-service joins at the database level.

**First-job habit.** Before running `docker compose up`, read through the Compose file and identify: which services are stateful (have volumes), which have health checks, and which could be replaced by a managed cloud service. This reading habit builds infrastructure literacy faster than any tutorial.

### Senior @ FAANG: From Compose to Kubernetes, and the Governance of Local Development

The Docker Compose file is the local development contract. At FAANG, the local development environment is a platform concern with its own governance, and the gap between Compose and Kubernetes is where most production incidents originate.

**The local-to-production parity problem.** This Compose file uses a single-node Kafka with replication factor 1. Production Kafka runs with a replication factor of 3 across availability zones. A bug that only manifests with multi-broker Kafka (leader election during a partition, follower lag causing consumer rebalance) cannot be reproduced locally. Platform teams at FAANG invest in tooling that closes this gap: lightweight multi-broker Kafka in Compose, network partition simulation (Pumba, tc-netem), and chaos engineering scripts that run against staging.

**Resource limits and the OOM surprise.** This Compose file has no resource limits. A developer running the full platform on a laptop with 16 GB RAM may not notice that the Kafka image is consuming 4 GB alone. When the same image runs in Kubernetes with a 1 GB memory limit, it OOM-kills. Setting `mem_limit` and `cpus` in the Compose file, matching the Kubernetes resource requests, catches this before the first staging deployment.

**Compose as the onboarding contract.** At FAANG, the time-to-first-successful-build for a new team member is a tracked metric. A Compose file that starts the full platform with one command is the target. Achieving this requires: all secrets provided via a `.env.example` file, all schema migrations run automatically on first start, seed data for development included, and a health check that confirms all services are ready. The platform team owns this onboarding experience as a product.

**The Kubernetes migration path.** Each service in this Compose file maps to a Kubernetes Deployment. The Compose environment variables become ConfigMaps and Secrets. The `depends_on` health checks become readiness probes. The `ports` become Service resources (ClusterIP for internal, LoadBalancer or Ingress for external). Kafka and PostgreSQL become Strimzi and CloudNativePG operator deployments, or managed services (MSK, RDS, Cloud SQL). The Consul service discovery becomes Kubernetes-native DNS. A staff engineer presenting this platform to leadership includes the Kubernetes migration plan with timelines, because Compose is not a viable production deployment platform.

---
