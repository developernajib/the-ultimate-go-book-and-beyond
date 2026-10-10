## 97.7 Debugging Containers

### Debug Dockerfile

When something goes wrong inside a container, you need the ability to attach a debugger and step through your code line by line. Delve (`dlv`) is the standard debugger for Go, and you can run it inside a Docker container by building your application with debug symbols enabled (using the `-gcflags="all=-N -l"` flag, which disables optimizations and inlining). The debug container exposes port 2345 so you can connect your IDE remotely.

```dockerfile
# Dockerfile.debug - For development/debugging
FROM golang:1.27.1-alpine

# Install debugging tools
RUN apk add --no-cache git curl

# Install delve debugger
RUN go install github.com/go-delve/delve/cmd/dlv@latest

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# Build with debug symbols
RUN go build -gcflags="all=-N -l" -o /app/server ./cmd/server

EXPOSE 8080 2345

# Run with delve
CMD ["dlv", "--listen=:2345", "--headless=true", "--api-version=2", \
     "--accept-multiclient", "exec", "/app/server"]
```

### Health Checks

A health check tells Docker (and orchestrators like Kubernetes) whether your application is actually working, not just whether the process is running. A Go application might be running but deadlocked, out of memory, or unable to reach its database. The `HEALTHCHECK` instruction in a Dockerfile defines a command that Docker runs periodically. If that command fails, Docker marks the container as unhealthy. In the example below, the Go binary itself acts as the health check client when invoked with a special flag.

```dockerfile
FROM scratch

COPY --from=builder /app/server /server

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/server", "-health-check"]

ENTRYPOINT ["/server"]
```

```go
package main

import (
	"net/http"
	"os"
)

// Health check endpoint
func main() {
	if len(os.Args) > 1 && os.Args[1] == "-health-check" {
		resp, err := http.Get("http://localhost:8080/health")
		if err != nil || resp.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		os.Exit(0)
	}

	// Normal server startup...
}
```

---

### Junior → FAANG: Debugging Containers Without Panic

Debugging a container that has no shell is a common first-job shock. The solution is a two-image strategy: a production image based on distroless or scratch, and a debug variant that adds a shell and basic tools. This is expressed in the Dockerfile using a build argument (`ARG VARIANT=prod`) that switches the final `FROM` instruction. Never ship the debug image to production. Use it only for local debugging or post-incident forensics in a staging environment.

The most useful debugging tools to know: `docker exec -it <container> sh` (requires a shell in the image), `docker logs <container>` (reads from stdout/stderr), `docker inspect <container>` (full runtime metadata), and `docker stats <container>` (live CPU and memory). For distroless images without a shell, `kubectl debug` with an ephemeral container is the Kubernetes-native solution.

First-job habit: always structure Go application logs as JSON with a consistent schema. `log.Println("something happened")` is almost useless in a multi-container environment. `zap.Info("request completed", zap.String("path", r.URL.Path), zap.Int("status", status), zap.Duration("latency", d))` can be queried, aggregated, and alerted on.

### Senior @ FAANG: Production Debugging Strategy and Observability Architecture

At staff level, debugging a container in production is not a normal workflow. If engineers routinely need to exec into production containers to understand what is happening, the observability stack is inadequate. The architectural goal is that no engineer should ever need shell access to a production container to diagnose an issue.

The three pillars of container observability that eliminate the need for ad-hoc debugging are: structured logs shipped to a centralized platform (CloudWatch, Stackdriver, Datadog, Elastic) with correlation IDs that trace a request through every service, metrics exposed via the Prometheus scrape model and visualized in Grafana with pre-built dashboards for the standard Go runtime metrics (goroutine count, GC pause, memory) plus application-specific SLIs, and distributed traces using OpenTelemetry with automatic span creation for HTTP and gRPC boundaries.

The senior conversation about debugging containers is really a conversation about runbooks and incident response. When an alert fires, what is the documented procedure? Which metrics do you look at first? What is the escalation path? Owning the observability architecture means owning the answer to "why did that take 45 minutes to diagnose" in an incident retrospective. At L6/L7, that translates to designing the instrumentation standards, building shared libraries that make it easy for service teams to emit the right signals, and tracking mean-time-to-detect and mean-time-to-resolve as team-level engineering metrics.
