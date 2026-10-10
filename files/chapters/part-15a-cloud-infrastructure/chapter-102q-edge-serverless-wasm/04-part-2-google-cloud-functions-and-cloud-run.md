## 102Q.2 Google Cloud Functions and Cloud Run

### Cloud Functions Gen2

Cloud Functions Gen2 uses the Functions Framework, which calls `functions.HTTP` in `init()` to register a named handler that the framework's HTTP server will route to. This indirection means your function code never calls `http.ListenAndServe` directly, the framework manages the server lifecycle, graceful shutdown, and the `PORT` binding that Cloud Run (which powers Gen2) requires. Because the handler signature is a plain `http.HandlerFunc`, you can unit-test it without any GCP dependencies by constructing an `httptest.ResponseRecorder` and calling the function directly.

```go
// functions/hello.go
package functions

import (
	"encoding/json"
	"net/http"

	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
)

func init() {
	functions.HTTP("HandleRequest", HandleRequest)
}

func HandleRequest(w http.ResponseWriter, r *http.Request) {
	var d struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if d.Message == "" {
		d.Message = "Hello, World!"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"reply": d.Message})
}
```

### Cloud Run: Container-based Serverless

Cloud Run terminates instances by sending `SIGTERM` and then waiting up to the configured max-instance-shutdown timeout (default 10 seconds) before sending `SIGKILL`. Catching `SIGTERM` with `signal.NotifyContext` and calling `srv.Shutdown` within that window drains in-flight requests cleanly rather than dropping them mid-response. The structured JSON logger using `slog` writes machine-readable logs that Cloud Logging can parse and index without a custom log format, enabling log-based metrics and alerts directly in the Google Cloud console.

```go
// cmd/cloudrun/main.go
// Cloud Run: HTTP server that scales to zero
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("POST /process", handleProcess(logger))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown - Cloud Run sends SIGTERM before terminating
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		logger.Info("server starting", slog.String("port", port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", slog.String("error", err.Error()))
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown error", slog.String("error", err.Error()))
	}
}

func handleProcess(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}

		logger.InfoContext(r.Context(), "processing", slog.Any("payload", payload))

		result := processPayload(payload)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

func processPayload(p map[string]any) map[string]any {
	return map[string]any{
		"processed": true,
		"input":     p,
	}
}
```

```dockerfile
# Dockerfile for Cloud Run (multi-stage)
FROM golang:1.27.1-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/cloudrun

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app/server /server
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/server"]
```

---

### Junior → FAANG: Cloud Run Concurrency as the Defining Difference from Lambda

The critical behavioral difference between Cloud Run and Lambda is the concurrency model. A Lambda function handles exactly one request per container instance. Cloud Run instances handle multiple concurrent requests, with the concurrency limit configurable per service (default 80, maximum 1000). This means a Cloud Run Go service must be written with concurrency safety: no shared mutable state without synchronization, connection pools sized for concurrent access, and context propagation for every request. Lambda's single-request-per-container model makes some of these concerns irrelevant for that runtime.

The practical implication for architecture: Cloud Run is more efficient for CPU-bound workloads where multiple concurrent requests can share a container's CPU allocation. Lambda is simpler for engineers who do not want to reason about concurrent request handling. Neither is universally better. Knowing the tradeoff and being able to articulate it in an interview is what distinguishes a prepared candidate.

Workload Identity is the GCP equivalent of IAM roles for Lambda. Every Cloud Run service should have its own service account with minimum required permissions. The pattern of using the default compute service account (which has project-editor level access by default) is a high-severity security misconfiguration. Establishing the habit of creating a dedicated service account for every service, regardless of GCP's permissive default, is the correct first-job behavior.

### Senior @ FAANG: Cloud Run Fleet Governance and Concurrency Tuning

At staff level, Cloud Run concurrency is a fleet-wide optimization problem, not a per-service tuning exercise. The default concurrency of 80 is appropriate for I/O-bound services where goroutines spend most of their time waiting on network calls. CPU-bound services should have lower concurrency (10-20) to avoid CPU contention between concurrent requests on a single instance. Memory-intensive services should calculate concurrency as floor(instance-memory / per-request-memory) to avoid OOM conditions under load.

The platform team should provide a concurrency calculator: given a service's memory limit, its measured per-request memory allocation, and whether it is I/O-bound or CPU-bound, what concurrency setting produces the best cost-efficiency? Providing this as a tool (a simple CLI that takes benchmark results and outputs recommended settings) is more effective than documentation, because teams will use the tool and ignore the documentation.

Cloud Run's minimum-instances setting is the knob that controls cold start frequency at the cost of idle compute billing. The organizational policy should define which service tiers qualify for minimum instances: customer-facing synchronous APIs (yes), internal async processing services (no), batch-triggered functions (no). Enforcing this policy through a deployment review step rather than per-team judgment prevents both the over-provisioning pattern (every service gets minimum instances because cold starts are bad) and the under-provisioning pattern (no service gets minimum instances because idle billing is bad). The platform team's benchmark for the cold start cost of a minimum instance (typically $15--$50/month per instance in us-central1 for a 256MB service) makes the policy decision concrete rather than abstract.
