## 45.8 Common Mistakes

### Mistake 1: Not Checking Context Cancellation in Stream Loops

A server-streaming loop that ignores `stream.Context().Done()` will continue sending messages to a client that has already disconnected, wasting CPU and holding the HTTP/2 stream open. Adding a `select` that checks both the cancellation channel and the next item channel ensures the server exits promptly when the client cancels.

```go
// WRONG: Ignores context cancellation
func (s *Server) ListItems(req *pb.ListRequest, stream pb.Service_ListItemsServer) error {
    items := s.getAllItems()

    for _, item := range items {
        // If client disconnects, this keeps running until all items sent
        if err := stream.Send(item); err != nil {
            return err
        }
    }

    return nil
}

// CORRECT: Check context on each iteration
func (s *Server) ListItems(req *pb.ListRequest, stream pb.Service_ListItemsServer) error {
    ctx := stream.Context()
    items := s.getAllItems()

    for _, item := range items {
        // Check for cancellation
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        default:
        }

        if err := stream.Send(item); err != nil {
            return err
        }
    }

    return nil
}

// BETTER: Check context and use batching for large datasets
func (s *Server) ListItems(req *pb.ListRequest, stream pb.Service_ListItemsServer) error {
    ctx := stream.Context()
    cursor := ""
    batchSize := 100

    for {
        // Check context before expensive operation
        if ctx.Err() != nil {
            return status.FromContextError(ctx.Err()).Err()
        }

        items, nextCursor, err := s.store.ListBatch(ctx, cursor, batchSize)
        if err != nil {
            return status.Errorf(codes.Internal, "list failed: %v", err)
        }

        for _, item := range items {
            select {
            case <-ctx.Done():
                return status.FromContextError(ctx.Err()).Err()
            default:
            }

            if err := stream.Send(item); err != nil {
                return err
            }
        }

        if nextCursor == "" || len(items) < batchSize {
            break
        }
        cursor = nextCursor
    }

    return nil
}
```

### Mistake 2: Blocking Send in Bidirectional Streams

In bidirectional streaming, calling `Send` and `Recv` sequentially in the same goroutine creates a deadlock risk: if the server waits for a `Send` to drain while the client is waiting for a `Recv`, both sides block indefinitely. The solution is to run the send loop and receive loop in separate goroutines that communicate via channels.

```go
// WRONG: Send blocks while waiting for Recv
func (s *Server) Chat(stream pb.Chat_ChatServer) error {
    for {
        // This blocks until client sends
        msg, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        // Process and broadcast
        response := s.processMessage(msg)

        // If client is slow to receive, this blocks
        // and we can't receive new messages
        if err := stream.Send(response); err != nil {
            return err
        }
    }
}

// CORRECT: Handle send and receive concurrently
func (s *Server) Chat(stream pb.Chat_ChatServer) error {
    ctx := stream.Context()

    incoming := make(chan *pb.ChatMessage, 10)
    outgoing := make(chan *pb.ChatMessage, 10)
    errs := make(chan error, 2)

    // Receive goroutine
    go func() {
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                close(incoming)
                return
            }
            if err != nil {
                errs <- err
                return
            }

            select {
            case incoming <- msg:
            case <-ctx.Done():
                return
            }
        }
    }()

    // Send goroutine
    go func() {
        for {
            select {
            case msg, ok := <-outgoing:
                if !ok {
                    return
                }
                if err := stream.Send(msg); err != nil {
                    errs <- err
                    return
                }
            case <-ctx.Done():
                return
            }
        }
    }()

    // Process messages
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case err := <-errs:
            return err
        case msg, ok := <-incoming:
            if !ok {
                close(outgoing)
                return nil
            }

            response := s.processMessage(msg)
            select {
            case outgoing <- response:
            case <-ctx.Done():
                return ctx.Err()
            }
        }
    }
}
```

### Mistake 3: Memory Leak with Unbounded Message Buffering

Using an unbounded channel as the internal event buffer means a slow gRPC stream consumer allows the producer to keep appending messages until the process runs out of memory. Replacing the unbounded channel with a fixed-capacity buffered channel and dropping or backpressuring the producer when it is full bounds memory usage at the cost of explicit overflow policy.

```go
// WRONG: Unbounded buffer - memory leak if consumer is slow
func (s *Server) StreamEvents(req *pb.WatchRequest, stream pb.Events_WatchServer) error {
    events := make(chan *pb.Event) // Unbounded!

    go func() {
        for event := range s.eventSource.Subscribe(req.Topic) {
            events <- event // Blocks if channel full, but it's unbuffered
        }
    }()

    for event := range events {
        stream.Send(event)
    }
    return nil
}

// CORRECT: Bounded buffer with drop policy
func (s *Server) StreamEvents(req *pb.WatchRequest, stream pb.Events_WatchServer) error {
    ctx := stream.Context()

    // Bounded buffer
    events := make(chan *pb.Event, 100)
    dropped := atomic.Int64{}

    // Producer with non-blocking send
    unsub := s.eventSource.Subscribe(req.Topic, func(event *pb.Event) {
        select {
        case events <- event:
        default:
            // Buffer full - drop oldest or newest based on policy
            dropped.Add(1)
        }
    })
    defer unsub()

    // Report dropped events periodically
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                if d := dropped.Swap(0); d > 0 {
                    log.Printf("dropped %d events for slow consumer", d)
                }
            }
        }
    }()

    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        case event := <-events:
            if err := stream.Send(event); err != nil {
                return err
            }
        }
    }
}
```

### Mistake 4: Not Handling Partial Failures in Client Streaming

A batch upload that saves all items in a single database call creates an all-or-nothing failure mode: if one item causes a constraint violation, the entire batch fails and the client receives no information about which items were valid. Processing each item individually and tracking per-item results gives the client actionable error details.

```go
// WRONG: All-or-nothing - one failure loses all progress
func (s *Server) BatchUpload(stream pb.Upload_BatchServer) error {
    var items []*pb.Item

    for {
        item, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }
        items = append(items, item)
    }

    // Save all items - if this fails, client has no idea what succeeded
    if err := s.store.SaveAll(items); err != nil {
        return status.Errorf(codes.Internal, "save failed: %v", err)
    }

    return stream.SendAndClose(&pb.BatchResponse{
        SuccessCount: int32(len(items)),
    })
}

// CORRECT: Process incrementally with detailed results
func (s *Server) BatchUpload(stream pb.Upload_BatchServer) error {
    ctx := stream.Context()

    var (
        successCount int32
        failureCount int32
        errors       []*pb.ItemError
        index        int32
    )

    for {
        if ctx.Err() != nil {
            break
        }

        item, err := stream.Recv()
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        // Process each item individually
        if err := s.processItem(ctx, item); err != nil {
            failureCount++
            errors = append(errors, &pb.ItemError{
                Index: index,
                Error: err.Error(),
            })

            // Continue processing - don't fail entire batch
        } else {
            successCount++
        }

        index++
    }

    return stream.SendAndClose(&pb.BatchResponse{
        SuccessCount: successCount,
        FailureCount: failureCount,
        Errors:       errors,
    })
}
```

### Mistake 5: Forgetting to Close Client Streams

In client-streaming RPCs the server waits for `io.EOF` on `Recv` before returning the final response. If the client never calls `CloseSend()`, the server's `Recv` loop blocks forever and the response is never received. `CloseSend()` signals the half-close of the client's send direction, telling the server no more requests are coming.

```go
// WRONG: Forgetting to close send direction
func (c *Client) SendBatch(ctx context.Context, items []*pb.Item) error {
    stream, err := c.client.BatchUpload(ctx)
    if err != nil {
        return err
    }

    for _, item := range items {
        if err := stream.Send(item); err != nil {
            return err
        }
    }

    // WRONG: Never closed the stream!
    // Server keeps waiting for more items forever

    return nil
}

// CORRECT: Always close and receive response
func (c *Client) SendBatch(ctx context.Context, items []*pb.Item) (*pb.BatchResponse, error) {
    stream, err := c.client.BatchUpload(ctx)
    if err != nil {
        return nil, err
    }

    for _, item := range items {
        if err := stream.Send(item); err != nil {
            return nil, fmt.Errorf("send failed: %w", err)
        }
    }

    // CORRECT: Close and receive response
    response, err := stream.CloseAndRecv()
    if err != nil {
        return nil, fmt.Errorf("close failed: %w", err)
    }

    return response, nil
}

// For bidirectional: close send but continue receiving
func (c *Client) Chat(ctx context.Context) error {
    stream, err := c.client.Chat(ctx)
    if err != nil {
        return err
    }

    // Send messages
    go func() {
        for msg := range c.outgoing {
            stream.Send(msg)
        }
        stream.CloseSend() // Signal we're done sending
    }()

    // Keep receiving until server closes
    for {
        msg, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }
        c.handleMessage(msg)
    }
}
```

### Junior -> FAANG: Mistake Recognition in Code Review

Each mistake in this section has a characteristic code smell that makes it recognizable in code review without running the code.

**Mistake 1 smell: a `for range` loop over a pre-loaded slice inside a stream handler.** If you see `for _, item := range allItems { stream.Send(item) }` without a `select { case <-ctx.Done(): ... default: }`, flag it immediately. The fix is always to move the context check inside the loop body.

**Mistake 2 smell: `stream.Recv()` and `stream.Send()` in the same goroutine's main loop with no channel mediation.** In a bidirectional handler, if the only select cases are `ctx.Done()` and the result of a blocking `Recv`, then `Send` is happening inside one of those select cases. Ask: what happens if `Send` blocks? Does it block the `Recv` path? If yes, the code has a latent deadlock.

**Mistake 3 smell: `make(chan *T)` (unbuffered) or `make(chan *T, N)` where N is not bounded relative to a known limit.** Unbounded growth paths include: the channel is written by a fast producer with no backpressure, and the consumer is the `Send` loop which can be slow. The fix requires naming the capacity explicitly and documenting what happens when the channel is full.

**Mistake 5 smell: a client-streaming function that calls `stream.Send` in a loop and then returns without calling `stream.CloseAndRecv()`.** This is mechanical to spot: trace from the function entry to every return path. If any return path does not pass through `CloseAndRecv` or `CloseSend`, the stream is leaked.

Developing this pattern-matching instinct is what separates engineers who catch bugs in review from those who only catch them in production.

### Senior @ FAANG: Systemic Prevention of Streaming Mistakes

The five mistakes in this section are not random. They fall into three categories of systemic failure: missing lifecycle discipline, incorrect concurrency model, and absent resource bounds. Staff engineers address these categories at the platform level, not case by case.

**Lifecycle discipline via linting.** Static analysis tools (go-staticcheck, custom AST analyzers) can detect missing `CloseAndRecv` and missing context-check patterns. Write a custom analyzer that: flags server-streaming handlers where `stream.Context()` is never called, and flags client-streaming handlers where `CloseAndRecv` is not called on all return paths, and flags bidirectional handlers where `stream.Recv` and `stream.Send` share a goroutine. Run these analyzers in CI. The false positive rate is low because the patterns are structurally distinctive.

**Concurrency model via code generation.** Bidirectional streaming goroutine setup is mechanical and error-prone when written by hand. Generate the boilerplate from the proto definition: a `{{.ServiceName}}_{{.MethodName}}Handler` interface with separate `OnSend` and `OnRecv` callbacks, and a generated wrapper that manages the goroutines, channels, and shutdown coordination. Teams implement the interface rather than writing the goroutine machinery themselves. This eliminates Mistakes 2 and (partially) 3 by construction.

**Resource bounds via server interceptors.** Mistake 3 (unbounded buffering) and Mistake 4 (all-or-nothing batch failure) are addressable at the interceptor layer. A stream interceptor that instruments `Send` with a bounded semaphore limits the number of in-flight messages per stream globally, regardless of individual handler behavior. A batch-size interceptor that rejects streams where message count exceeds a configured limit stops runaway producers at the entry point. These interceptors encode policy decisions that should not be scattered across individual handlers.

**Graduated incident response.** When a streaming bug reaches production (goroutine leak, OOM, hung stream), the incident response must include a root cause that maps to one of these systemic categories. A post-mortem that concludes "developer forgot to check context" is incomplete. The complete post-mortem asks: why did CI not catch this (missing test coverage, missing linter rule), why did the issue not surface in load testing (insufficient duration or concurrency), and what platform change prevents the next occurrence (lint rule, code generator, interceptor). Streaming bugs are an engineering process failure, not just a code defect.

---
