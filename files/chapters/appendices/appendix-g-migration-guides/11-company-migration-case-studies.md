## Company Migration Case Studies

### Uber's Python to Go Migration

**From Python Microservices to Go:**

```go
// Uber's migration strategy: Service-by-service with shared libraries
package migration

import (
    "context"
    "sync"
    "time"

    "go.uber.org/zap"
)

// ServiceBridge allows Python and Go services to coexist
type ServiceBridge struct {
    pythonClient  *PythonServiceClient  // gRPC to Python
    goService     Service               // Native Go
    featureFlags  *FeatureFlags
    metrics       *Metrics
    logger        *zap.Logger
}

// MigrationConfig controls gradual rollout
type MigrationConfig struct {
    // Percentage of traffic to route to Go (0-100)
    GoTrafficPercent int

    // Specific users/tenants on Go
    GoUserIDs []string

    // Shadow mode: call both, compare results
    ShadowMode bool

    // Rollback threshold
    ErrorThreshold float64
}

// Route decides which backend to use
func (sb *ServiceBridge) Route(ctx context.Context, req *Request) (*Response, error) {
    config := sb.featureFlags.GetMigrationConfig()

    // Check if user is in Go cohort
    if sb.shouldRouteToGo(req, config) {
        start := time.Now()
        resp, err := sb.goService.Handle(ctx, req)

        // Record metrics for comparison
        sb.metrics.RecordLatency("go", time.Since(start))
        if err != nil {
            sb.metrics.RecordError("go")

            // Check error threshold for automatic rollback
            if sb.metrics.ErrorRate("go") > config.ErrorThreshold {
                sb.logger.Warn("Error threshold exceeded, rolling back",
                    zap.Float64("error_rate", sb.metrics.ErrorRate("go")),
                    zap.Float64("threshold", config.ErrorThreshold),
                )
                sb.featureFlags.SetGoTrafficPercent(0)
            }
        }

        // Shadow mode: also call Python and compare
        if config.ShadowMode && err == nil {
            go sb.shadowCompare(ctx, req, resp)
        }

        return resp, err
    }

    return sb.pythonClient.Handle(ctx, req)
}

func (sb *ServiceBridge) shadowCompare(ctx context.Context, req *Request, goResp *Response) {
    pythonResp, err := sb.pythonClient.Handle(ctx, req)
    if err != nil {
        sb.logger.Warn("Python shadow call failed", zap.Error(err))
        return
    }

    if !responseEquals(goResp, pythonResp) {
        sb.logger.Error("Response mismatch detected",
            zap.Any("go_response", goResp),
            zap.Any("python_response", pythonResp),
        )
        sb.metrics.RecordMismatch()
    }
}

// The documented anchor: Uber's geofence-lookup service rewrite
// (engineering blog, 2016) took p99 latency from hundreds of
// milliseconds in Python to single-digit milliseconds in Go,
// with large CPU and memory reductions. Fleet-wide numbers were
// never published; the per-service wins were what justified the
// service-by-service strategy shown above.
```

### Dropbox's Python to Go Migration

**File Sync Service Migration:**

```go
// Dropbox's approach: Rewrite critical path in Go
package sync

import (
    "context"
    "crypto/sha256"
    "io"
    "sync"
)

// BlockHasher provides high-performance file hashing
// Dropbox migrated this from Python for 4x speedup
type BlockHasher struct {
    blockSize int
    pool      sync.Pool
}

func NewBlockHasher(blockSize int) *BlockHasher {
    return &BlockHasher{
        blockSize: blockSize,
        pool: sync.Pool{
            New: func() any {
                return make([]byte, blockSize)
            },
        },
    }
}

// HashFile computes block-level hashes for delta sync
func (bh *BlockHasher) HashFile(ctx context.Context, r io.Reader) ([]BlockHash, error) {
    var hashes []BlockHash

    buf := bh.pool.Get().([]byte)
    defer bh.pool.Put(buf)

    offset := int64(0)

    for {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        default:
        }

        n, err := io.ReadFull(r, buf)
        if n > 0 {
            hash := sha256.Sum256(buf[:n])
            hashes = append(hashes, BlockHash{
                Offset: offset,
                Size:   int64(n),
                Hash:   hash[:],
            })
            offset += int64(n)
        }

        if err == io.EOF || err == io.ErrUnexpectedEOF {
            break
        }
        if err != nil {
            return nil, err
        }
    }

    return hashes, nil
}

// Dropbox migration stats:
// - Hashing throughput: 150 MB/s (Python) -> 600 MB/s (Go)
// - Memory per connection: 12 MB (Python) -> 1.2 MB (Go)
// - Concurrent connections: 10K (Python) -> 100K (Go)
```

### Twitch's Migration to Go

**Chat Service Migration:**

```go
// Twitch's approach (documented for its chat and video systems,
// which moved to Go from Python and Ruby era stacks): migrate the
// highest-throughput services first
package chat

import (
    "context"
    "sync"
    "time"

    "github.com/gorilla/websocket"
)

// ChatHub manages WebSocket connections
// Twitch migrated from Node.js for better concurrency
type ChatHub struct {
    rooms    sync.Map // roomID -> *Room
    clients  sync.Map // clientID -> *Client
    upgrader websocket.Upgrader
    metrics  *Metrics
}

type Room struct {
    id      string
    clients sync.Map
    msgCh   chan *Message
    done    chan struct{}
}

// BroadcastMessage sends to all room members efficiently
// Node.js struggled with backpressure - Go handles it natively
func (r *Room) BroadcastMessage(ctx context.Context, msg *Message) {
    // Pre-encode message once
    encoded, err := msg.Encode()
    if err != nil {
        return
    }

    r.clients.Range(func(key, value any) bool {
        client := value.(*Client)

        // Non-blocking send with timeout
        select {
        case client.sendCh <- encoded:
            // Sent successfully
        case <-time.After(100 * time.Millisecond):
            // Client too slow, mark for disconnection
            client.MarkSlow()
        case <-ctx.Done():
            return false
        }

        return true
    })
}

// Client represents a WebSocket connection
type Client struct {
    id      string
    conn    *websocket.Conn
    sendCh  chan []byte
    room    *Room
    slow    bool
    mu      sync.RWMutex
}

// WritePump handles outgoing messages
// Go's goroutine per connection scales better than Node.js event loop
func (c *Client) WritePump(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case message, ok := <-c.sendCh:
            if !ok {
                c.conn.WriteMessage(websocket.CloseMessage, []byte{})
                return
            }

            c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
                return
            }

        case <-ticker.C:
            c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }

        case <-ctx.Done():
            return
        }
    }
}

// The shape of the win Twitch has described publicly: an order of
// magnitude more concurrent connections per server, a fraction of
// the per-connection memory, and message latency dropping from tens
// of milliseconds to single digits. Their follow-up GC-tuning posts
// ("Go's march to low-latency GC") document the tail-latency work
// that came after the migration.
```

### A Java to Go Payment-Gateway Migration

**Payment Gateway Migration:**

```go
// The standard enterprise Java-to-Go approach: gradual migration
// with a shared data layer (PayPal, for the record, famously went
// Java to Node.js - the Go pattern below is the same playbook)
package gateway

import (
    "context"
    "time"
)

// TransactionProcessor handles payment transactions
// PayPal migrated from Java Spring for reduced latency
type TransactionProcessor struct {
    validator     *TransactionValidator
    riskEngine    *RiskEngine
    ledger        *Ledger
    notifications *NotificationService
}

// ProcessTransaction handles a payment with Go's simpler concurrency
func (tp *TransactionProcessor) ProcessTransaction(ctx context.Context, tx *Transaction) (*Result, error) {
    // Validate transaction
    if err := tp.validator.Validate(ctx, tx); err != nil {
        return nil, &ValidationError{Err: err}
    }

    // Run risk check concurrently with fraud detection
    riskCh := make(chan *RiskAssessment, 1)
    go func() {
        assessment, _ := tp.riskEngine.Assess(ctx, tx)
        riskCh <- assessment
    }()

    // Reserve funds
    reservation, err := tp.ledger.Reserve(ctx, tx)
    if err != nil {
        return nil, &LedgerError{Err: err}
    }

    // Wait for risk assessment
    risk := <-riskCh
    if risk != nil && risk.Score > 0.8 {
        tp.ledger.Release(ctx, reservation)
        return nil, &RiskError{Score: risk.Score}
    }

    // Commit transaction
    result, err := tp.ledger.Commit(ctx, reservation)
    if err != nil {
        return nil, &LedgerError{Err: err}
    }

    // Send notification asynchronously
    go tp.notifications.SendReceipt(context.Background(), tx, result)

    return result, nil
}

// The typical Java-to-Go comparison teams report on this playbook:
//
// Java Spring Boot:
// - Startup time: tens of seconds
// - Memory footprint: hundreds of MB to GBs per instance
// - Threads per instance: hundreds
//
// Go:
// - Startup time: seconds
// - Memory footprint: tens of MB per instance
// - Goroutines per instance: tens of thousands
//
// The magnitudes are representative of the runtime models, not a
// specific company's published benchmark.
```

### Migration Summary

The documented public record, without invented precision:

| Company | From | To | What they published |
|---------|------|-----|---------------------|
| **Uber** | Python | Go | Geofence service rewrite: p99 from hundreds of ms to single digits |
| **Dropbox** | Python | Go | Performance-critical backends rewritten, ~200K lines of open-sourced Go libraries |
| **Twitch** | Python/Ruby-era stack | Go | Chat and video systems on Go, famous GC-tuning posts followed |
| **Cloudflare** | C/Lua services | Go (and Rust) | Safer services, easier deployment, RRDNS and cloudflared among the results |
| **Docker** | dotCloud's Python PaaS | Go (from day one) | Docker itself was born in Go in 2013 |

The lesson across all of them: the wins come from the migration discipline (strangler pattern, shared data layer, service-by-service cutover with metrics), not from the language change alone.

---
