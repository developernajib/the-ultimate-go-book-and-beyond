## 97.13 Container Networking Deep Dive

### Understanding Docker Networking for Go Services

Docker provides several networking modes that control how containers communicate with each other and the outside world. The most common is "bridge" mode, where each container gets its own IP address on a private network and can reach other containers by name. Understanding these modes is essential because a misconfigured network is one of the most common reasons a Go service works on your laptop but fails inside a container.

```
┌──────────────────────────────────────────────────────────────────┐
│                    DOCKER NETWORKING MODES                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BRIDGE (Default):                                               │
│  ├── Containers get private IP addresses                         │
│  ├── NAT for external access via published ports                 │
│  ├── DNS resolution by container name                            │
│  └── Best for: Multi-container apps on single host               │
│                                                                  │
│  HOST:                                                           │
│  ├── Container shares host network namespace                     │
│  ├── No port mapping needed (direct binding)                     │
│  ├── Better performance (no NAT overhead)                        │
│  └── Best for: High-performance network apps                     │
│                                                                  │
│  NONE:                                                           │
│  ├── No networking (complete isolation)                          │
│  └── Best for: Security-sensitive workloads                      │
│                                                                  │
│  OVERLAY:                                                        │
│  ├── Multi-host networking (Swarm/K8s)                           │
│  ├── Encryption available (--opt encrypted), NOT on by default   │
│  └── Best for: Distributed applications                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Go Application Networking Best Practices

The most critical networking rule for Go applications running in containers is to bind to `0.0.0.0` (all network interfaces), not `localhost` or `127.0.0.1`. Inside a container, `localhost` refers only to the container's own loopback interface, which is invisible from outside the container. If your server binds to `localhost:8080`, Docker's port mapping cannot reach it, and your application appears unreachable even though it is running correctly.

```go
package main

import (
    "context"
    "log"
    "net"
    "net/http"
    "os"
    "time"
)

func main() {
    // Get port from environment (container-friendly)
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    // Listen on all interfaces (0.0.0.0) for container networking
    // NOT 127.0.0.1 or localhost
    addr := net.JoinHostPort("0.0.0.0", port)

    server := &http.Server{
        Addr:         addr,
        Handler:      newRouter(),
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
        // Important for containers: graceful shutdown
        BaseContext: func(l net.Listener) context.Context {
            return context.Background()
        },
    }

    log.Printf("Server starting on %s", addr)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("Server error: %v", err)
    }
}

func newRouter() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    return mux
}

// Common mistake: binding to localhost inside container
// This will NOT work:
// addr := "localhost:8080"  // Only accessible from inside container
// addr := "127.0.0.1:8080"  // Same problem
```

### Service Discovery with Docker Compose

Docker Compose automatically creates a DNS-based service discovery system where each service can reach others by their service name. For example, if your Compose file defines a service called `postgres`, your Go application can connect to it using `postgres` as the hostname. You can also define multiple networks to isolate traffic: in the example below, the API can talk to both the database (backend network) and the reverse proxy (frontend network), but the database and reverse proxy cannot talk to each other directly.

```yaml
# docker-compose.yml with proper networking
version: '3.8'

networks:
  backend:
    driver: bridge
  frontend:
    driver: bridge

services:
  api:
    build: ./api
    networks:
      - backend
      - frontend
    ports:
      - "8080:8080"
    environment:
      # Use service names for internal DNS
      - DB_HOST=postgres
      - REDIS_HOST=redis
      - CACHE_HOST=redis:6379
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started

  postgres:
    image: postgres:18-alpine
    networks:
      - backend
    # No ports exposed externally (internal only)
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myuser -d myapp"]
      interval: 10s
      timeout: 5s
      retries: 5
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:8-alpine
    networks:
      - backend
    command: redis-server --appendonly yes

  nginx:
    image: nginx:alpine
    networks:
      - frontend
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - api

volumes:
  postgres_data:
```

```go
// Go code connecting to services by Docker DNS name
package database

import (
    "database/sql"
    "fmt"
    "os"
    "time"

    _ "github.com/lib/pq"
)

func Connect() (*sql.DB, error) {
    // In Docker, use service name as hostname
    host := os.Getenv("DB_HOST") // "postgres" from compose
    if host == "" {
        host = "localhost" // Fallback for local dev
    }

    dsn := fmt.Sprintf(
        "host=%s port=5432 user=%s password=%s dbname=%s sslmode=disable",
        host,
        os.Getenv("DB_USER"),
        os.Getenv("DB_PASSWORD"),
        os.Getenv("DB_NAME"),
    )

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, err
    }

    // Connection pool settings for containers
    db.SetMaxOpenConns(25)
    db.SetMaxIdleConns(5)
    db.SetConnMaxLifetime(5 * time.Minute)
    db.SetConnMaxIdleTime(1 * time.Minute)

    // Retry connection (services may not be ready immediately)
    for i := 0; i < 30; i++ {
        if err := db.Ping(); err == nil {
            return db, nil
        }
        time.Sleep(time.Second)
    }

    return nil, fmt.Errorf("failed to connect to database after 30 attempts")
}
```

---

### Junior → FAANG: Container Networking Concepts That Block Debugging

The two concepts that trip up new engineers most often are: (1) containers on the same Docker network can talk to each other by service name (DNS resolution within the bridge network), and (2) `localhost` inside a container refers to the container itself, not the host. The second point causes immediate confusion when engineers try to connect from a Go service container to a database running on the host: `localhost:5432` fails, `host.docker.internal:5432` (on Docker Desktop) or the host's bridge IP works.

Bridge versus host networking is worth understanding concretely. Bridge is the default: each container gets its own IP, and traffic between containers goes through the virtual bridge. Host networking removes the network namespace: the container shares the host's network stack directly. Host networking eliminates the NAT overhead and is sometimes used for performance-sensitive workloads, but it removes isolation and is not available on Docker Desktop for Mac or Windows.

First-job habit: always define explicit networks in `docker-compose.yml` and attach services to them. Relying on the default network makes it harder to control which services can communicate and produces confusing behavior when services from different Compose files need to interact.

### Senior @ FAANG: Container Networking Architecture and Service Mesh

At staff level, container networking is a reliability and security engineering problem. The key architectural questions are: which services should be able to talk to each other, how is that enforced, and how do you observe the traffic?

Network policies (in Kubernetes, implemented by the CNI plugin) are the enforcement mechanism for east-west traffic control. The default-deny pattern (deny all ingress and egress, then explicitly allow required paths) is the correct baseline for any service handling sensitive data. Implementing this requires understanding the service dependency graph, which is itself valuable infrastructure knowledge.

Service mesh (Istio, Linkerd, Cilium with Envoy) adds mutual TLS, traffic management, and observability at the network layer without requiring application changes. The tradeoff is operational complexity: a service mesh is a significant piece of infrastructure with its own failure modes, upgrade path, and operational burden. The L6/L7 decision is whether the mesh's benefits (mTLS everywhere, fine-grained traffic control, L7 metrics) justify the operational cost for your organization's maturity level and threat model. At FAANG scale, the answer is almost always yes. At a 50-person startup, the answer may be to start with Kubernetes network policies and add a mesh later.

The retry and circuit-breaking patterns in this section become platform-level concerns at scale. Individual services implementing their own retry logic with incompatible parameters can cause retry storms under load. A platform-level standard for retry budgets, exponential backoff parameters, and circuit breaker configuration is the senior contribution: define it once, implement it in a shared library, enforce it in code review.
