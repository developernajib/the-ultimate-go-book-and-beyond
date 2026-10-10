## 54.7 Docker Deployment

### Docker Compose

Docker Compose encodes the entire development topology (database, backend, and frontend) as a single configuration file. The `depends_on` directive with `condition: service_healthy` ensures the backend waits for PostgreSQL to accept connections before starting, preventing the common startup race where the application crashes because the database is not ready yet.

```yaml
# docker-compose.yml
# NOTE: local development only -- not hardened for production.
# `version:` is intentionally omitted - the Compose Spec (2023+) treats
# the top-level `version` key as obsolete.

services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: taskmanager
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: taskmanager
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskmanager"]
      interval: 5s
      timeout: 5s
      retries: 5

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    environment:
      - SERVER_ADDR=:8080
      - DATABASE_URL=postgres://taskmanager:secret@postgres:5432/taskmanager?sslmode=disable
      - JWT_SECRET=your-production-secret
      - ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:80"
    depends_on:
      - backend

volumes:
  postgres_data:
```

### Backend Dockerfile

A multi-stage Dockerfile separates the Go build environment from the minimal runtime image, producing a final image that contains only the compiled binary and CA certificates. The build stage copies `go.mod` and `go.sum` first and runs `go mod download` as a separate layer, so dependency downloads are cached and only re-run when those files change.

```dockerfile
# backend/Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o server ./cmd/server

FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /root/
COPY --from=builder /app/server .

EXPOSE 8080

CMD ["./server"]
```

### Frontend Dockerfile

Building the React application inside Docker ensures the same Node version and `node_modules` tree in CI and production. The multi-stage build copies only the compiled `dist/` directory into an Nginx serving image, keeping the final image small and free of build tooling.

```dockerfile
# frontend/Dockerfile
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

### Nginx Configuration

Nginx proxies `/api` requests upstream to the Go server and serves all other paths from the SPA's `index.html`, implementing the catch-all routing that single-page applications require. The WebSocket location block sets `proxy_read_timeout` to 86400 seconds (24 hours) to prevent Nginx from closing long-lived connections prematurely. Static assets with content hashes get a one-year cache header since their URLs change on every build.

```nginx
# frontend/nginx.conf
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1000;

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API proxy
    location /api {
        proxy_pass http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket proxy
    location /api/v1/ws {
        proxy_pass http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Junior -> FAANG: Docker Multi-Stage Builds as Interview Signal

Multi-stage builds appear in almost every DevOps interview question about Docker. The key points to know: the builder stage has all the tools (Go compiler, Node, npm), and the final stage has none of them. The final image is smaller, has fewer attack vectors, and starts faster. If your Go binary is the only thing in the final image, an attacker who escapes the container has no shell, no package manager, and no compiler.

Know why `go mod download` is a separate layer from `COPY . .`. Docker caches layers. If `go.mod` and `go.sum` do not change, the `go mod download` layer is reused from cache. Without this, every source code change re-downloads all dependencies, adding minutes to the build. This is a common CI optimization question at FAANG.

Know that `CGO_ENABLED=0` is required for a static binary that runs in `alpine:3.19`. Without it, the Go binary links to glibc, which is not present in Alpine's musl-based environment. The binary will segfault at startup.

### Senior @ FAANG: Production Container Governance

The Compose file shown here uses a hardcoded password (`POSTGRES_PASSWORD: secret`) and a hardcoded JWT secret. In a team setting, these secrets end up in Git. The correct pattern for local development is a `.env` file that is `.gitignore`d, referenced by Compose's `env_file` directive. For production, secrets come from a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault) injected as environment variables at container runtime, never baked into the image.

**Image provenance and supply chain.** `FROM golang:1.27.1-alpine` pins the Go version but not the image digest. A supply chain attack on Docker Hub could replace the `golang:1.27.1-alpine` image with a malicious one between builds. The production pattern is to pin by digest: `FROM golang:1.27.1-alpine@sha256:<hash>`. FAANG's internal build systems enforce digest pinning and run trivy or Grype on every image before promotion.

**Health check design.** The Compose health check uses `pg_isready`, which verifies that PostgreSQL accepts TCP connections but does not verify that the database, user, and schema exist. A more thorough health check runs a lightweight query against the expected database: `psql -U taskmanager -d taskmanager -c 'SELECT 1'`. The Go backend's `/health` endpoint should similarly verify a database round trip, not just process liveness. Kubernetes's readiness probe should call `/health` so the pod is not added to the load balancer's endpoint list until the database connection is confirmed.

**Nginx configuration hardening.** The nginx config passes `$http_upgrade` directly into the `Connection` header without validation. The WebSocket `proxy_read_timeout 86400` is appropriate for long-lived connections but means a single stuck client holds a proxy connection for up to 24 hours. In production, implement a WebSocket heartbeat (the backend already does ping/pong) and set a shorter proxy timeout (3600 seconds), relying on the client's reconnect logic to re-establish after a clean close. Add `add_header X-Content-Type-Options nosniff` and `add_header X-Frame-Options SAMEORIGIN` to the nginx server block. These headers are not optional at FAANG.

**Zero-downtime deployment.** The current Compose setup stops the old container and starts the new one sequentially. On a real production cluster (Kubernetes, ECS), a rolling deployment updates one pod at a time with health check gating. The Go server's graceful shutdown (30-second timeout, draining in-flight requests) pairs with the Kubernetes `terminationGracePeriodSeconds` setting. If `terminationGracePeriodSeconds` is shorter than the server's in-flight request drain time, long-running requests are terminated ungracefully. Set both to the same value: 30 seconds for a typical API, longer for services that process large file uploads.

---
