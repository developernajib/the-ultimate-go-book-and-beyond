## Part 13: Production Considerations

Running a chat application in production requires more than working code, you need visibility into how the system behaves under real traffic. In this section, you will add Prometheus metrics to track active WebSocket connections, message throughput, and error rates. You will also implement structured logging with correlation IDs so you can trace a single user action across multiple services. These observability tools are what allow on-call engineers to diagnose issues quickly when something goes wrong at 3 AM, and they are a standard expectation at any company operating real-time systems at scale.

### 13.1 Monitoring and Observability

Observability for a social platform requires correlated metrics, distributed traces, and structured logs that span service boundaries. Tracking user-facing latency percentiles and error rates per endpoint surfaces degradations before they escalate into user-visible outages.

```go
// internal/observability/metrics.go
package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// WebSocket metrics
	ActiveConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "gochat_websocket_active_connections",
		Help: "Number of active WebSocket connections",
	})

	MessagesReceived = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gochat_messages_received_total",
		Help: "Total number of messages received",
	})

	MessagesSent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "gochat_messages_sent_total",
		Help: "Total number of messages sent",
	})

	MessageLatency = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "gochat_message_latency_seconds",
		Help:    "Message processing latency",
		Buckets: prometheus.DefBuckets,
	})

	// Database metrics
	DBQueries = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "gochat_db_queries_total",
			Help: "Total number of database queries",
		},
		[]string{"operation", "status"},
	)

	DBLatency = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "gochat_db_query_duration_seconds",
			Help:    "Database query latency",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"operation"},
	)
)
```

### 13.2 Health Checks

Health check endpoints let load balancers and orchestrators verify that the server is alive and its dependencies (PostgreSQL, Redis) are reachable. The liveness endpoint confirms the process is running, and the readiness endpoint confirms the service can serve requests.

```go
// internal/api/health.go
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

type HealthHandler struct {
	db          *sql.DB
	redisClient *redis.Client
}

func NewHealthHandler(db *sql.DB, redisClient *redis.Client) *HealthHandler {
	return &HealthHandler{
		db:          db,
		redisClient: redisClient,
	}
}

type HealthStatus struct {
	Status   string            `json:"status"`
	Services map[string]string `json:"services"`
}

func (h *HealthHandler) Health(w http.ResponseWriter, r *http.Request) {
	status := HealthStatus{
		Status:   "healthy",
		Services: make(map[string]string),
	}

	// Check PostgreSQL
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := h.db.PingContext(ctx); err != nil {
		status.Services["postgres"] = "unhealthy"
		status.Status = "degraded"
	} else {
		status.Services["postgres"] = "healthy"
	}

	// Check Redis
	if err := h.redisClient.Ping(ctx).Err(); err != nil {
		status.Services["redis"] = "unhealthy"
		status.Status = "degraded"
	} else {
		status.Services["redis"] = "healthy"
	}

	code := http.StatusOK
	if status.Status != "healthy" {
		code = http.StatusServiceUnavailable
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(status)
}

func (h *HealthHandler) Ready(w http.ResponseWriter, r *http.Request) {
	// Simple readiness check
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ready"))
}
```

### 13.3 Graceful Shutdown

Graceful shutdown listens for SIGINT/SIGTERM, stops accepting new connections, drains in-flight WebSocket sessions, and closes database and Redis connections in order. This prevents message loss during deployments.

```go
// Enhanced shutdown in cmd/server/main.go
func gracefulShutdown(server *http.Server, hub *chat.Hub, db *sql.DB, redis *redis.Client) {
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Initiating graceful shutdown...")

	// Stop accepting new connections
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Stop WebSocket hub
	log.Println("Stopping WebSocket hub...")
	hub.Shutdown()

	// Shutdown HTTP server
	log.Println("Shutting down HTTP server...")
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced to shutdown: %v", err)
	}

	// Close database connections
	log.Println("Closing database connections...")
	if err := db.Close(); err != nil {
		log.Printf("Error closing database: %v", err)
	}

	// Close Redis connection
	log.Println("Closing Redis connection...")
	if err := redis.Close(); err != nil {
		log.Printf("Error closing Redis: %v", err)
	}

	log.Println("Server stopped gracefully")
}
```

### 13.4 Horizontal Scaling Strategy

**Key Considerations:**
1. **Sticky Sessions**: Use consistent hashing or session affinity at load balancer
2. **Redis Pub/Sub**: All servers subscribe to broadcast channels
3. **Presence Management**: Use Redis for shared state
4. **Message Persistence**: All messages saved to PostgreSQL
5. **File Uploads**: Use S3 for shared file storage

**Load Balancer Configuration (NGINX):**

```nginx
upstream gochat {
    ip_hash;  # Sticky sessions based on IP
    server app1:8080;
    server app2:8080;
    server app3:8080;
}

server {
    listen 80;
    server_name chat.example.com;

    location /ws {
        proxy_pass http://gochat;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://gochat;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Junior → FAANG: Observability as a Production Requirement

The observability additions in this chapter (Prometheus metrics, structured logging with correlation IDs) are not optional for a production service. They are the minimum viable observability stack. Without metrics, you cannot know if your service is degrading. Without correlation IDs, you cannot trace a single user's request across multiple log lines.

For WebSocket servers specifically, the most important metrics are: active connections (total count, broken down by server instance), messages per second (published and received), connection establishment rate (how many new connections per second), and connection error rate (how many connections close with errors versus clean close frames). These four metrics tell you the health of the real-time layer at a glance.

Structured logging (JSON format with consistent field names) means that log aggregation tools can parse and query your logs programmatically. Ad-hoc text logs are search-only. Structured logs support filtering, aggregation, and alerting.

### Senior @ FAANG: Observability at the System Level

At senior level, observability is designed for the system, not for individual services. When a user reports "my messages are not being delivered," the on-call engineer needs to trace the message from the client through the WebSocket server, through Redis Pub/Sub, to the recipient's WebSocket connection. That trace crosses three components. Without distributed tracing (a correlation ID that flows through all three), the engineer must correlate log entries manually by timestamp and content, which is slow and error-prone.

Service Level Objectives for a chat system require careful definition. "Messages delivered within 500ms of sending" sounds clear, but how is it measured? From the sender's WebSocket send event to the recipient's WebSocket receive event requires client-side timing, which introduces clock skew between sender and recipient. Server-side timing (from the handler receiving the message to publishing to Redis Pub/Sub) is easier to measure but does not capture the last mile to the recipient. Define measurement methodology before defining the SLO number.

Capacity planning for WebSocket servers requires different models than for stateless HTTP services. The binding constraint is often memory (goroutines and buffers per connection), not CPU. Profiling a production server under load to measure bytes-per-connection allows accurate capacity forecasting. A connection that consumes 50KB of memory (goroutine stacks, read/write buffers, channel buffers) limits a 4GB server to approximately 80,000 connections before memory saturation. Documenting this model and monitoring memory utilization per instance is the basis for autoscaling decisions.

---
