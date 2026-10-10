## 97.14 Volume Management and Data Persistence

### Understanding Volume Types

By default, any data written inside a container is lost when the container is removed. Volumes solve this problem by providing persistent storage that exists independently of the container's lifecycle. Docker supports three types of volumes, each suited to different situations: named volumes for production data like databases, bind mounts for development workflows where you want host file changes to appear instantly inside the container, and tmpfs mounts for sensitive data that should never touch disk.

```
┌──────────────────────────────────────────────────────────────────┐
│                    DOCKER VOLUME TYPES                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  NAMED VOLUMES (Recommended for production):                     │
│  ├── docker volume create mydata                                 │
│  ├── Managed by Docker, portable                                 │
│  ├── Survives container removal                                  │
│  └── Example: database storage                                   │
│                                                                  │
│  BIND MOUNTS (Good for development):                             │
│  ├── Maps host directory to container                            │
│  ├── Direct access to host filesystem                            │
│  ├── Changes visible immediately                                 │
│  └── Example: source code hot reload                             │
│                                                                  │
│  TMPFS MOUNTS (For sensitive data):                              │
│  ├── Memory-only storage                                         │
│  ├── Never written to disk                                       │
│  ├── Deleted when container stops                                │
│  └── Example: secrets, temp files                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Development Setup with Hot Reload

Hot reload means your application automatically rebuilds and restarts whenever you save a file, giving you instant feedback during development. The tool `air` watches your Go source files for changes and triggers a rebuild inside the container. By bind-mounting your source code directory into the container, changes you make on your host machine are immediately visible inside the container. Named volumes for the Go module cache and build cache ensure that dependency downloads and compilation artifacts persist across container restarts.

```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      # Bind mount for hot reload
      - .:/app
      # Named volume for Go modules (persist downloads)
      - go-modules:/go/pkg/mod
      # Named volume for build cache
      - go-build-cache:/root/.cache/go-build
    ports:
      - "8080:8080"
      - "2345:2345"  # Delve debugger
    environment:
      - GO_ENV=development
      - DATABASE_URL=postgres://user:pass@postgres:5432/myapp
    command: ["air", "-c", ".air.toml"]  # Hot reload with air

volumes:
  go-modules:
  go-build-cache:
```

```toml
# .air.toml - Hot reload configuration
root = "."
tmp_dir = "tmp"

[build]
  cmd = "go build -o ./tmp/main ./cmd/server"
  bin = "./tmp/main"
  include_ext = ["go", "tpl", "tmpl", "html"]
  exclude_dir = ["tmp", "vendor", "testdata"]
  delay = 1000

[log]
  time = true

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"
```

```dockerfile
# Dockerfile.dev - Development with hot reload
FROM golang:1.27

# Install air for hot reload
RUN go install github.com/cosmtrek/air@latest

# Install delve for debugging
RUN go install github.com/go-delve/delve/cmd/dlv@latest

WORKDIR /app

# Only copy go.mod for dependency caching
COPY go.mod go.sum ./
RUN go mod download

# Source code mounted as volume at runtime
EXPOSE 8080 2345

CMD ["air", "-c", ".air.toml"]
```

### Volume Security Best Practices

In production, you should mount configuration files as read-only (`:ro`) so that a compromised container cannot modify them. Combining a read-only container filesystem with a tmpfs mount for `/tmp` gives your application a place to write temporary files while preventing any permanent modifications to the image. For database volumes, using `nocopy: true` prevents Docker from copying the container's default data into the volume, which avoids accidentally overwriting existing production data.

```yaml
# Production volume configuration
version: '3.8'

services:
  api:
    image: myapp:latest
    volumes:
      # Read-only config
      - ./config:/app/config:ro
      # Temporary directory
      - type: tmpfs
        target: /tmp
        tmpfs:
          size: 100M
          mode: 1777
    read_only: true  # Read-only container filesystem
    security_opt:
      - no-new-privileges:true

  postgres:
    image: postgres:18-alpine
    volumes:
      # Named volume with specific options
      - type: volume
        source: postgres_data
        target: /var/lib/postgresql/data
        volume:
          nocopy: true  # Don't copy container data
    environment:
      - PGDATA=/var/lib/postgresql/data/pgdata

volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: none
      device: /data/postgres  # Host path
      o: bind

### Junior → FAANG: Understanding When Containers Should and Should Not Store Data

The foundational rule for container data: stateless applications (HTTP services, background workers) should store no data in the container filesystem. Any data written to the container filesystem is lost when the container is removed. Databases, caches with persistence, and message brokers are stateful and require explicit volume configuration.

The three volume types serve different purposes. Named volumes are the right choice for production stateful workloads: Docker (or the container orchestrator) manages the storage location, the volume persists when the container is removed, and it can be backed by a network storage driver in cloud environments. Bind mounts are the right choice for local development: they give the host filesystem access inside the container, enabling hot reload and easy file inspection. tmpfs mounts are the right choice for sensitive temporary data (secrets that should not be written to disk) or for performance-sensitive scratch space.

First-job habit: never use bind mounts in production configurations. A bind mount in a `docker-compose.yml` that is used in production couples the container to a specific host path, which breaks in any environment where that path does not exist. Use named volumes with an appropriate driver for production.

### Senior @ FAANG: Storage Architecture for Containerized Stateful Workloads

At staff level, volume management is a data durability and availability problem. The question is not "how do I attach a volume" but "what is the failure mode when the underlying storage fails, and is that failure mode acceptable for this workload."

Named volumes backed by local disk fail when the host fails. For production stateful workloads, this is usually unacceptable. The solution is a network storage driver: EBS for single-node attachment on AWS, EFS or FSx for multi-node shared access, the Kubernetes CSI ecosystem for cloud-portable storage management. Each choice has different latency, throughput, cost, and consistency characteristics that need to be matched to the workload's requirements.

The senior architectural distinction is between workloads that should be stateful in the container platform at all (databases, some caches) versus workloads that should use a managed service (RDS, ElastiCache, Cloud Spanner). The general principle at FAANG scale is: if a managed service exists and fits the requirements, use it. The operational burden of running stateful workloads in containers (backup, recovery testing, upgrade procedures, storage capacity management) is significant and rarely justified when a managed equivalent is available. The staff engineer's job is to make this recommendation early in the design process, before a team has committed to running PostgreSQL in Kubernetes.
```

---
