## Part 8: Main Application and Configuration

### Main Entry Point

The main function is the entry point that wires everything together and starts the server. It uses Go's standard `flag` package to accept command-line arguments for the listen address and maximum memory limit. After starting the server, it waits for an interrupt signal (Ctrl+C or a termination signal from the operating system) and then performs a graceful shutdown. This pattern ensures that in-flight requests finish before the process exits.

```go
// cmd/gocache/main.go
package main

import (
    "flag"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"

    "gocache/internal/server"
)

func main() {
    addr := flag.String("addr", ":6379", "Server address")
    maxMemory := flag.Int64("maxmemory", 1024*1024*1024, "Max memory in bytes (default 1GB)")

    flag.Parse()

    srv := server.NewServer(*addr, *maxMemory)

    if err := srv.Start(); err != nil {
        log.Fatalf("Failed to start server: %v", err)
    }

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

    <-sigChan

    fmt.Println("\nShutting down server...")
    if err := srv.Stop(); err != nil {
        log.Fatalf("Error shutting down: %v", err)
    }

    fmt.Println("Server stopped")
}
```

### Docker Deployment

Docker makes it easy to package and distribute GoCache as a self-contained image. The Dockerfile below uses a multi-stage build: the first stage compiles the Go binary in a full Go environment, and the second stage copies just the binary into a minimal Alpine Linux image. This approach produces a very small final image (typically under 15 MB) that starts up quickly and has a minimal attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o gocache ./cmd/gocache

FROM alpine:3.19
RUN apk --no-cache add ca-certificates

WORKDIR /root/
COPY --from=builder /app/gocache .

EXPOSE 6379

CMD ["./gocache", "-addr", ":6379", "-maxmemory", "1073741824"]
```

### Docker Compose for Cluster

Docker Compose lets you spin up an entire GoCache cluster on your local machine with a single command. The configuration below creates three cache nodes, each with 1 GB of memory, along with Prometheus for metrics collection and Grafana for visualization dashboards. All services are placed on a shared bridge network so they can communicate with each other by container name.

```yaml
# docker-compose.yml
services:
  cache-node-1:
    build: .
    ports:
      - "6379:6379"
    environment:
      - MAX_MEMORY=1073741824
    networks:
      - cache-network

  cache-node-2:
    build: .
    ports:
      - "6380:6379"
    environment:
      - MAX_MEMORY=1073741824
    networks:
      - cache-network

  cache-node-3:
    build: .
    ports:
      - "6381:6379"
    environment:
      - MAX_MEMORY=1073741824
    networks:
      - cache-network

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    networks:
      - cache-network

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    networks:
      - cache-network

networks:
  cache-network:
    driver: bridge
```

---

### Junior → FAANG: Configuration as a Deployment Artifact

Command-line flags for configuration (`-addr`, `-maxmem`) work for development but are not suitable for production where configuration must be managed across dozens of instances. The progression from flags to environment variables to a configuration file to a configuration service represents increasing operational sophistication.

For your first production service, environment variables for all configurable parameters is the right default. Environment variables are supported by all container orchestration systems (Kubernetes, ECS, Cloud Run), can be injected from secrets managers for sensitive values, and are visible in the deployment manifest for auditability.

Graceful shutdown (waiting for in-flight requests before exiting on SIGTERM) is a deployment correctness requirement. A server that drops active connections during a rolling deploy causes user-visible errors. The `signal.NotifyContext` pattern in this chapter is the idiomatic Go way to implement graceful shutdown.

### Senior @ FAANG: Configuration Management as a Platform Concern

At senior level, configuration management for a distributed cache cluster involves more than startup flags. Dynamic configuration (changing cache size, eviction policy, or replication factor without restarting servers) requires a configuration service that all server instances poll. The server reacts to configuration changes by adjusting its runtime state: growing or shrinking the LRU capacity, promoting or demoting replicas.

Hot reload of configuration (applying changes without service restart) reduces operational disruption but introduces complexity: the configuration must be applied atomically, without leaving the server in a partially-configured state. For simple parameters (log level, connection timeout), hot reload is straightforward. For structural parameters (shard count, hash function), hot reload may require a more complex coordination mechanism.

Configuration schema validation (failing fast at startup if required configuration is missing or invalid) is a reliability practice. A server that starts with invalid configuration and fails only at runtime (when it tries to use the invalid value) is harder to diagnose than one that fails at startup with a clear error message. Go's `flag.Parse()` and validation functions at startup implement this pattern.

---
