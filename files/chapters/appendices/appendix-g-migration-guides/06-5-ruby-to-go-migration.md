## 5. Ruby to Go Migration

### 5.1 Architectural Rationale & Systems Philosophy

Ruby on Rails defined an era of rapid web startup development with "Convention over Configuration" and developer happiness. However, as applications achieve enterprise scale, Ruby's architectural model creates severe operational bottlenecks:

- **Ruby Execution & Memory Model**: Ruby (YARV/MRI) is an interpreted, dynamically typed language constrained by a Global VM Lock (GVL). High-concurrency web services rely on multi-process Puma or Unicorn workers. Ruby's memory allocator (malloc wrapper) exhibits high fragmentation, and Rails' ActiveRecord pattern allocates dozens of Ruby objects per database row fetched, leading to gigabyte-level container memory bloat and frequent GC compaction pauses.
- **Go Model**: Go is statically compiled, memory-efficient, and multi-threaded by default. A Go service handles thousands of concurrent database requests using a single process and tiny memory pool, delivering sub-millisecond JSON serialization and zero memory fragmentation.

```
┌──────────────────────────────────────────────────────────────┐
│                    Ruby/Rails vs. Go Systems                 │
├──────────────────────────────┬───────────────────────────────┤
│ Ruby on Rails Runtime        │ Go Production Service         │
├──────────────────────────────┼───────────────────────────────┤
│ • Interpreted with GVL Lock  │ • Native Multi-Core Binaries  │
│ • Multi-Process Memory Bloat │ • Single Process Goroutines   │
│ • Heavy ActiveRecord Magic   │ • Explicit SQL / SQLx / sqlc  │
│ • High Memory Fragmentation  │ • Linear Slab/Arena Memory    │
│ • 1GB+ per Puma Web Worker   │ • 25MB - 50MB per Pod         │
│ • 50ms - 200ms Response Time │ • 2ms - 10ms P99 Latency      │
└──────────────────────────────┴───────────────────────────────┘
```

---

### 5.2 When Go Is the Best Option (The "Why")

1. **Scaling Background Job Infrastructure**:
   - Ruby background queues (Sidekiq / Resque) processing millions of webhooks, emails, and transactional calculations consume dozens of large Redis and worker nodes. Replacing Sidekiq worker tiers with Go worker pools regularly slashes job queue server counts from 80 instances to 4 instances.
2. **High-Throughput Public API Endpoints**:
   - Moving authentication, payment processing, notification dispatch, and public ingestion endpoints from Rails to Go reduces P99 latency by 90% and protects the backend database from connection exhaustion.
3. **Slashing Container Fleet Costs**:
   - Organizations running hundreds of Rails Kubernetes pods can cut infrastructure spending by 70% by extracting high-traffic services into Go.

---

### 5.3 When Go Is NOT a Good Option (When to Stay with Ruby)

1. **Early-Stage MVPs & Product Prototyping**:
   - Rails remains the fastest framework on earth for building early-stage CRUD products with complex relational models. If product-market fit is not yet proven, the developer velocity of Rails outweighs Go's runtime performance.
2. **Back-Office Admin Panels (ActiveAdmin, Rails Admin)**:
   - Rebuilding internal tooling, dashboards, and CRUD workflows that Rails generates automatically in hours requires weeks of custom Go and frontend coding.
3. **Complex Business Logic Deeply Coupled to Rails Gems**:
   - Gem ecosystems like Devise (authentication) or CanCanCan (permissions) have immense institutional logic built-in. Rewriting mature domain rules from scratch carries high defect risk.

---

### 5.4 Architectural Pattern Comparison: High-Volume Background Processor

#### Ruby (Sidekiq Worker)
```ruby
# Ruby Sidekiq Worker: High object allocation rate per processed job
class EventIngestionWorker
  include Sidekiq::Worker
  sidekiq_options queue: :high_priority, retry: 3

  def perform(event_payload)
    event_data = JSON.parse(event_payload)
    
    # ActiveRecord query allocates multiple intermediate objects
    account = Account.find(event_data['account_id'])
    return unless account.active?

    # Network HTTP call blocks the worker process thread
    response = HTTParty.post(
      "https://analytics.internal/track",
      body: event_data.to_json,
      headers: { 'Content-Type' => 'application/json' },
      timeout: 5
    )

    raise "Tracking failed: #{response.code}" unless response.success?
  end
end
```

#### Go (Concurrent Pipeline with Channel Buffering)
```go
package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Event struct {
	AccountID string         `json:"account_id"`
	Data      map[string]any `json:"data"`
}

type EventProcessor struct {
	client *http.Client
	queue  chan Event
}

func NewEventProcessor(workerCount, queueSize int) *EventProcessor {
	ep := &EventProcessor{
		queue: make(chan Event, queueSize),
		client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        200,
				MaxIdleConnsPerHost: 50,
			},
		},
	}

	for i := 0; i < workerCount; i++ {
		go ep.worker()
	}
	return ep
}

func (ep *EventProcessor) Enqueue(e Event) bool {
	select {
	case ep.queue <- e:
		return true
	default:
		return false // Backpressure: queue full
	}
}

func (ep *EventProcessor) worker() {
	for event := range ep.queue {
		_ = ep.process(event)
	}
}

func (ep *EventProcessor) process(e Event) error {
	payload, _ := json.Marshal(e)
	req, _ := http.NewRequest(http.MethodPost, "https://analytics.internal/track", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")

	resp, err := ep.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("analytics rejected event: %d", resp.StatusCode)
	}
	return nil
}
```

---

### 5.5 Enterprise Strangler Pattern: Extracting Rails Services

1. **Step 1: Carve Out Async Workers First**:
   - Connect Go worker pools directly to Redis/RabbitMQ queues. Let Rails continue handling web forms while Go processes compute-heavy background payloads.
2. **Step 2: Database Table Sharing & Ownership**:
   - Define clear database ownership. Go services should either have dedicated database schemas or communicate with Rails via internal gRPC endpoints rather than querying shared mutable tables.
3. **Step 3: Extract Read-Heavy Public APIs**:
   - Move high-traffic public API endpoints to Go, pointing directly at read-replica databases or Redis caches.
