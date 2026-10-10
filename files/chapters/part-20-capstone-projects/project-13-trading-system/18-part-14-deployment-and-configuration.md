## Part 14: Deployment and Configuration

Deploying a trading system to production requires careful attention to infrastructure, configuration management, and environment isolation. You need Docker containers for consistent builds, Kubernetes or similar orchestration for high availability, and externalized configuration so that the same binary can run in development, staging, and production environments without code changes. The configuration files below cover everything from Docker image building to Kubernetes deployment manifests and application-level YAML settings.

### Docker Configuration
Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git make

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o trader ./cmd/trader

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/trader .

# Copy configurations
COPY configs/ ./configs/

# Expose metrics port
EXPOSE 9090

CMD ["./trader"]
```

### Docker Compose

Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```yaml
# docker-compose.yml
services:
  # Trading application
  trader:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:password@db:5432/trading?sslmode=disable
      EXCHANGE_URL: ${EXCHANGE_URL}
      EXCHANGE_API_KEY: ${EXCHANGE_API_KEY}
      EXCHANGE_SECRET: ${EXCHANGE_SECRET}
      MAX_ORDER_SIZE: "10.0"
      MAX_POSITION_SIZE: "100.0"
      MAX_DAILY_LOSS: "10000.0"
      METRICS_PORT: "9090"
      GC_PERCENT: "200"
    ports:
      - "9090:9090"
    depends_on:
      - db
      - redis
    restart: unless-stopped

  # PostgreSQL + TimescaleDB
  db:
    image: timescale/timescaledb:2.29.2-pg18
    environment:
      POSTGRES_DB: trading
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"

  # Redis for caching and pub/sub
  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  # Prometheus for metrics
  prometheus:
    image: prom/prometheus:v3.14.0
    volumes:
      - ./configs/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
    ports:
      - "9091:9090"

  # Grafana for visualization
  grafana:
    image: grafana/grafana:13.2.1
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana_data:/var/lib/grafana
      - ./configs/grafana:/etc/grafana/provisioning
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

volumes:
  postgres_data:
  redis_data:
  prometheus_data:
  grafana_data:
```

### Kubernetes Deployment

Kubernetes manifests declare the desired state of the deployment including replica counts, resource limits, liveness probes, and rolling update strategy. Kubernetes continuously reconciles actual cluster state toward this desired state, providing self-healing and zero-downtime deployments.

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: trading-system
  labels:
    app: trading-system
spec:
  replicas: 2
  selector:
    matchLabels:
      app: trading-system
  template:
    metadata:
      labels:
        app: trading-system
    spec:
      containers:
      - name: trader
        image: trading-system:latest
        ports:
        - containerPort: 9090
          name: metrics
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: trading-secrets
              key: database-url
        - name: EXCHANGE_API_KEY
          valueFrom:
            secretKeyRef:
              name: trading-secrets
              key: exchange-api-key
        - name: EXCHANGE_SECRET
          valueFrom:
            secretKeyRef:
              name: trading-secrets
              key: exchange-secret
        resources:
          requests:
            memory: "2Gi"
            cpu: "2000m"
          limits:
            memory: "4Gi"
            cpu: "4000m"
        livenessProbe:
          httpGet:
            path: /metrics
            port: 9090
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /metrics
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: trading-system
spec:
  selector:
    app: trading-system
  ports:
  - port: 9090
    targetPort: 9090
    name: metrics
  type: ClusterIP
```

### Configuration File

The following configuration defines the deployment parameters for Configuration File, including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```yaml
# configs/config.yaml
system:
  name: "trading-system"
  environment: "production"
  log_level: "info"

database:
  url: "${DATABASE_URL}"
  max_connections: 100
  max_idle_connections: 10
  connection_lifetime: 3600

exchange:
  name: "primary"
  url: "${EXCHANGE_URL}"
  api_key: "${EXCHANGE_API_KEY}"
  secret: "${EXCHANGE_SECRET}"
  reconnect_interval: 5
  max_reconnect_attempts: 10

risk:
  enable_pre_trade_checks: true
  enable_post_trade_checks: true
  max_order_size: 10.0
  max_position_size: 100.0
  max_daily_loss: 10000.0
  max_account_leverage: 2.0
  kill_switch_enabled: true

market_data:
  symbols:
    - "BTC/USD"
    - "ETH/USD"
  buffer_size: 100000
  snapshot_interval: 60

strategies:
  - id: "mm-btc"
    type: "market_maker"
    enabled: true
    symbols:
      - "BTC/USD"
    config:
      spread: 10.0
      order_size: 0.1
      max_position: 10.0
      update_interval: 100ms

metrics:
  port: 9090
  enable_profiling: false

performance:
  gc_percent: 200
  max_goroutines: 10000
  enable_cpu_pinning: false
```
