## 102H.4 Real-Time Application Architectures

### 4.1 Live Dashboard

A live dashboard must solve two problems simultaneously: delivering a consistent snapshot of the current system state to newly connected clients, and then streaming incremental updates as they occur. The `DashboardService` below holds the latest value for every named metric in memory under a `sync.RWMutex`, so a connecting browser can receive a full state snapshot as a single `snapshot` SSE event before joining the live feed. Metrics are published to an SSE broker by topic (`dashboard:metrics`), letting the server push only changed values rather than re-serializing the entire dashboard on every tick.

```go
package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"time"
)

// MetricUpdate represents a real-time metric update.
type MetricUpdate struct {
	MetricName string      `json:"metric"`
	Value      any `json:"value"`
	Timestamp  int64       `json:"ts"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// DashboardService streams metrics to connected browsers via SSE.
type DashboardService struct {
	broker   *sse.Broker
	mu       sync.RWMutex
	metrics  map[string]MetricUpdate // Latest value per metric.
}

func NewDashboardService(broker *sse.Broker) *DashboardService {
	return &DashboardService{
		broker:  broker,
		metrics: make(map[string]MetricUpdate),
	}
}

// PublishMetric updates a metric and pushes the update to all dashboard subscribers.
func (ds *DashboardService) PublishMetric(name string, value any, labels map[string]string) {
	update := MetricUpdate{
		MetricName: name,
		Value:      value,
		Timestamp:  time.Now().UnixMilli(),
		Labels:     labels,
	}

	ds.mu.Lock()
	ds.metrics[name] = update
	ds.mu.Unlock()

	data, _ := json.Marshal(update)
	event := sse.Event{
		Type: "metric",
		Data: data,
	}
	ds.broker.Publish("dashboard:metrics", event)
}

// GetCurrentMetrics returns all current metric values.
func (ds *DashboardService) GetCurrentMetrics() map[string]MetricUpdate {
	ds.mu.RLock()
	defer ds.mu.RUnlock()
	result := make(map[string]MetricUpdate, len(ds.metrics))
	for k, v := range ds.metrics {
		result[k] = v
	}
	return result
}

// MetricsHandler handles SSE connections and sends current state + live updates.
func (ds *DashboardService) MetricsHandler(broker *sse.Broker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		subID := fmt.Sprintf("dash-%d", time.Now().UnixNano())
		sub := broker.Subscribe(r.Context(), subID, "", []string{"dashboard:metrics"})

		// Send current state before streaming updates.
		current := ds.GetCurrentMetrics()
		initialData, _ := json.Marshal(map[string]any{
			"type":    "snapshot",
			"metrics": current,
		})

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")

		flusher := w.(http.Flusher)

		// Send snapshot.
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", initialData)
		flusher.Flush()

		// Stream updates.
		broker.ServeSSE(sub, w, r)
	}
}

// MetricsCollector collects and pushes system metrics.
type MetricsCollector struct {
	dashboard *DashboardService
	interval  time.Duration
}

func NewMetricsCollector(dashboard *DashboardService, interval time.Duration) *MetricsCollector {
	return &MetricsCollector{dashboard: dashboard, interval: interval}
}

func (mc *MetricsCollector) Run(ctx context.Context) {
	ticker := time.NewTicker(mc.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mc.collect()
		}
	}
}

func (mc *MetricsCollector) collect() {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)

	mc.dashboard.PublishMetric("goroutines", runtime.NumGoroutine(), nil)
	mc.dashboard.PublishMetric("heap_alloc_mb", float64(stats.HeapAlloc)/1024/1024, nil)
	mc.dashboard.PublishMetric("gc_pause_ms", float64(stats.PauseNs[(stats.NumGC+255)%256])/1e6, nil)
}
```

### 4.2 Collaborative Document Editing

Collaborative editing requires that concurrent changes from multiple users converge to the same document state without conflict. The implementation below uses a simplified Operational Transformation (OT) model where each client submits a `Delta`, a sequence of retain, insert, and delete operations, along with the document revision it was based on. The server transforms the incoming delta against any operations committed since that revision before applying it, then broadcasts the transformed delta to all other connected clients.

```go
package collab

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Operation types for operational transformation (OT).
const (
	OpInsert = "insert"
	OpDelete = "delete"
	OpRetain = "retain"
)

// Op represents a single text operation.
type Op struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"` // For insert.
	Count   int    `json:"count,omitempty"`   // For delete/retain.
}

// Delta represents a sequence of operations on a document.
// Borrowed from Quill editor's Delta format.
type Delta struct {
	Ops []Op `json:"ops"`
}

// DocumentChange represents a change submitted by a client.
type DocumentChange struct {
	DocID     string `json:"doc_id"`
	ClientID  string `json:"client_id"`
	Revision  int    `json:"revision"` // Client's base revision.
	Delta     Delta  `json:"delta"`
	Timestamp int64  `json:"ts"`
}

// Document is a collaborative document with version history.
type Document struct {
	mu        sync.RWMutex
	ID        string
	content   []rune
	revision  int
	history   []DocumentChange // History for conflict resolution.
	broadcast func(change DocumentChange) // Callback to broadcast to clients.
}

func NewDocument(id string, broadcast func(DocumentChange)) *Document {
	return &Document{
		ID:        id,
		broadcast: broadcast,
		history:   make([]DocumentChange, 0, 100),
	}
}

// ApplyChange applies a client's change with operational transformation.
// If the client's revision < current revision, OT transforms the change.
func (d *Document) ApplyChange(change DocumentChange) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Transform change if the client is behind.
	if change.Revision < d.revision {
		// Get operations that the client hasn't seen.
		serverOps := d.history[change.Revision:d.revision]
		for _, serverChange := range serverOps {
			change.Delta = transformDelta(change.Delta, serverChange.Delta)
		}
	}

	// Apply the (possibly transformed) delta.
	if err := d.applyDelta(change.Delta); err != nil {
		return err
	}

	d.revision++
	change.Revision = d.revision
	d.history = append(d.history, change)

	// Broadcast to all other clients.
	d.broadcast(change)
	return nil
}

// applyDelta applies a delta to the document content.
func (d *Document) applyDelta(delta Delta) error {
	var newContent []rune
	pos := 0

	for _, op := range delta.Ops {
		switch op.Type {
		case OpRetain:
			if pos+op.Count > len(d.content) {
				return fmt.Errorf("retain out of bounds")
			}
			newContent = append(newContent, d.content[pos:pos+op.Count]...)
			pos += op.Count
		case OpInsert:
			newContent = append(newContent, []rune(op.Content)...)
		case OpDelete:
			if pos+op.Count > len(d.content) {
				return fmt.Errorf("delete out of bounds")
			}
			pos += op.Count // Skip deleted chars.
		}
	}
	newContent = append(newContent, d.content[pos:]...)
	d.content = newContent
	return nil
}

// transformDelta transforms delta against a concurrent server delta using OT.
// This is a simplified implementation - production uses a full OT library.
func transformDelta(client, server Delta) Delta {
	// Simplified: in production, use a full OT transformation algorithm
	// (e.g., ShareDB/json0 or Quill's delta transform).
	return client
}

// GetContent returns the current document content.
func (d *Document) GetContent() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return string(d.content)
}

// GetRevision returns the current revision number.
func (d *Document) GetRevision() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.revision
}

// CollabHandler manages multiple collaborative documents.
type CollabHandler struct {
	mu   sync.RWMutex
	docs map[string]*Document
	hub  *DistributedHub
}

func NewCollabHandler(hub *DistributedHub) *CollabHandler {
	return &CollabHandler{
		docs: make(map[string]*Document),
		hub:  hub,
	}
}

// GetOrCreate returns a document, creating it if necessary.
func (ch *CollabHandler) GetOrCreate(docID string) *Document {
	ch.mu.RLock()
	doc, ok := ch.docs[docID]
	ch.mu.RUnlock()
	if ok {
		return doc
	}

	ch.mu.Lock()
	defer ch.mu.Unlock()

	// Double-check after lock.
	if doc, ok = ch.docs[docID]; ok {
		return doc
	}

	doc = NewDocument(docID, func(change DocumentChange) {
		// Broadcast change to all clients in the document's room.
		data, _ := json.Marshal(change)
		ch.hub.Broadcast("doc:"+docID, Message{
			Type:      "doc_change",
			Room:      "doc:" + docID,
			Payload:   data,
			Timestamp: time.Now().UnixMilli(),
		}, change.ClientID) // Exclude the originating client.
	})
	ch.docs[docID] = doc
	return doc
}

// HandleChange processes a document change from a client.
func (ch *CollabHandler) HandleChange(msg Message) {
	var change DocumentChange
	if err := json.Unmarshal(msg.Payload, &change); err != nil {
		return
	}
	change.ClientID = msg.From

	doc := ch.GetOrCreate(change.DocID)
	if err := doc.ApplyChange(change); err != nil {
		// Send error back to client.
	}
}
```

### Junior → FAANG: Building Real-Time Applications with the Right Data Model

The most important design decision in a real-time application is not the WebSocket implementation, it is the data model for state synchronization. A live dashboard that pushes full snapshots on every update is easy to implement but expensive at scale (large payloads, every connected client receives the full state even if they display only a subset). A dashboard that pushes deltas is efficient but requires the client to maintain and apply state correctly.

The practical starting point for any real-time application: define whether clients need the full state on connect (requires a snapshot on subscribe), how updates are represented (full replace versus delta), and what happens when a client misses updates during a disconnect (snapshot on reconnect, or replay from a buffer). Answering these three questions before writing any code prevents the most common data consistency bugs in real-time systems.

Interview entry point: when asked to design a live dashboard, describe the subscription model (what data does each client subscribe to?), the update model (full snapshot vs. incremental delta), and the reconnection model (how does the client recover state after a disconnect?).

### Senior @ FAANG: State Synchronization Protocols and Convergence Guarantees

At FAANG scale, the "real-time application" problem is a state synchronization problem with specific mathematical properties. For shared mutable state where multiple clients can write concurrently, you need a conflict resolution strategy: last-write-wins (LWW) for simple scalar values, operational transforms (OT) for ordered text, or CRDTs for more complex data structures that require eventual consistency without a central coordinator.

The choice of synchronization protocol determines the backend architecture. LWW requires only a reliable event broadcast mechanism. OT requires a central server that applies a strict ordering to all operations and computes the transform for each client's pending operations relative to the ordered log. CRDTs can be applied without coordination but require careful data structure selection (G-Counter, OR-Set, LWW-Register, RGA for sequences) and understanding of which operations the chosen CRDT supports.

The governance question at L6: which synchronization protocol is used for which data types in your product, who owns that decision, and how is it documented? Using LWW for collaborative text editing (as many naive implementations do) produces incorrect behavior when two users edit the same text concurrently: one edit silently overwrites the other. The product team may not notice until a user complains. Documenting the synchronization contract for each data type, including its consistency guarantees and known failure modes, is a platform engineering responsibility.


---
