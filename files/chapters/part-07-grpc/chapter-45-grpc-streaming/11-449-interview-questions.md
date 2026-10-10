## 45.9 Interview Questions

### Question 1: When would you choose streaming over unary RPCs?

**Answer:**

```go
/*
STREAMING vs UNARY DECISION FACTORS

Use STREAMING when:

1. Large Data Transfer
   - Data too large for single message (gRPC default limit: 4MB)
   - Want to process data incrementally
   - Memory efficiency is important

2. Real-Time Updates
   - Client needs updates as they happen
   - Server push notifications
   - Live feeds, monitoring, dashboards

3. Long-Running Operations
   - Progress reporting
   - Incremental results
   - Connection keeps operation alive

4. Batching/Aggregation
   - Client sends many items for single operation
   - File uploads in chunks
   - Metrics collection

Use UNARY when:

1. Simple Request/Response
   - CRUD operations
   - Small, bounded data
   - Quick operations

2. Stateless Operations
   - No need to maintain connection
   - Each request is independent

3. Simpler Error Handling
   - Single point of failure
   - Easier to retry

4. Caching Possible
   - Response can be cached
   - Idempotent operations
*/

// Example: Large query - USE STREAMING
func (s *Server) LargeQuery(req *pb.QueryRequest) (*pb.QueryResponse, error) {
    // WRONG: Could return millions of rows
    rows, _ := s.db.Query(req.Query)
    return &pb.QueryResponse{Rows: rows}, nil
}

func (s *Server) LargeQueryStream(req *pb.QueryRequest, stream pb.Service_LargeQueryServer) error {
    // CORRECT: Stream rows as they're read
    rows, _ := s.db.Query(req.Query)
    defer rows.Close()

    for rows.Next() {
        var row pb.Row
        rows.Scan(&row)

        if err := stream.Send(&row); err != nil {
            return err
        }
    }
    return nil
}

// Example: Simple lookup - USE UNARY
func (s *Server) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.User, error) {
    // CORRECT: Simple, bounded response
    return s.store.GetUser(ctx, req.Id)
}
```

**What FAANG expects:** Distinguish unary vs streaming by payload shape and lifetime, not size alone. Senior candidates mention HTTP/2 stream multiplexing cost (cheap stream creation, expensive unary fan-out over thousands of concurrent calls), head-of-line blocking avoidance, and note that unary is idempotent-friendly and cacheable whereas streams are stateful and bound to a single connection.

**Follow-ups:**
- How would unary with pagination compare to server streaming for a 10 million-row export in terms of latency, memory, and failure recovery?
- If the server keeps 100k long-lived streams open, what becomes the scaling bottleneck, and how do you mitigate it (connection sharding, subsetting, L7 proxy)?
- When would you prefer server-sent events or WebSockets over gRPC streaming for the same shape of traffic?

### Question 2: How do you handle backpressure in gRPC streaming?

**Answer:**

```go
/*
BACKPRESSURE STRATEGIES

1. HTTP/2 Flow Control (Automatic)
   - gRPC/HTTP/2 has built-in flow control
   - Send() blocks when receiver window is full
   - 64KB default window size

2. Application-Level Buffering
   - Use bounded channels
   - Drop or reject when buffer full

3. Rate Limiting
   - Limit send rate
   - Token bucket algorithm

4. Consumer Pull Model
   - Client requests more data when ready
   - Pagination with streaming
*/

// Strategy 1: Bounded channel with drop policy
type BackpressuredStream struct {
    buffer  chan *pb.Item
    dropped atomic.Int64
}

func NewBackpressuredStream(bufferSize int) *BackpressuredStream {
    return &BackpressuredStream{
        buffer: make(chan *pb.Item, bufferSize),
    }
}

func (s *BackpressuredStream) Send(item *pb.Item) {
    select {
    case s.buffer <- item:
        // Sent successfully
    default:
        // Buffer full - drop
        s.dropped.Add(1)
    }
}

// Strategy 2: Rate-limited sending
func (s *Server) RateLimitedStream(req *pb.Request, stream pb.Service_StreamServer) error {
    // 100 messages per second
    limiter := rate.NewLimiter(100, 10)

    for item := range s.items {
        if err := limiter.Wait(stream.Context()); err != nil {
            return err
        }

        if err := stream.Send(item); err != nil {
            return err
        }
    }
    return nil
}

// Strategy 3: Pull-based pagination
func (s *Server) PagedStream(stream pb.Service_PagedStreamServer) error {
    for {
        // Wait for client to request more
        req, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        // Send requested batch
        items := s.getItems(req.Cursor, req.Limit)
        for _, item := range items {
            if err := stream.Send(item); err != nil {
                return err
            }
        }
    }
}
```

**What FAANG expects:** A layered answer. HTTP/2 flow control (64 KB default window, `SETTINGS_INITIAL_WINDOW_SIZE`, tunable via `grpc.InitialWindowSize`) handles transport-level backpressure automatically. On top of that, the application layer uses bounded channels between producer and `Send`, rate limiters for fairness, and explicit pull-based protocols for consumer-driven pacing. Weak answers only say "use a buffered channel" without naming the HTTP/2 mechanism or explaining why an unbounded slice on the receive side defeats it.

**Follow-ups:**
- Explain how raising `InitialWindowSize` to 1 MB improves throughput on a cross-region stream and what it costs in memory per stream.
- A fast producer writes to a buffered channel that a slow `Send` drains. What happens at steady state if the channel is unbounded vs bounded?
- How does BDP-based dynamic flow control in grpc-go interact with a manually set window, and which option turns the estimator off (`grpc.WithInitialWindowSize`)?

### Question 3: How do you implement resumable streaming?

**Answer:**

```proto
// Resumable stream protocol
message StreamRequest {
    string stream_id = 1;     // Unique stream identifier
    int64 last_sequence = 2;  // Last received sequence (0 for new stream)
    int64 checkpoint = 3;     // Last checkpoint acknowledged
}

message StreamItem {
    int64 sequence = 1;       // Monotonically increasing
    bytes data = 2;
    bool is_checkpoint = 3;   // Client should persist this sequence
}
```

```go
// Server implementation
func (s *Server) ResumableStream(req *pb.StreamRequest, stream pb.Service_ResumableStreamServer) error {
    ctx := stream.Context()

    // Get or create stream state
    state := s.getStreamState(req.StreamId)
    if state == nil {
        state = s.createStreamState(req.StreamId)
    }

    // Resume from last sequence
    startSeq := req.LastSequence
    if startSeq > 0 {
        // Validate sequence is still available
        if !state.HasSequence(startSeq) {
            return status.Errorf(codes.FailedPrecondition,
                "sequence %d no longer available, earliest: %d",
                startSeq, state.EarliestSequence())
        }
    }

    // Stream from resume point
    for item := range state.ItemsFrom(startSeq) {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
        }

        protoItem := &pb.StreamItem{
            Sequence:     item.Sequence,
            Data:         item.Data,
            IsCheckpoint: item.Sequence%1000 == 0, // Checkpoint every 1000
        }

        if err := stream.Send(protoItem); err != nil {
            return err
        }
    }

    return nil
}

// Client with resume capability
type ResumableClient struct {
    client      pb.ServiceClient
    streamID    string
    lastSeq     atomic.Int64
    persistence Storage
}

func (c *ResumableClient) Stream(ctx context.Context, handler func(*pb.StreamItem) error) error {
    // Load last persisted sequence
    lastSeq := c.persistence.GetLastSequence(c.streamID)
    c.lastSeq.Store(lastSeq)

    for {
        err := c.streamOnce(ctx, handler)
        if err == nil {
            return nil // Stream completed normally
        }

        // Check if error is retryable
        if !isRetryable(err) {
            return err
        }

        // Wait before retry
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(time.Second):
        }
    }
}

func (c *ResumableClient) streamOnce(ctx context.Context, handler func(*pb.StreamItem) error) error {
    stream, err := c.client.ResumableStream(ctx, &pb.StreamRequest{
        StreamId:     c.streamID,
        LastSequence: c.lastSeq.Load(),
    })
    if err != nil {
        return err
    }

    for {
        item, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        if err := handler(item); err != nil {
            return err
        }

        c.lastSeq.Store(item.Sequence)

        // Persist at checkpoints
        if item.IsCheckpoint {
            c.persistence.SetLastSequence(c.streamID, item.Sequence)
        }
    }
}
```

**What FAANG expects:** Monotonic sequence numbers, idempotent message application on the client, and a server-side retention window with an explicit `FailedPrecondition` when the requested cursor has aged out. Strong candidates discuss the trade-off between retaining every message (bounded by log rotation) vs checkpointing (smaller state, possible replay of a bounded batch on resume). Bonus for mentioning that gRPC streams themselves are not resumable. You rebuild state with a new stream after reconnect.

**Follow-ups:**
- How do you keep server memory bounded when thousands of clients may resume from arbitrary sequences?
- If message processing is not idempotent, how do you adapt the protocol (exactly-once via de-dup cache keyed on sequence, or two-phase ack)?
- How does this compare with Kafka consumer offsets, and when would you use Kafka instead of a custom resumable gRPC stream?

### Junior -> FAANG: Interview Preparation for Streaming Questions

The three questions in this section cover the entire topic space for L3-L4 streaming interviews. Practice answering each in under three minutes with a whiteboard sketch, then extend to the follow-ups.

**For Question 1 (streaming vs unary):** The answer framework is: first identify the data shape (bounded vs unbounded, producer-driven vs consumer-driven), then identify the latency requirement (real-time vs batch), then identify the failure model (all-or-nothing vs partial success). Apply these three lenses to the scenario the interviewer describes. Avoid saying "I would use streaming because the data is large." Size is a heuristic, not a rule.

**For Question 2 (backpressure):** Draw the three-layer diagram: HTTP/2 flow control window at the bottom, application-level bounded channel in the middle, rate limiter at the top. Explain that HTTP/2 handles producer-to-consumer backpressure automatically if the consumer does not read ahead into memory. The application layer adds policy (drop vs block vs reject) on top. The rate limiter adds fairness across multiple concurrent producers.

**For Question 3 (resumable streaming):** The four components to memorize: (1) monotonic sequence numbers on every message, (2) client persists the last processed sequence, (3) server retains a window of recent messages, (4) `FailedPrecondition` when the requested sequence is outside the retention window. Draw the reconnect flow: client reconnects, sends `last_sequence`, server validates against retention, server starts streaming from that sequence. This is the same pattern as Kafka consumer offsets, which is a useful analogy to mention.

Practice the follow-ups until the answers are automatic. Interviewers at FAANG use follow-ups to probe depth. A candidate who answers the main question well but stumbles on the first follow-up is assessed as a mid-level candidate. A candidate who handles all follow-ups fluently is assessed as senior-ready.

### Senior @ FAANG: Bar-Raiser Framing for Streaming Interviews

These three questions, asked at the staff or principal level, have different expected answer depths.

**Question 1 at staff level.** The interviewer is not checking whether you know the three patterns. They are checking whether you can reason about the system-level consequences of the choice. Strong staff-level answers include: connection topology and load balancing implications (L4 vs L7, drain on deploy), observability contract (what metrics does each pattern produce and how do they integrate with SLO dashboards), and API versioning policy (streaming RPCs are harder to version than unary because clients may be mid-stream when a change is deployed). A weak staff-level answer describes the patterns correctly but stops at the application code level.

**Question 2 at staff level.** The interviewer is probing whether you understand that backpressure is a system property, not an application feature. Strong answers describe: the interaction between HTTP/2 BDP estimation and manual window size configuration, the failure mode when client-side buffering defeats transport backpressure (unbounded slice accumulation), the platform-level enforcement of backpressure policy via interceptors rather than per-handler code, and the capacity planning model (producer rate times acceptable lag equals required buffer size). A weak staff-level answer describes bounded channels correctly but does not connect to HTTP/2 mechanics or platform enforcement.

**Question 3 at staff level.** The interviewer is probing whether you understand the distributed systems tradeoffs of resumable streaming. Strong answers include: the comparison between gRPC resumable streams and Kafka consumer offsets (Kafka has durable log compaction with configurable retention, gRPC resumable streams have in-memory or Redis-backed retention with finite retention windows. Use Kafka when retention requirements exceed what a gRPC server can maintain economically), the exactly-once delivery challenge (sequence numbers give at-least-once, while exactly-once requires a de-duplication cache keyed on sequence, with expiry tied to the retention window), and the operational cost of maintaining session state across server restarts (Redis, Bigtable, or Spanner as the session store, with TTL-based expiry for abandoned sessions). A weak staff-level answer describes the protocol correctly but does not reason about the distributed storage backing or the cost model.

---
