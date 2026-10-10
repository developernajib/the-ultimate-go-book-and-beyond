## 102F.3 Golden Path Template - Go Microservice

The skeleton directory (referenced by the Backstage template) contains the actual file templates:

```
skeleton/
├── catalog-info.yaml
├── README.md
├── go.mod
├── main.go
├── internal/
│   ├── handler/
│   ├── service/
│   └── repository/
├── cmd/
├── Dockerfile
├── .github/
│   └── workflows/
│       └── ci.yaml
├── helm/
│   └── ${{ values.name }}/
└── k8s/
    ├── base/
    └── overlays/
        ├── dev/
        └── staging/
```

```go
// skeleton/main.go
package main

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/prometheus/client_golang/prometheus/promhttp"
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/trace"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
    slog.SetDefault(logger)

    // Initialize tracing
    ctx := context.Background()
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(getEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "otel-collector:4317")),
    )
    if err != nil {
        logger.Error("failed to create trace exporter", "err", err)
        os.Exit(1)
    }
    tp := trace.NewTracerProvider(
        trace.WithBatcher(exporter),
        trace.WithSampler(trace.AlwaysSample()),
    )
    otel.SetTracerProvider(tp)
    defer tp.Shutdown(ctx)

    mux := http.NewServeMux()
    mux.Handle("/metrics", promhttp.Handler())
    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        fmt.Fprint(w, `{"status":"ok"}`)
    })
    mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        fmt.Fprint(w, `{"status":"ready"}`)
    })

    // Register your routes here
    // mux.Handle("/api/v1/", apiHandler)

    port := getEnv("PORT", "8080")
    server := &http.Server{
        Addr:         ":" + port,
        Handler:      mux,
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 30 * time.Second,
        IdleTimeout:  120 * time.Second,
    }

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

    go func() {
        logger.Info("server starting", "port", port)
        if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            logger.Error("server error", "err", err)
            os.Exit(1)
        }
    }()

    <-quit
    logger.Info("shutting down")

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    server.Shutdown(shutdownCtx)
    logger.Info("shutdown complete")
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

```dockerfile
# skeleton/Dockerfile - multi-stage, distroless
FROM golang:1.27.1-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/server /server
ENTRYPOINT ["/server"]
```

### Junior → FAANG: What Makes a Golden Path Template Actually Golden

The skeleton directory shown here is not just boilerplate. Each decision reflects a production requirement that a junior engineer should be able to explain in an interview.

The `main.go` template initializes an OpenTelemetry trace exporter before starting the HTTP server. This means every service created from this template is observable from day one, with no additional setup required. A junior engineer reviewing a service and noticing it has no tracing configured should immediately ask: "Is this service on the golden path?" If it is, something went wrong during scaffolding. If it is not, the team owns the operational burden of adding tracing themselves.

The Dockerfile uses a multi-stage build with a distroless base image. The distroless image contains no shell, no package manager, and no system libraries beyond what Go needs to run. This eliminates an entire category of CVEs from the attack surface. For an interview question like "how would you reduce the security risk of your Docker images?", this is the correct answer at the platform level: make the secure image the default, not a requirement that each team must implement.

The graceful shutdown pattern (`signal.Notify` then `server.Shutdown` with a timeout context) is a production requirement for Kubernetes. When Kubernetes sends SIGTERM to a pod, the pod has a grace period (usually 30 seconds) to finish in-flight requests before being killed. Without graceful shutdown, active requests are dropped. The golden path bakes this in so that every service handles pod termination correctly without any team-specific work.

### Senior @ FAANG: Golden Path Versioning and Long-Term Maintenance

The skeleton shown here is `v1` of the golden path. From a staff engineering perspective, the most important question is not "what does this skeleton contain?" but "how does this skeleton evolve over the lifetime of the services it creates?"

Services are created from the skeleton once, but they live and evolve for years. When the golden path updates (new Go version, new observability library, new security default), services created from the old skeleton do not automatically inherit those changes. This is the golden path maintenance problem, and it is harder than the initial implementation.

The solution used at Netflix and other mature platform organizations is a drift detection mechanism: a background job that scans all services in the catalog, compares their current configuration against the current golden path version, and opens automated pull requests that apply the update. This is only feasible if the golden path is designed with machine-readability in mind: consistent file structure, no hand-edited configuration, and a version marker in `catalog-info.yaml` that the drift detector can query.

The second staff-level concern is the Go version pinned in `go.mod` and the Docker builder stage. When a Go security release ships, every golden-path service needs its builder image updated. If that update requires a PR to each service repository, the blast radius is every service in the organization. A more scalable approach pins the builder image to a tag controlled by the platform team (e.g., `acme-corp/go-builder:latest` managed via the platform's image registry) so that a single image update cascades to all services on the next CI run, with no per-service PRs required.

The OTel sampler in the template uses `trace.AlwaysSample()`. This is correct for development but catastrophically expensive in production for high-traffic services. The golden path should configure sampling from environment variables so that production deployments can set a lower sampling rate without modifying application code. This is an example of a platform decision that looks trivial in a skeleton but has real cost implications at production traffic volumes.
