## Part 9: Docker Compose Setup

Running six microservices along with PostgreSQL, Redis, NATS, and Elasticsearch on your local machine would be extremely tedious to set up manually. Docker Compose solves this by defining all services and their dependencies in a single YAML file, so you can start the entire platform with one command. The configuration below sets up networking between containers, maps ports for local debugging, and uses health checks to ensure services start in the correct order.

### 9.1 Development Docker Compose

**docker-compose.yml**

```yaml
version: '3.8'

services:
  # Databases
  postgres-product:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: product_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres-product-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgres-order:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: order_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5433:5432"
    volumes:
      - postgres-order-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgres-payment:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: payment_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5434:5432"
    volumes:
      - postgres-payment-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgres-cart:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: cart_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5435:5432"
    volumes:
      - postgres-cart-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis
  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # NATS JetStream
  nats:
    image: nats:latest
    command: "-js -m 8222"
    ports:
      - "4222:4222"
      - "8222:8222"
    healthcheck:
      test: ["CMD", "wget", "--spider", "http://localhost:8222/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Elasticsearch
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
      - "9300:9300"
    volumes:
      - elasticsearch-data:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:9200/_cluster/health || exit 1"]
      interval: 30s
      timeout: 10s
      retries: 5

  # Jaeger (tracing)
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "5775:5775/udp"
      - "6831:6831/udp"
      - "6832:6832/udp"
      - "5778:5778"
      - "16686:16686"
      - "14268:14268"
      - "14250:14250"
      - "9411:9411"
    environment:
      - COLLECTOR_ZIPKIN_HOST_PORT=:9411

  # Prometheus
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'

  # Grafana
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./monitoring/grafana/datasources:/etc/grafana/provisioning/datasources

  # Services
  product-service:
    build:
      context: ./services/product
      dockerfile: Dockerfile
    ports:
      - "50051:50051"
    environment:
      - DB_HOST=postgres-product
      - DB_PORT=5432
      - DB_NAME=product_db
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - GRPC_PORT=50051
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
      - NATS_URL=nats://nats:4222
    depends_on:
      postgres-product:
        condition: service_healthy
      nats:
        condition: service_healthy

  order-service:
    build:
      context: ./services/order
      dockerfile: Dockerfile
    ports:
      - "50052:50052"
    environment:
      - DB_HOST=postgres-order
      - DB_PORT=5432
      - DB_NAME=order_db
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - GRPC_PORT=50052
      - PRODUCT_SERVICE_URL=product-service:50051
      - PAYMENT_SERVICE_URL=payment-service:50053
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
      - NATS_URL=nats://nats:4222
    depends_on:
      postgres-order:
        condition: service_healthy
      nats:
        condition: service_healthy
      product-service:
        condition: service_started

  payment-service:
    build:
      context: ./services/payment
      dockerfile: Dockerfile
    ports:
      - "50053:50053"
    environment:
      - DB_HOST=postgres-payment
      - DB_PORT=5432
      - DB_NAME=payment_db
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - GRPC_PORT=50053
      - STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
      - STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
      - NATS_URL=nats://nats:4222
    depends_on:
      postgres-payment:
        condition: service_healthy
      nats:
        condition: service_healthy

  cart-service:
    build:
      context: ./services/cart
      dockerfile: Dockerfile
    ports:
      - "50054:50054"
    environment:
      - DB_HOST=postgres-cart
      - DB_PORT=5432
      - DB_NAME=cart_db
      - DB_USER=postgres
      - DB_PASSWORD=postgres
      - REDIS_URL=redis:6379
      - GRPC_PORT=50054
      - PRODUCT_SERVICE_URL=product-service:50051
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
    depends_on:
      postgres-cart:
        condition: service_healthy
      redis:
        condition: service_healthy
      product-service:
        condition: service_started

  search-service:
    build:
      context: ./services/search
      dockerfile: Dockerfile
    ports:
      - "50055:50055"
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200
      - GRPC_PORT=50055
      - NATS_URL=nats://nats:4222
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
    depends_on:
      elasticsearch:
        condition: service_healthy
      nats:
        condition: service_healthy

  notification-service:
    build:
      context: ./services/notification
      dockerfile: Dockerfile
    ports:
      - "50056:50056"
    environment:
      - GRPC_PORT=50056
      - NATS_URL=nats://nats:4222
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASSWORD=${SMTP_PASSWORD}
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
    depends_on:
      nats:
        condition: service_healthy

  api-gateway:
    build:
      context: ./api-gateway
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - HTTP_PORT=8080
      - PRODUCT_SERVICE_URL=product-service:50051
      - ORDER_SERVICE_URL=order-service:50052
      - PAYMENT_SERVICE_URL=payment-service:50053
      - CART_SERVICE_URL=cart-service:50054
      - SEARCH_SERVICE_URL=search-service:50055
      - JAEGER_ENDPOINT=http://jaeger:14268/api/traces
    depends_on:
      - product-service
      - order-service
      - payment-service
      - cart-service
      - search-service

volumes:
  postgres-product-data:
  postgres-order-data:
  postgres-payment-data:
  postgres-cart-data:
  redis-data:
  elasticsearch-data:
  prometheus-data:
  grafana-data:
```

### 9.2 Environment Variables

**.env.example**

```env
# Stripe
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# SMTP (for notifications)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password

# Environment
ENVIRONMENT=development
```

---

### Junior → FAANG: Local Environment Parity as a Development Discipline

Running the full stack locally (all six microservices plus their dependencies) via a single `docker-compose up` command is a discipline that separates professional development from hobby development. When your local environment mirrors production, bugs are reproducible locally and integration issues surface before they reach staging.

Health checks in Docker Compose (`depends_on` with condition `service_healthy`) are the mechanism that ensures services start in the correct dependency order. Without health checks, a service may start and immediately crash because its database dependency is not yet ready to accept connections. This is a common source of intermittent failures in development environments.

Environment variable management in Docker Compose (using a `.env` file for development values) keeps secrets out of the Compose file itself. The `.env` file should be in `.gitignore`. This discipline carries directly to production where secrets come from a vault, not from environment files.

### Senior @ FAANG: Local Environment as an Organizational Productivity Multiplier

At senior level, the local development environment is an organizational asset. A slow or broken local environment wastes engineer time across the entire team. Maintaining Docker Compose configurations that accurately reflect the production service topology, keeping them up to date as services are added, and providing a documented setup process that works on both Mac and Linux development machines is a platform engineering responsibility.

The gap between Docker Compose and production Kubernetes is a common source of environment-specific bugs. A service that works in Docker Compose may fail in Kubernetes because of different DNS resolution (service names versus Kubernetes service names), different resource limits (Docker Compose applies no limits by default, Kubernetes applies pod limits), or different network policies (Docker Compose allows all inter-container traffic, Kubernetes network policies may restrict it). Using a local Kubernetes cluster (kind, k3d) for pre-production testing reduces this gap.

Development data seeding (populating the local database with realistic product data, user accounts, and test orders) is the final piece of a productive local environment. A seed script that runs idempotently and produces a consistent known state makes onboarding new engineers faster and local debugging easier. Building and maintaining this seed data is lower-glamour but high-impact platform work.

---
