## Chapter 8: Docker Deployment

Docker packages your application and all its dependencies into a single container image that runs identically on any machine. This eliminates the classic "works on my machine" problem and makes deployment reproducible. In this chapter, we create a multi-stage Dockerfile that produces a minimal container image, a Docker Compose file that orchestrates all the services (API, PostgreSQL, Redis, NGINX, Prometheus, and Grafana), and an NGINX configuration that acts as a reverse proxy and load balancer.

### 8.1 Dockerfile

This Dockerfile uses a multi-stage build to produce a small, secure production image. The first stage compiles the Go binary using the full Go SDK image, and the second stage copies only the compiled binary into a minimal Alpine Linux image. This approach results in a final image that is typically under 20 MB, compared to the 1+ GB Go SDK image. The `CGO_ENABLED=0` flag ensures the binary is statically linked with no C dependencies.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git ca-certificates

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o goshort ./cmd/api

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/goshort .

# Copy migrations
COPY --from=builder /app/migrations ./migrations

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["./goshort"]
```

### 8.2 Docker Compose

Docker Compose lets you define and run the entire application stack with a single command (`docker-compose up`). The configuration below defines six services: three API server replicas behind an NGINX load balancer, a PostgreSQL database, a Redis cache, and Prometheus with Grafana for monitoring. Each service declares its dependencies, health checks, and resource limits so that Docker can start them in the correct order and restart them if they crash.

```yaml
# docker-compose.yml
version: '3.8'

services:
  # API Service
  api:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://goshort:password@postgres:5432/goshort?sslmode=disable
      - REDIS_URL=redis://redis:6379
      - APP_ENV=production
      - LOG_LEVEL=info
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    networks:
      - goshort-network
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '0.5'
          memory: 512M

  # PostgreSQL Database
  postgres:
    image: postgres:18-alpine
    environment:
      - POSTGRES_USER=goshort
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=goshort
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    networks:
      - goshort-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U goshort"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Redis Cache
  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - goshort-network
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  # NGINX Load Balancer
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - api
    networks:
      - goshort-network
    restart: unless-stopped

  # Prometheus
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    networks:
      - goshort-network
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
    depends_on:
      - prometheus
    networks:
      - goshort-network

volumes:
  postgres-data:
  redis-data:
  prometheus-data:
  grafana-data:

networks:
  goshort-network:
    driver: bridge
```

### 8.3 NGINX Configuration

NGINX serves as the entry point for all traffic, distributing requests across your API server instances using the `least_conn` load balancing strategy, which sends each new request to the server with the fewest active connections. It also applies rate limiting at the network edge (100 requests per minute per IP) and sets proxy headers like `X-Real-IP` so that your Go application can see the client's actual IP address instead of the Docker network address.

```nginx
# nginx.conf
events {
    worker_connections 1024;
}

http {
    upstream api_servers {
        least_conn;
        server api:8080 max_fails=3 fail_timeout=30s;
    }

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=shortener:10m rate=100r/m;

    server {
        listen 80;
        server_name goshort.io;

        # Rate limit
        limit_req zone=shortener burst=20 nodelay;

        # Logging
        access_log /var/log/nginx/access.log;
        error_log /var/log/nginx/error.log;

        # Redirect endpoint (no /api prefix)
        location ~ ^/([a-zA-Z0-9_-]+)$ {
            proxy_pass http://api_servers/$1;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Caching redirects
            proxy_cache_valid 301 1h;
            proxy_cache_valid 404 1m;
        }

        # API endpoints
        location /api/ {
            proxy_pass http://api_servers;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Timeouts
            proxy_connect_timeout 5s;
            proxy_send_timeout 10s;
            proxy_read_timeout 10s;
        }

        # Health check
        location /health {
            proxy_pass http://api_servers/health;
            access_log off;
        }

        # Metrics (restrict access)
        location /metrics {
            proxy_pass http://api_servers/metrics;
            allow 10.0.0.0/8;
            deny all;
        }
    }
}
```

---

### Junior → FAANG: Docker as a Deployment Prerequisite

Every production Go service at FAANG ships as a container. Building a minimal Docker image from a multi-stage Dockerfile is a baseline expectation for any backend role. The static binary with `CGO_ENABLED=0` means your container runs without libc, which is both more secure and more portable.

Docker Compose is the local development standard. Being able to spin up the full stack (API, PostgreSQL, Redis, monitoring) with a single command demonstrates you take local reproducibility seriously. Interviewers who review your project will appreciate that it runs without manual setup.

Understand the difference between what Docker Compose is for (local development and simple deployments) and what Kubernetes is for (production orchestration at scale). Do not conflate them in interviews.

### Senior @ FAANG: Container Images as Operational Artifacts

At senior level, a Dockerfile is not just a packaging script. It is an operational artifact that determines your attack surface, your startup time, your image pull cost, and your reproducibility guarantees.

Base image selection has security implications. Alpine Linux is small but uses musl libc, which can cause subtle compatibility issues with some Go packages that assume glibc. Distroless images (Google's distroless/static) are even smaller and contain no shell, reducing attack surface significantly. The ADR for base image selection should document the security rationale and the update cadence for the base image (unpatched base images are a common CVE source).

Image layer ordering affects build cache efficiency. In the Dockerfile, copy dependency files and run `go mod download` before copying application code. This ensures the dependency download layer is cached and only invalidated when `go.mod` changes, not on every code change. At scale with many developers, build cache hit rate is a significant CI cost driver.

Multi-architecture builds (linux/amd64 and linux/arm64) are increasingly important as FAANG infrastructure moves to Graviton and Apple Silicon development machines. Using `docker buildx` for multi-arch builds and pushing multi-arch manifests is a platform engineering concern that affects every team's development workflow. A staff engineer standardizes this across the organization rather than leaving it to each team to figure out independently.

Image signing and provenance attestation (using Sigstore/Cosign) are supply chain security requirements at FAANG. Every image should be signed with a key tied to the CI system, and deployments should verify the signature before pulling. This prevents supply chain attacks where a compromised registry could serve a modified image. Building this into the CI template is a platform governance decision.

---
