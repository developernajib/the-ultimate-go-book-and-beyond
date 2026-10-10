## 98.4 Graceful Shutdown

### Signal Handling for Kubernetes

When Kubernetes terminates a pod it sends `SIGTERM` to the container process, then waits up to `terminationGracePeriodSeconds` before forcibly sending `SIGKILL`. Without signal handling, an abrupt kill drops all in-flight HTTP requests. The pattern below registers a buffered channel for both `os.Interrupt` (Ctrl+C in local dev) and `syscall.SIGTERM` (Kubernetes), then calls `server.Shutdown` which stops accepting new connections but allows active handlers to finish within the context deadline.

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func setupRoutes() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("OK"))
    })
    return mux
}

func main() {
    server := &http.Server{
        Addr:         ":8080",
        Handler:      setupRoutes(),
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    // Channel to listen for shutdown signals
    shutdown := make(chan os.Signal, 1)
    signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

    // Start server in goroutine
    go func() {
        log.Printf("Starting server on %s", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    // Wait for shutdown signal
    sig := <-shutdown
    log.Printf("Received signal %v, shutting down...", sig)

    // Create deadline for graceful shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Shutdown gracefully
    if err := server.Shutdown(ctx); err != nil {
        log.Printf("Graceful shutdown failed: %v", err)
        server.Close()
    }

    log.Println("Server stopped")
}
```

### Kubernetes Pod Termination

The `terminationGracePeriodSeconds` value must be at least as large as your application's shutdown timeout, if Kubernetes kills the pod before the server finishes draining, in-flight requests are still lost. The `preStop` sleep of 5 seconds gives kube-proxy and cloud load balancers time to remove the pod from their routing tables before the process starts refusing new connections, preventing a race condition where traffic is still being forwarded to a pod that has already stopped accepting it.

```yaml
# deployment.yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30  # Match your shutdown timeout
      containers:
      - name: myapp
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]  # Allow LB to drain
```

### Deep Dive: The IPTables / eBPF Propagation Race Condition & Context Cascades

In production Kubernetes clusters, handling `SIGTERM` alone does not prevent 502 Bad Gateway errors during rolling updates. As documented in production post-mortems (such as [What running go in kubernates taught me the hard way](https://medium.com/@yaninyzwitty/what-running-go-in-kubernates-taught-me-the-hard-way) by Yaninyz witty), Pod termination involves an asynchronous distributed race condition between the control plane and the data plane:

```
Pod Marked "Terminating"
   ├── Path A (Data Plane): Kubelet sends SIGTERM to Pod container (Immediate: t=0)
   └── Path B (Control Plane):
         ├── 1. EndpointController removes Pod IP from Endpoints / EndpointSlices (t = +100ms)
         ├── 2. Kube-proxy / Cilium watches API server across 500 nodes (t = +200ms to +800ms)
         └── 3. Kernel iptables / IPVS / eBPF rule tables rewrite across nodes (t = +500ms to +2000ms)
```

If the Go application receives `SIGTERM` at $t=0$ and immediately invokes `server.Shutdown(ctx)`, the listener socket closes. However, for up to 2 seconds, remote ingress proxies and internal microservices continue routing new TCP `SYN` packets to that Pod's IP because their local iptables have not yet updated. The result is instant `ECONNREFUSED` and 502 responses.

#### The Two-Phase Shutdown Architecture

To eliminate this race condition without depending exclusively on container runtime hooks:
1. **Endpoint Descheduling Delay**: Upon catching `SIGTERM`, mark readiness probes as unhealthy (`503 Service Unavailable`) and sleep for 2 to 5 seconds while keeping the HTTP listener active. This allows kube-proxy to complete endpoint removal cluster-wide.
2. **Dedicated Drain Context**: Avoid cancelling the root application context on SIGTERM. If in-flight handlers share a root context that cancels on signal arrival, in-flight database transactions and API calls abort mid-flight. Keep request contexts alive while giving `server.Shutdown` a separate bounded timeout.

```go
package main

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

type AppServer struct {
	httpServer *http.Server
	db         *sql.DB
	isReady    atomic.Bool
}

func (s *AppServer) SetupRoutes() http.Handler {
	mux := http.NewServeMux()

	// Liveness: Is the runtime responsive? Never fails during graceful drain.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	// Readiness: Can the pod accept new traffic?
	// Fails immediately when shutdown sequence initiates.
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if !s.isReady.Load() {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})

	// Business API
	mux.HandleFunc("/api/v1/orders", func(w http.ResponseWriter, r *http.Request) {
		// Handlers rely on r.Context() which remains active during server.Shutdown.
		// server.Shutdown stops accepting new connections but lets active handlers finish.
		time.Sleep(100 * time.Millisecond) // Simulated query
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"processed"}`))
	})

	return mux
}

func main() {
	app := &AppServer{}
	app.isReady.Store(true)

	app.httpServer = &http.Server{
		Addr:         ":8080",
		Handler:      app.SetupRoutes(),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("server listening on %s", app.httpServer.Addr)
		if err := app.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server listen failure: %v", err)
		}
	}()

	// Trap termination signals
	shutdownSignal := make(chan os.Signal, 1)
	signal.Notify(shutdownSignal, syscall.SIGTERM, syscall.SIGINT)

	sig := <-shutdownSignal
	log.Printf("received signal %v: initiating two-phase shutdown", sig)

	// Phase 1: Mark readiness probe false so load balancers stop sending new requests
	app.isReady.Store(false)

	// Wait 2 to 3 seconds for iptables / kube-proxy / ingress controller propagation.
	// Inbound requests during this window are still served successfully.
	log.Println("waiting 3 seconds for cluster endpoint propagation lag...")
	time.Sleep(3 * time.Second)

	// Phase 2: Close listener and drain in-flight connections
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer drainCancel()

	log.Println("draining active connections...")
	if err := app.httpServer.Shutdown(drainCtx); err != nil {
		log.Printf("graceful shutdown failed, forcing close: %v", err)
		_ = app.httpServer.Close()
	}

	// Close database connection pools AFTER server.Shutdown returns
	if app.db != nil {
		_ = app.db.Close()
	}

	log.Println("shutdown completed cleanly")
}
```

```yaml
# Pod spec configuration to match two-phase shutdown
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  replicas: 3
  template:
    spec:
      # Must be higher than: iptables sleep (3s) + drain timeout (25s) = 28s
      terminationGracePeriodSeconds: 35
      containers:
      - name: app
        image: order-service:v1.2.0
        ports:
        - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /readyz
            port: 8080
          periodSeconds: 2
          failureThreshold: 1
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          periodSeconds: 10
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sleep", "3"]
```

### Junior → FAANG: Why Graceful Shutdown Matters and How to Implement It

Graceful shutdown is one of the most overlooked production concerns for engineers new to container environments. The failure mode without it: Kubernetes sends SIGTERM to a pod before a new version is ready, the process exits immediately, and any in-flight HTTP requests return connection reset errors to clients. This causes a brief error spike on every deployment.

The Go implementation pattern is straightforward: listen for SIGTERM (and SIGINT for local development) on a channel, start a `http.Server.Shutdown` call with a context deadline when the signal arrives, and wait for it to complete before exiting. The context deadline should be shorter than the pod's `terminationGracePeriodSeconds` to ensure the process exits cleanly before Kubernetes force-kills it with SIGKILL.

The `preStop` sleep hook exists because Kubernetes removes the pod from the Service endpoint list and sends SIGTERM in parallel. Without the sleep, SIGTERM arrives before all load balancers have propagated the endpoint removal, and some requests are still being routed to a pod that is already shutting down. A 5-second sleep in the preStop hook gives the load balancer time to stop routing new requests before the graceful shutdown begins.

### Senior @ FAANG: Graceful Shutdown as a Platform Contract

At staff level, graceful shutdown is a platform contract between the deployment system and every service. The terms of the contract: the platform guarantees that SIGTERM will be sent before any load balancer changes, there will be at least N seconds between SIGTERM and SIGKILL (defined by `terminationGracePeriodSeconds`), and in-flight requests will not be killed. The service agrees to handle SIGTERM correctly, complete in-flight work within the grace period, and exit cleanly.

The platform responsibility is to set `terminationGracePeriodSeconds` appropriately for each service tier. A service with P99 latency of 50ms needs a much shorter grace period than a service that processes long-running jobs. The platform default (30 seconds) may be too long for latency-sensitive services (causing slow deployments) and too short for batch services (causing incomplete processing).

For services that process messages from queues or streams, graceful shutdown requires draining the in-flight message set, committing or nacking processed messages, and only then exiting. This is more complex than HTTP shutdown and requires application-level cooperation with the queue client. Designing the shutdown sequence for a streaming processor is a non-trivial engineering problem that benefits from a platform-level library rather than each team solving it independently. The staff contribution is to identify this as a common pattern, design the library, and drive adoption.

---
