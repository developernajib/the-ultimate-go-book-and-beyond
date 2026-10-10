## 100.9 Cloud Run

### Cloud Run Service

Cloud Run injects the `PORT` environment variable at runtime and expects the container to listen on it within a few seconds or the instance is considered unhealthy. Reading `PORT` at startup rather than hardcoding `8080` is therefore mandatory for the platform to route traffic correctly. The `K_SERVICE` and `K_REVISION` environment variables, also injected by Cloud Run, let the handler self-identify in responses, useful when debugging a canary rollout where two revisions serve traffic simultaneously.

```go
// main.go - Cloud Run service
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "os"
)

func main() {
    port := os.Getenv("PORT")
    if port == "" {
        port = "8080"
    }

    http.HandleFunc("/", handler)
    http.HandleFunc("/health", healthHandler)

    log.Printf("Starting server on port %s", port)
    if err := http.ListenAndServe(":"+port, nil); err != nil {
        log.Fatal(err)
    }
}

func handler(w http.ResponseWriter, r *http.Request) {
    response := map[string]string{
        "message": "Hello from Cloud Run!",
        "service": os.Getenv("K_SERVICE"),
        "revision": os.Getenv("K_REVISION"),
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}
```

### Dockerfile for Cloud Run

A multi-stage build is critical for Cloud Run because image size directly affects cold-start latency, the platform must pull the image before the first request can be served. The builder stage compiles a fully static binary with `CGO_ENABLED=0`, and the final stage copies only that binary into Google's `distroless/static-debian12` image, which contains no shell, package manager, or libc, reducing the attack surface and bringing the final image to under 10 MB. Running as `nonroot:nonroot` satisfies Cloud Run's default security policy and prevents any accidental writes to the container filesystem.

```dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/server ./cmd/server

FROM gcr.io/distroless/static-debian12

COPY --from=builder /app/server /server

USER nonroot:nonroot

EXPOSE 8080

ENTRYPOINT ["/server"]
```

---

### Junior → FAANG: Cloud Run as the Simplest Path to Serverless Containers

Cloud Run is the simplest production deployment target for a Go HTTP service: build a container image, push it to Artifact Registry, deploy with `gcloud run deploy`. Cloud Run handles scaling (including scale to zero), HTTPS termination, domain routing, and health checking automatically. The developer responsibility is a correct container image with a properly configured HTTP server.

The key Cloud Run requirement: the application must listen on the port specified by the `PORT` environment variable (not a hardcoded port). Cloud Run injects `PORT` at runtime and expects the container to listen there. A `server.go` that hardcodes port 8080 will work in most cases (Cloud Run defaults to 8080), but reading from `os.Getenv("PORT")` with a fallback is the correct pattern.

Scale-to-zero means cold starts occur when a service has been idle. For Go, the cold start is typically under 500ms for a minimal service, which is acceptable for most use cases. For latency-sensitive services, configure `minInstances: 1` to keep one instance always warm at the cost of continuous compute billing.

### Senior @ FAANG: Cloud Run Architecture and Cost/Performance Trade-offs

At staff level, Cloud Run is one deployment target in a spectrum that includes Cloud Functions (simpler, more limited), Cloud Run (containers with full control), and GKE (full Kubernetes for complex workloads). The selection criteria: Cloud Run is the right choice when you need container flexibility, per-request billing economics make sense for your traffic pattern, and you do not need Kubernetes-specific features (StatefulSets, custom controllers, advanced networking).

The concurrency model of Cloud Run differs from Lambda: each Cloud Run instance can handle multiple concurrent requests (configurable via `maxConcurrency`, defaulting to 80). For Go services with I/O-bound request handling, high concurrency is appropriate. For CPU-bound workloads, concurrency should match the vCPU allocation. Setting concurrency too high for CPU-bound workloads causes CPU starvation and latency degradation.

Cloud Run's request-timeout limit (60 seconds for HTTP, 60 minutes for Cloud Run Jobs) constrains which workloads are appropriate. Long-running batch jobs should use Cloud Run Jobs (formerly Cloud Run for Anthos batch) or be broken into smaller chunks that fit within the timeout. The architecture decision between Cloud Run and Cloud Run Jobs, and between synchronous HTTP request handling and async job processing via Pub/Sub, is the staff-level design choice for each workload category.
