## gRPC Pitfalls: When RPC Goes Wrong

### The Deadline Propagation Disaster

**The Incident**: A microservices architecture had service A calling B calling C. Service A set a 5-second timeout. A called B at t=0, B processed for 2 seconds, then called C at t=2 with... a fresh 5-second timeout. C took 4 seconds. Total time: 6 seconds. Service A timed out after 5 seconds, but B and C kept processing. The wasted work overloaded downstream services. Nobody propagated deadlines.

```go
// WRONG: Creating fresh context with new deadline
func (s *ServiceB) ProcessOrder(ctx context.Context, req *pb.OrderRequest) (*pb.OrderResponse, error) {
    // Process locally (2 seconds)
    order := s.processLocally(req)

    // Call service C with FRESH timeout - ignores caller's deadline!
    ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // Caller may have already timed out!
    result, err := s.serviceC.Validate(ctx2, &pb.ValidateRequest{...})
    // ...
}

// CORRECT: Propagate incoming deadline
func (s *ServiceB) ProcessOrder(ctx context.Context, req *pb.OrderRequest) (*pb.OrderResponse, error) {
    // Check remaining deadline
    deadline, ok := ctx.Deadline()
    if ok {
        remaining := time.Until(deadline)
        if remaining < 100*time.Millisecond {
            return nil, status.Error(codes.DeadlineExceeded, "insufficient time remaining")
        }
    }

    // Process locally
    order := s.processLocally(req)

    // Use INCOMING context - deadline propagates automatically via gRPC metadata
    result, err := s.serviceC.Validate(ctx, &pb.ValidateRequest{...})
    if err != nil {
        if status.Code(err) == codes.DeadlineExceeded {
            // Log that we ran out of time in downstream call
            log.Warn("deadline exceeded calling service C", "remaining_at_call", time.Until(deadline))
        }
        return nil, err
    }

    return &pb.OrderResponse{...}, nil
}

// If you need to set a maximum for downstream calls:
func (s *ServiceB) ProcessOrderWithMaxDeadline(ctx context.Context, req *pb.OrderRequest) (*pb.OrderResponse, error) {
    // Get incoming deadline
    deadline, hasDeadline := ctx.Deadline()

    // Set maximum downstream timeout
    maxDownstreamTimeout := 3 * time.Second

    var downstreamDeadline time.Time
    if hasDeadline {
        // Use the sooner of: incoming deadline or max downstream timeout
        maxDeadline := time.Now().Add(maxDownstreamTimeout)
        if deadline.Before(maxDeadline) {
            downstreamDeadline = deadline
        } else {
            downstreamDeadline = maxDeadline
        }
    } else {
        downstreamDeadline = time.Now().Add(maxDownstreamTimeout)
    }

    ctx, cancel := context.WithDeadline(ctx, downstreamDeadline)
    defer cancel()

    result, err := s.serviceC.Validate(ctx, &pb.ValidateRequest{...})
    // ...
}
```

### The Stream Leak Catastrophe

**The Incident**: A real-time analytics service used server-streaming gRPC. Clients subscribed to data feeds. When clients disconnected abruptly (network issues, app kill), the server kept trying to send to dead streams. Each leaked stream held a goroutine and connection resources. After 48 hours, the server had 50,000 leaked goroutines and crashed with OOM.

```go
// WRONG: Not handling client disconnection
func (s *AnalyticsServer) StreamMetrics(req *pb.MetricsRequest, stream pb.Analytics_StreamMetricsServer) error {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            metrics := s.getLatestMetrics()
            // If client disconnected, this blocks or errors but we ignore context!
            if err := stream.Send(metrics); err != nil {
                return err // Eventually returns, but...
            }
        }
        // Missing: check stream.Context().Done()!
    }
}

// CORRECT: Monitor stream context
func (s *AnalyticsServer) StreamMetrics(req *pb.MetricsRequest, stream pb.Analytics_StreamMetricsServer) error {
    ctx := stream.Context()

    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            // Client disconnected or deadline exceeded
            log.Info("client disconnected", "reason", ctx.Err())
            return ctx.Err()

        case <-ticker.C:
            metrics := s.getLatestMetrics()

            // Use a timeout for sends to detect slow/dead clients
            sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
            err := sendWithContext(sendCtx, stream, metrics)
            cancel()

            if err != nil {
                if status.Code(err) == codes.Canceled {
                    return nil // Clean disconnect
                }
                return err
            }
        }
    }
}

// Helper for timeout on send
func sendWithContext(ctx context.Context, stream pb.Analytics_StreamMetricsServer, msg *pb.Metrics) error {
    done := make(chan error, 1)
    go func() {
        done <- stream.Send(msg)
    }()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case err := <-done:
        return err
    }
}

// Track active streams for monitoring
type StreamTracker struct {
    activeStreams atomic.Int64
}

func (t *StreamTracker) Wrap(handler func(stream pb.Analytics_StreamMetricsServer) error) func(stream pb.Analytics_StreamMetricsServer) error {
    return func(stream pb.Analytics_StreamMetricsServer) error {
        t.activeStreams.Add(1)
        defer t.activeStreams.Add(-1)
        return handler(stream)
    }
}
```

### The Proto Evolution Breaking Change

**The Incident**: A team renamed a protobuf field from `user_id` to `customer_id` (field number stayed the same: 1). They thought this was safe - same type, same number. But clients using the old generated code couldn't decode the new field name in JSON. Half of mobile apps sent empty requests because `user_id` wasn't in responses anymore. Proto wire format was compatible, but JSON format wasn't.

```protobuf
// v1: Original
message Order {
    int64 user_id = 1;
    string product_id = 2;
}

// v2: "Safe" rename? NO!
message Order {
    int64 customer_id = 1;  // Wire format: OK. JSON format: BREAKING!
    string product_id = 2;
}
```

```proto
// The problem: JSON uses field names, not numbers
// Old client sends: {"user_id": 123, "product_id": "abc"}
// New server expects: {"customer_id": 123, "product_id": "abc"}
// Result: customer_id is 0!

// CORRECT: Keep old field, add new one
// v2: Backward compatible
message Order {
    reserved 1;  // Reserve old field number
    reserved "user_id";  // Reserve old field name

    int64 customer_id = 3;  // NEW field number
    string product_id = 2;

    // Or keep both during migration:
    // int64 user_id = 1 [deprecated = true];
    // int64 customer_id = 3;
}
```

```go
// Server handles both during transition
func (s *OrderServer) CreateOrder(ctx context.Context, req *pb.CreateOrderRequest) (*pb.Order, error) {
    // Support clients using either field
    customerID := req.CustomerId
    if customerID == 0 && req.UserId != 0 {
        customerID = req.UserId // Fallback to deprecated field
        log.Warn("client using deprecated user_id field")
    }

    // ...
}
```

### The Message Size Limit OOM

**The Incident**: A file service allowed uploading files via gRPC. The default max message size is 4MB. A developer increased it to 1GB "to support large files." A malicious user sent a 1GB message. The server tried to buffer it entirely in memory. With 100 concurrent requests, the server needed 100GB of RAM. It crashed, and the attack was trivially cheap.

```go
// WRONG: Massive message size for file uploads
server := grpc.NewServer(
    grpc.MaxRecvMsgSize(1024*1024*1024), // 1GB - asking for trouble!
)

func (s *FileServer) Upload(ctx context.Context, req *pb.UploadRequest) (*pb.UploadResponse, error) {
    // req.FileData is up to 1GB in memory!
    return s.saveFile(req.FileData)
}

// CORRECT: Use streaming for large data
server := grpc.NewServer(
    grpc.MaxRecvMsgSize(4*1024*1024), // Keep default 4MB per message
)

// Stream-based upload
func (s *FileServer) Upload(stream pb.FileService_UploadServer) error {
    var fileHandle *os.File
    var totalSize int64
    const maxFileSize = 1 * 1024 * 1024 * 1024 // 1GB limit

    for {
        chunk, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        // First chunk contains metadata
        if chunk.GetMetadata() != nil {
            if chunk.GetMetadata().Size > maxFileSize {
                return status.Error(codes.InvalidArgument, "file too large")
            }
            fileHandle, err = os.CreateTemp("", "upload-*")
            if err != nil {
                return status.Error(codes.Internal, "failed to create temp file")
            }
            defer fileHandle.Close()
            continue
        }

        // Data chunks
        if fileHandle == nil {
            return status.Error(codes.InvalidArgument, "metadata must come first")
        }

        n, err := fileHandle.Write(chunk.GetData())
        if err != nil {
            return status.Error(codes.Internal, "write failed")
        }

        totalSize += int64(n)
        if totalSize > maxFileSize {
            os.Remove(fileHandle.Name())
            return status.Error(codes.InvalidArgument, "file exceeds size limit")
        }
    }

    return stream.SendAndClose(&pb.UploadResponse{
        FileId: filepath.Base(fileHandle.Name()),
        Size:   totalSize,
    })
}
```

### Quick Reference: gRPC Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Missing deadline propagation | Wasted downstream work | Pass incoming ctx to downstream calls |
| Stream leaks | Goroutine/memory growth | Check ctx.Done() in stream loops |
| Proto field rename | JSON deserialization fails | Reserve old names, use new field numbers |
| Large message sizes | OOM attacks | Use streaming for large data |
| Missing keepalive | Load balancer drops connections | Configure keepalive pings |
| Reflection in prod | Security exposure | Disable reflection in production |
| Unary for streaming data | High latency, memory | Use server/client streaming |
| Ignoring trailer metadata | Missing error details | Read trailers for rich errors |

### Junior → FAANG: Learning from Incident Patterns Before They Happen to You

The four incidents above are real patterns. They happen in production at companies of all sizes. Understanding them before your first job lets you recognize the preconditions before they become pages.

**Deadline propagation disaster.** The key insight is that `context.Background()` in the middle of a call chain creates a deadline orphan. The downstream call's deadline is no longer linked to the upstream caller's deadline. When you see `context.Background()` or `context.TODO()` inside a function that receives a `ctx context.Context` parameter, treat it as a code smell. The correct rule: always propagate the incoming context to downstream calls. The only valid exceptions are background goroutines started at service initialization, not per-request goroutines started inside handlers.

**Stream leak catastrophe.** The missing `<-ctx.Done()` arm in a streaming handler's select loop is the single most common gRPC bug in production. Memorize the correct loop structure: always have two cases in the select, the work case and the `ctx.Done()` case. The simplest way to verify this is to search your streaming handlers for the string `ctx.Done()`. If it is not there, the handler will leak.

**Proto evolution breaking change.** The renaming incident (field name change that is wire-compatible but JSON-breaking) is subtle enough to fool experienced engineers. Before approving any proto PR, ask: "Is this service ever serialized to JSON or accessed via gRPC-Gateway?" If yes, field names are part of the contract. Run `buf lint` with JSON-related rules enabled.

**Message size OOM.** Any time you see a gRPC handler that accepts a unary request containing bytes or a large collection, ask whether this should be a streaming RPC instead. The safe default for unary RPCs is the 4 MB default limit. Increasing it should require an explicit justification and a streaming alternative evaluation.

### Senior @ FAANG: Systematic Incident Prevention and Post-Incident Architecture

**Deadline propagation at the fleet level.** Individual developers forgetting to propagate deadlines is an organizational problem, not a code quality problem. The solution is an interceptor that detects and alerts on deadline orphans. A server-side interceptor that checks whether the incoming context has a deadline and emits a metric (`grpc_missing_deadline_total{method="..."}`) when it does not provides the signal you need to find and fix all the omissions across the fleet. This metric, alerting at a low rate threshold, creates an automated sweep that catches the pattern before it causes an incident.

**Stream lifetime governance.** The stream-leak incident points to a gap in operational tooling. Your gRPC server should expose a metric (`grpc_active_streams_total{method="..."}`) that your monitoring team can alert on. A server streaming RPC that accumulates connections over days without declining is almost certainly leaking. Setting an alert on `rate(grpc_active_streams_total[1h]) > 0` with no corresponding increase in traffic is a canary for this class of bug. Additionally, configure `MaxConnectionAge` on the server so that even a leaked stream is eventually terminated by the server's connection lifetime policy.

**Proto governance and the "wire-safe is not JSON-safe" gap.** This gap is architectural: if your system uses gRPC for service-to-service communication but also serializes proto messages to JSON for storage, caching, or event streaming (Kafka topics, DynamoDB JSON columns), you have effectively two wire formats with different compatibility rules. Document this in your proto style guide and enforce both wire and JSON compatibility checks in CI. A field rename that passes `buf breaking` (wire-compatible) must also pass a JSON-format breaking check. `buf` v2 supports `WIRE_JSON` as a breaking change policy that enforces both simultaneously.

**Message size and the defense-in-depth security posture.** The OOM incident is an availability attack enabled by a misconfigured server. The correct posture is defense-in-depth: (1) per-message size limit via `grpc.MaxRecvMsgSize`, set to the minimum needed for the service's legitimate use cases, and (2) per-connection rate limiting via an interceptor that tracks bytes received per connection and closes connections that exceed a threshold. (3) streaming design for any data that could legitimately be large, so the size limit is never the right mitigation. Document the max message size for each service in the proto file as a comment, and write a test that sends a message exceeding the limit and asserts the server returns `codes.ResourceExhausted`, not an OOM crash.

---
