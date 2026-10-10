## 105C.3 Log Aggregation Pipeline with Fluent Bit

In production, application logs must be shipped to a central aggregation system (Elasticsearch, Loki, Splunk) without blocking the application or losing entries during brief network interruptions. The `LogShipper` below buffers entries in memory and flushes them as compressed Elasticsearch bulk API payloads, either on a configurable interval or immediately when the buffer fills. The `FluentBitForwarder` supplements this by implementing the Fluent protocol's forward mode for environments where Fluent Bit is already deployed as a sidecar.

```go
package logpipeline

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// LogShipper sends logs to a remote aggregation endpoint
type LogShipper struct {
	mu          sync.Mutex
	buffer      []LogEntry
	maxBuffer   int
	flushInterval time.Duration
	endpoint    string
	httpClient  *http.Client
	stopCh      chan struct{}
	metrics     *ShipperMetrics
}

// LogEntry represents a structured log entry
type LogEntry struct {
	Timestamp   time.Time              `json:"@timestamp"`
	Level       string                 `json:"log.level"`
	Message     string                 `json:"message"`
	Service     string                 `json:"service.name"`
	TraceID     string                 `json:"trace.id,omitempty"`
	SpanID      string                 `json:"span.id,omitempty"`
	CorrelationID string               `json:"correlation_id,omitempty"`
	Fields      map[string]any `json:"fields,omitempty"`
}

// ShipperMetrics tracks log shipping metrics
type ShipperMetrics struct {
	mu           sync.RWMutex
	EntriesTotal int64
	BytesTotal   int64
	Errors       int64
	Batches      int64
}

// NewLogShipper creates a new log shipper
func NewLogShipper(endpoint string, maxBuffer int, flushInterval time.Duration) *LogShipper {
	s := &LogShipper{
		buffer:        make([]LogEntry, 0, maxBuffer),
		maxBuffer:     maxBuffer,
		flushInterval: flushInterval,
		endpoint:      endpoint,
		httpClient:    &http.Client{Timeout: 10 * time.Second},
		stopCh:        make(chan struct{}),
		metrics:       &ShipperMetrics{},
	}
	return s
}

// Start begins the background flush loop
func (s *LogShipper) Start() {
	go s.flushLoop()
}

// Stop flushes remaining logs and stops the shipper
func (s *LogShipper) Stop(ctx context.Context) error {
	close(s.stopCh)
	return s.flush(ctx)
}

// Add adds a log entry to the buffer
func (s *LogShipper) Add(entry LogEntry) {
	s.mu.Lock()
	s.buffer = append(s.buffer, entry)
	shouldFlush := len(s.buffer) >= s.maxBuffer
	s.mu.Unlock()

	if shouldFlush {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.flush(ctx)
	}
}

func (s *LogShipper) flushLoop() {
	ticker := time.NewTicker(s.flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			s.flush(ctx)
			cancel()
		case <-s.stopCh:
			return
		}
	}
}

func (s *LogShipper) flush(ctx context.Context) error {
	s.mu.Lock()
	if len(s.buffer) == 0 {
		s.mu.Unlock()
		return nil
	}

	batch := s.buffer
	s.buffer = make([]LogEntry, 0, s.maxBuffer)
	s.mu.Unlock()

	return s.sendBatch(ctx, batch)
}

func (s *LogShipper) sendBatch(ctx context.Context, entries []LogEntry) error {
	// Build Elasticsearch bulk API body
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)

	for _, entry := range entries {
		// Index action
		indexAction := map[string]any{
			"index": map[string]string{
				"_index": fmt.Sprintf("logs-%s", time.Now().Format("2006.01.02")),
			},
		}
		actionBytes, _ := json.Marshal(indexAction)
		gz.Write(actionBytes)
		gz.Write([]byte("\n"))

		// Document
		docBytes, _ := json.Marshal(entry)
		gz.Write(docBytes)
		gz.Write([]byte("\n"))
	}
	gz.Close()

	req, err := http.NewRequestWithContext(ctx,
		http.MethodPost,
		s.endpoint+"/_bulk",
		&buf)
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "application/x-ndjson")
	req.Header.Set("Content-Encoding", "gzip")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.metrics.mu.Lock()
		s.metrics.Errors++
		s.metrics.mu.Unlock()
		return fmt.Errorf("bulk send failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("bulk API error %d: %s", resp.StatusCode, string(body))
	}

	s.metrics.mu.Lock()
	s.metrics.EntriesTotal += int64(len(entries))
	s.metrics.BytesTotal += int64(buf.Len())
	s.metrics.Batches++
	s.metrics.mu.Unlock()

	return nil
}

// FluentBitForwarder implements the Fluent Bit forward protocol
type FluentBitForwarder struct {
	address   string
	conn      net.Conn
	mu        sync.Mutex
	reconnect time.Duration
}

// ForwardRecord sends a record to Fluent Bit
func (f *FluentBitForwarder) ForwardRecord(tag string, record map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.conn == nil {
		if err := f.connect(); err != nil {
			return err
		}
	}

	// MessagePack encoding for Fluent protocol
	// [tag, [[timestamp, record]]]
	// In production: use github.com/fluent/fluent-logger-golang
	msg := []any{
		tag,
		[]any{
			[]any{time.Now().Unix(), record},
		},
	}

	data, err := json.Marshal(msg) // Simplified: use msgpack in production
	if err != nil {
		return err
	}

	_, err = f.conn.Write(data)
	if err != nil {
		f.conn = nil // Force reconnect on next call
		return err
	}

	return nil
}

func (f *FluentBitForwarder) connect() error {
	conn, err := net.Dial("tcp", f.address)
	if err != nil {
		return fmt.Errorf("failed to connect to Fluent Bit: %w", err)
	}
	f.conn = conn
	return nil
}

// LogLevelManager manages dynamic log level changes at runtime
type LogLevelManager struct {
	mu      sync.RWMutex
	levels  map[string]slog.Level
	default_ slog.Level
}

// NewLogLevelManager creates a log level manager
func NewLogLevelManager(defaultLevel slog.Level) *LogLevelManager {
	return &LogLevelManager{
		levels:   make(map[string]slog.Level),
		default_: defaultLevel,
	}
}

// SetLevel changes the log level for a component
func (m *LogLevelManager) SetLevel(component string, level slog.Level) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.levels[component] = level
}

// GetLevel returns the log level for a component
func (m *LogLevelManager) GetLevel(component string) slog.Level {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if level, exists := m.levels[component]; exists {
		return level
	}
	return m.default_
}

// HandleLevelChange HTTP handler for dynamic level changes
func (m *LogLevelManager) HandleLevelChange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Component string `json:"component"`
		Level     string `json:"level"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	var level slog.Level
	switch strings.ToLower(req.Level) {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		http.Error(w, "Invalid level", http.StatusBadRequest)
		return
	}

	m.SetLevel(req.Component, level)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"component": req.Component,
		"level":     req.Level,
		"status":    "updated",
	})
}
```

### Junior → FAANG: Fluent Bit vs. Fluentd vs. Logstash

The log aggregation pipeline choice is a common interview topic. Fluent Bit is the lightweight, low-memory option (suited for DaemonSets on every node). Fluentd is more feature-rich but heavier (suited for centralized aggregation). Logstash (the L in ELK) is the most powerful but most resource-intensive (suited for complex transformation pipelines). In Kubernetes, the standard architecture uses Fluent Bit as a DaemonSet to collect logs from node container runtimes and forward them to Elasticsearch or Loki.

For interviews, be able to explain the DaemonSet pattern: one Fluent Bit pod per node reads container logs from `/var/log/containers/`, enriches them with Kubernetes metadata (pod name, namespace, labels), and forwards them to the backend. This centralized collection means application pods do not need to manage log shipping themselves.

### Senior @ FAANG: Log Pipeline Reliability and Back-Pressure Handling

**Buffering and back-pressure.** When the backend (Elasticsearch) is slow or unavailable, the Fluent Bit DaemonSet buffers logs on disk. Without a disk buffer limit, a slow backend can fill node disk space and cause node failures. An L6 engineer configures a disk buffer limit, a maximum retry duration, and a drop policy for logs that exceed the buffer: "drop oldest logs first" is usually the right policy, because recent logs are more valuable for incident investigation.

**Log ordering vs. log completeness.** Fluent Bit's batching and retry logic can cause out-of-order log delivery. Elasticsearch and Loki handle this differently: Loki accepts out-of-order logs by default in recent versions, Elasticsearch requires careful index configuration. An L6 engineer evaluates whether the log query tool requires ordering guarantees and configures the pipeline accordingly.

**Pipeline cardinality from Kubernetes labels.** Fluent Bit enriches logs with Kubernetes pod labels. A pod with 20 labels adds 20 fields to every log line emitted by that pod. At 100,000 lines per second, this is significant indexing overhead. An L6 engineer configures Fluent Bit to include only approved Kubernetes labels as log fields and drops the rest, using a `record_modifier` filter that maintains an allowlist.

---
