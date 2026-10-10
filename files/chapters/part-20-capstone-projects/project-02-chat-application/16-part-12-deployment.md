## Part 12: Deployment

Deploying a real-time chat application involves more than just running a single binary. You need to orchestrate multiple services, the Go application, PostgreSQL, Redis, and object storage, and ensure they can communicate reliably. In this section, you will create a Docker Compose configuration for local development and a multi-stage Dockerfile that produces a minimal production image. The Docker Compose setup includes health checks so that dependent services wait for databases to be ready before starting, which prevents the common problem of applications crashing on startup because the database is not yet accepting connections.

### 12.1 Docker Compose (`docker-compose.yml`)
Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: gochat
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio:latest
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  app:
    build: .
    ports:
      - "8080:8080"
    environment:
      DB_HOST: postgres
      DB_PORT: 5432
      DB_USER: postgres
      DB_PASSWORD: postgres
      DB_NAME: gochat
      REDIS_ADDR: redis:6379
      S3_ENDPOINT: minio:9000
      S3_ACCESS_KEY_ID: minioadmin
      S3_SECRET_ACCESS_KEY: minioadmin
      JWT_SECRET: your-secret-key-change-this
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
  minio_data:
```

### 12.2 Dockerfile

Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main ./cmd/server

# Runtime stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/main .
COPY --from=builder /app/web ./web

EXPOSE 8080

CMD ["./main"]
```

### 12.3 Kubernetes Deployment (`k8s/deployment.yaml`)

Kubernetes manifests declare the desired state of the deployment including replica counts, resource limits, liveness probes, and rolling update strategy. Kubernetes continuously reconciles actual cluster state toward this desired state, providing self-healing and zero-downtime deployments.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gochat
  labels:
    app: gochat
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gochat
  template:
    metadata:
      labels:
        app: gochat
    spec:
      containers:
      - name: gochat
        image: gochat:latest
        ports:
        - containerPort: 8080
        env:
        - name: DB_HOST
          value: postgres-service
        - name: DB_PORT
          value: "5432"
        - name: REDIS_ADDR
          value: redis-service:6379
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: gochat-secrets
              key: jwt-secret
        resources:
          limits:
            cpu: "1"
            memory: "512Mi"
          requests:
            cpu: "500m"
            memory: "256Mi"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: gochat-service
spec:
  type: LoadBalancer
  selector:
    app: gochat
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
  sessionAffinity: ClientIP  # Important for WebSocket sticky sessions
```

### Junior → FAANG: Sticky Sessions and Their Trade-offs

The `sessionAffinity: ClientIP` setting in the Kubernetes Service manifest is a common interview question for real-time systems. Explain why it is needed: a WebSocket connection is a long-lived TCP connection to a specific server instance. If the load balancer routes a reconnecting client to a different instance, that instance has no knowledge of the client's previous session state. Sticky sessions ensure the client reconnects to the same instance.

The limitation of sticky sessions is that load becomes uneven when long-lived connections cluster on certain instances. Discuss the mitigation: use the Redis-based Hub model (which makes all instances equivalent) so that sticky sessions are an optimization for efficiency, not a correctness requirement.

Health checks in Docker Compose (using `healthcheck` directives) ensure that dependent services wait until their dependencies are actually ready, not just started. This prevents the common failure mode where the Go server starts and immediately fails to connect to the database because PostgreSQL is still initializing.

### Senior @ FAANG: WebSocket Deployment as a Platform Challenge

At senior level, WebSocket deployment has several platform-specific challenges that standard HTTP service deployment does not. Load balancer timeout settings must be extended or disabled for WebSocket connections: a standard HTTP idle timeout of 60 seconds will terminate active WebSocket connections. This requires coordination with the infrastructure team to configure per-service timeout overrides.

Rolling deploys are more complex for WebSocket servers than for stateless HTTP services. When a pod is replaced during a rolling deploy, all active WebSocket connections to that pod are terminated. Clients must reconnect, which causes a connection spike. The spike can overwhelm the remaining pods if the rolling deploy replaces too many pods simultaneously. PodDisruptionBudgets limiting the maximum number of simultaneously unavailable pods, combined with graceful shutdown that sends WebSocket close frames before terminating, minimize the user-visible impact.

Connection draining (the platform allows in-flight requests to complete before terminating a pod) is critical for WebSocket servers. The standard Kubernetes grace period of 30 seconds is often insufficient for a chat server with thousands of active connections. Longer grace periods (5-10 minutes) allow connections to be drained gracefully, but extend the time required for a deploy. The tradeoff between deploy speed and connection disruption should be documented and configured per service.

---
