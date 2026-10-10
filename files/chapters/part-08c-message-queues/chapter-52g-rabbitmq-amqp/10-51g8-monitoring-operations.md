## 52G.8 Monitoring & Operations

### Key Metrics to Track

| Metric | Alert Threshold | Meaning |
|--------|----------------|---------|
| `queue.messages` | > 10,000 | Queue backlog growing |
| `queue.consumers` | == 0 | No consumers, messages accumulating |
| `connection.count` | > 500 | Connection leak |
| `memory.used_ratio` | > 0.7 | Approaching memory alarm |
| `disk_free` | < 50MB | Disk alarm imminent |
| `messages.unacked` | > prefetch × consumers | Consumer processing too slow |

### Management HTTP API Client

RabbitMQ's Management Plugin exposes an HTTP API for monitoring queue depths, connection counts, message rates, and node health. The following Go client wraps the key endpoints with typed response structs, making it straightforward to integrate RabbitMQ metrics into your existing observability pipeline.

```go
package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// QueueStats represents queue stats from the RabbitMQ Management API.
type QueueStats struct {
	Name              string  `json:"name"`
	Messages          int64   `json:"messages"`
	MessagesReady     int64   `json:"messages_ready"`
	MessagesUnacked   int64   `json:"messages_unacknowledged"`
	Consumers         int     `json:"consumers"`
	PublishRate       float64 `json:"message_stats.publish_details.rate"`
	DeliverAckRate    float64 `json:"message_stats.deliver_get_details.rate"`
	State             string  `json:"state"` // "running", "idle", "flow"
}

// NodeStats represents node-level stats.
type NodeStats struct {
	Name           string `json:"name"`
	MemUsed        int64  `json:"mem_used"`
	MemLimit       int64  `json:"mem_limit"`
	DiskFree       int64  `json:"disk_free"`
	DiskFreeLimit  int64  `json:"disk_free_limit"`
	MemAlarm       bool   `json:"mem_alarm"`
	DiskFreeAlarm  bool   `json:"disk_free_alarm"`
	Running        bool   `json:"running"`
}

// ManagementClient queries the RabbitMQ Management HTTP API.
type ManagementClient struct {
	baseURL string
	client  *http.Client
	logger  *slog.Logger
}

// NewManagementClient creates a client for the Management HTTP API.
func NewManagementClient(baseURL string, logger *slog.Logger) *ManagementClient {
	return &ManagementClient{
		baseURL: baseURL,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		logger: logger,
	}
}

// GetQueues returns stats for all queues in the given vhost.
func (m *ManagementClient) GetQueues(ctx context.Context, vhost string) ([]QueueStats, error) {
	url := fmt.Sprintf("%s/api/queues/%s", m.baseURL, vhost)
	return doRequest[[]QueueStats](ctx, m.client, url)
}

// GetNodes returns stats for all cluster nodes.
func (m *ManagementClient) GetNodes(ctx context.Context) ([]NodeStats, error) {
	url := fmt.Sprintf("%s/api/nodes", m.baseURL)
	return doRequest[[]NodeStats](ctx, m.client, url)
}

func doRequest[T any](ctx context.Context, client *http.Client, url string) (T, error) {
	var zero T
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return zero, fmt.Errorf("create request: %w", err)
	}

	resp, err := client.Do(req)
	if err != nil {
		return zero, fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return zero, fmt.Errorf("api returned %d for %s", resp.StatusCode, url)
	}

	var result T
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return zero, fmt.Errorf("decode response: %w", err)
	}
	return result, nil
}

// HealthCheck verifies RabbitMQ connectivity and returns readiness.
func HealthCheck(ctx context.Context, mgmtClient *ManagementClient, vhost string, logger *slog.Logger) error {
	nodes, err := mgmtClient.GetNodes(ctx)
	if err != nil {
		return fmt.Errorf("health check: cannot reach RabbitMQ: %w", err)
	}

	for _, node := range nodes {
		if node.MemAlarm {
			logger.Error("health check: memory alarm active", "node", node.Name)
			return fmt.Errorf("node %s has active memory alarm", node.Name)
		}
		if node.DiskFreeAlarm {
			logger.Error("health check: disk alarm active", "node", node.Name)
			return fmt.Errorf("node %s has active disk alarm", node.Name)
		}
		if !node.Running {
			return fmt.Errorf("node %s is not running", node.Name)
		}
	}

	queues, err := mgmtClient.GetQueues(ctx, vhost)
	if err != nil {
		return fmt.Errorf("health check: cannot list queues: %w", err)
	}

	for _, q := range queues {
		if q.Consumers == 0 && q.Messages > 0 {
			logger.Warn("health check: queue has messages but no consumers",
				"queue", q.Name,
				"messages", q.Messages,
			)
		}
		if q.MessagesUnacked > 10000 {
			logger.Warn("health check: high unacked count",
				"queue", q.Name,
				"unacked", q.MessagesUnacked,
			)
		}
	}

	return nil
}
```

### Junior → FAANG: The Six Metrics You Must Know Before Your First On-Call Shift

Most junior engineers do not think about monitoring until their first production incident. By then, it is too late to learn which metrics matter. Learn these before you ship anything to production.

**Queue depth is the primary health signal:**

`queue.messages` tells you how many messages are waiting unprocessed. A queue depth of zero with active consumers is healthy. A growing queue depth with active consumers means consumers are slower than producers. A non-zero queue depth with zero consumers means all consumers have died. Alert on both conditions separately because they have different remediation paths.

**Unacked count bounds your blast radius on consumer death:**

`messages.unacknowledged` tells you how many messages have been delivered to consumers but not yet acknowledged. When a consumer dies, all its unacked messages return to the queue. If the unacked count is 10,000 at peak (because prefetch is set too high), a consumer death causes 10,000 redeliveries at once. Alerting when unacked exceeds `prefetch × consumer_count × 2` catches prefetch misconfiguration before it becomes a redelivery storm.

**Memory alarm is a cluster-wide emergency:**

When `mem_used_ratio > 0.4`, RabbitMQ triggers a memory alarm and blocks all producers. Alert at 0.7 to give yourself 10-20 minutes before the alarm fires. At 0.85, start killing the largest queues or scaling consumers immediately. Waiting for the alarm to fire means producers are already blocked and users are already experiencing failures.

**Connection count signals connection leaks:**

Each service instance should have exactly one connection. If `connection.count` grows beyond `instance_count × 2`, something is creating connections without closing them. Common causes: using `amqp.Dial` inside a request handler, goroutine leaks that hold connections open, and reconnect loops that create new connections before closing old ones.

### Senior @ FAANG: Observability Architecture for RabbitMQ at Platform Scale

At the senior level, monitoring RabbitMQ is not about watching dashboards. It is about building the observability architecture that lets teams self-serve incident triage without requiring platform team involvement.

**The four layers of RabbitMQ observability:**

Layer 1 is broker metrics via the Prometheus exporter (`rabbitmq_prometheus` plugin). This gives you queue depths, message rates, consumer counts, connection counts, and node health. Standard dashboards exist for Grafana and are a good starting point.

Layer 2 is consumer-side structured logging with correlation IDs. Every message should carry a trace ID in its headers. The consumer logs delivery tag, trace ID, processing duration, and outcome (ack/nack) as a structured log event. This enables per-message tracing across the broker boundary.

Layer 3 is DLQ alerting. A Prometheus counter that increments every time a message reaches the permanent DLQ, with an alert threshold that fires when DLQ arrivals exceed background noise (calibrated per queue). This is the leading indicator of consumer bugs.

Layer 4 is the Management HTTP API used for operational automation: queue depth queries for autoscaling decisions, consumer count queries for health checks, and policy verification to confirm that operator policies are applied correctly after topology changes.

**SLO design for messaging systems:**

For a task queue serving at-least-once processing guarantees, the SLO has two components. First, end-to-end latency: the time from message publish to first processing attempt should be under a threshold (for example, 99% of messages start processing within 1 second). Second, processing completeness: the fraction of messages that eventually reach a successful ack (not the permanent DLQ) should exceed a threshold (for example, 99.9% of messages are successfully processed within 24 hours). The first SLO is measured by timestamping messages at publish time and recording the consumer start time. The second SLO is measured by counting DLQ arrivals as a fraction of total publishes.

**Autoscaling via queue depth:**

The platform team should expose queue depth as a scaling signal. Kubernetes KEDA (Kubernetes Event-Driven Autoscaler) supports RabbitMQ queue depth as a scaling trigger natively. The configuration specifies: scale up when queue depth exceeds 1,000 messages, scale down when queue depth reaches zero, with a minimum of 2 replicas and a maximum of 50. This gives elastic consumer capacity without manual intervention. The platform team owns the KEDA ScaledObject definitions as infrastructure-as-code, with service teams specifying their queue name and depth thresholds.

**The operational gap in the Management API client:**

The `ManagementClient` in this section does not handle authentication, pagination, or vhost URL-encoding. In production, the Management API requires HTTP Basic Auth credentials, responses for large clusters are paginated (`page=1&page_size=100`), and vhost names that contain slashes must be URL-encoded as `%2F`. A production client must handle all three. The platform library should wrap the Management API client with these concerns handled transparently, so service teams can query queue stats without knowing the API's quirks.

---
