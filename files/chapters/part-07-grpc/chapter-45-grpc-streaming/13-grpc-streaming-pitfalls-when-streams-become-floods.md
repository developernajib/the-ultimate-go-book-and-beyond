## 45.11 gRPC Streaming Pitfalls: When Streams Become Floods

### Pitfall 1: The Unbounded Stream Memory Explosion

**Incident Report**: A video processing service offered server-streaming for frame analysis results. During a long video analysis, the client couldn't keep up with the server's send rate. Within 8 minutes, the server's memory grew from 2GB to 32GB before OOM killed it. The gRPC internal buffers had accumulated 300,000 unsent messages.

```go
// WRONG: No awareness of client consumption rate
func (s *VideoServer) AnalyzeFrames(req *pb.VideoRequest, stream pb.VideoService_AnalyzeFramesServer) error {
    video, _ := s.loadVideo(req.VideoId)

    for frameNum := 0; frameNum < video.FrameCount; frameNum++ {
        result := s.analyzeFrame(video, frameNum)

        // Sends as fast as CPU can process - client may be overwhelmed
        if err := stream.Send(result); err != nil {
            return err
        }
    }
    return nil
}

// CORRECT: Application-level flow control with backpressure
func (s *VideoServer) AnalyzeFrames(req *pb.VideoRequest, stream pb.VideoService_AnalyzeFramesServer) error {
    video, _ := s.loadVideo(req.VideoId)

    // Semaphore for max outstanding messages
    outstanding := make(chan struct{}, 100)

    // Progress acknowledgment handler
    ackCh := make(chan int64, 100)
    go func() {
        for {
            select {
            case <-stream.Context().Done():
                return
            case <-ackCh:
                select {
                case <-outstanding:
                default:
                }
            }
        }
    }()

    for frameNum := 0; frameNum < video.FrameCount; frameNum++ {
        // Check context before expensive work
        select {
        case <-stream.Context().Done():
            return stream.Context().Err()
        default:
        }

        // Backpressure: block if too many outstanding
        select {
        case outstanding <- struct{}{}:
        case <-stream.Context().Done():
            return stream.Context().Err()
        case <-time.After(30 * time.Second):
            return status.Error(codes.DeadlineExceeded, "client not consuming messages")
        }

        result := s.analyzeFrame(video, frameNum)
        result.FrameNumber = int64(frameNum)

        if err := stream.Send(result); err != nil {
            return err
        }
    }
    return nil
}
```

### Pitfall 2: The Half-Closed Stream Deadlock

**Incident Report**: A bidirectional chat service hung under load. Investigation revealed clients were calling `CloseSend()` to indicate they were done typing, but the server's receive loop exited prematurely, leaving the send loop orphaned. Messages queued for delivery were never sent.

```go
// WRONG: CloseSend terminates the server receive loop, orphaning sends
func (s *ChatServer) Chat(stream pb.ChatService_ChatServer) error {
    // This receive loop exits when client calls CloseSend()
    for {
        msg, err := stream.Recv()
        if err == io.EOF {
            // Client closed their send side - but we still need to send!
            return nil  // BUG: Orphans pending sends
        }
        if err != nil {
            return err
        }

        s.broadcast(msg)  // Other clients' sends may still be pending
    }
}

// CORRECT: Separate receive/send goroutines with coordinated shutdown
func (s *ChatServer) Chat(stream pb.ChatService_ChatServer) error {
    ctx := stream.Context()
    userID := getUserID(ctx)

    // Create user's message channel
    userCh := make(chan *pb.ChatMessage, 100)
    s.registerUser(userID, userCh)
    defer s.unregisterUser(userID)

    errCh := make(chan error, 2)

    // Receive goroutine - handles client messages
    go func() {
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                // Client done sending, but we continue sending to them
                errCh <- nil
                return
            }
            if err != nil {
                errCh <- err
                return
            }
            s.broadcast(userID, msg)
        }
    }()

    // Send goroutine - sends messages to this client
    go func() {
        for {
            select {
            case <-ctx.Done():
                errCh <- ctx.Err()
                return
            case msg := <-userCh:
                if err := stream.Send(msg); err != nil {
                    errCh <- err
                    return
                }
            }
        }
    }()

    // Wait for either goroutine to signal completion
    // Don't exit until context is done (client disconnect)
    var recvDone bool
    for {
        select {
        case err := <-errCh:
            if err != nil {
                return err
            }
            recvDone = true
        case <-ctx.Done():
            return nil  // Clean exit when client disconnects
        }

        if recvDone {
            // Continue sending until context canceled
            select {
            case <-ctx.Done():
                return nil
            }
        }
    }
}
```

### Pitfall 3: The Stream Leak on Context Cancellation

**Incident Report**: A metrics streaming service had goroutine counts climbing by 500/hour. Despite proper context cancellation, streams weren't being cleaned up. The root cause: goroutines blocked on channel sends that would never be received.

```go
// WRONG: Goroutine blocked forever on channel send
func (s *MetricsServer) StreamMetrics(req *pb.MetricsRequest, stream pb.MetricsService_StreamMetricsServer) error {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    metricsCh := make(chan *pb.Metric)

    // This goroutine leaks if nothing receives from metricsCh
    go func() {
        for range ticker.C {
            metric := s.collectMetric(req.MetricName)
            metricsCh <- metric  // Blocks forever if main goroutine exits
        }
    }()

    for {
        select {
        case <-stream.Context().Done():
            return nil  // Exits, but collector goroutine is leaked
        case m := <-metricsCh:
            if err := stream.Send(m); err != nil {
                return err
            }
        }
    }
}

// CORRECT: All goroutines respect context cancellation
func (s *MetricsServer) StreamMetrics(req *pb.MetricsRequest, stream pb.MetricsService_StreamMetricsServer) error {
    ctx := stream.Context()
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return status.FromContextError(ctx.Err()).Err()
        case <-ticker.C:
            metric := s.collectMetric(req.MetricName)
            if err := stream.Send(metric); err != nil {
                return err
            }
        }
    }
}

// CORRECT: If goroutines needed, use proper synchronization
func (s *MetricsServer) StreamMetricsAsync(req *pb.MetricsRequest, stream pb.MetricsService_StreamMetricsServer) error {
    ctx := stream.Context()

    metricsCh := make(chan *pb.Metric, 10)
    errCh := make(chan error, 1)

    // Collector goroutine with context awareness
    go func() {
        ticker := time.NewTicker(time.Second)
        defer ticker.Stop()
        defer close(metricsCh)

        for {
            select {
            case <-ctx.Done():
                return  // Clean exit
            case <-ticker.C:
                metric := s.collectMetric(req.MetricName)
                select {
                case metricsCh <- metric:
                case <-ctx.Done():
                    return  // Clean exit
                }
            }
        }
    }()

    for metric := range metricsCh {
        if err := stream.Send(metric); err != nil {
            return err
        }
    }

    return status.FromContextError(ctx.Err()).Err()
}
```

### Pitfall 4: The Streaming Retry Catastrophe

**Incident Report**: A file upload service using client streaming had no resume capability. When a 10GB upload failed at 95% due to network blip, the client had to restart from scratch. Users on slow connections couldn't upload large files.

```go
// WRONG: No resume capability - all-or-nothing uploads
func (c *UploadClient) UploadFile(ctx context.Context, filePath string) error {
    file, _ := os.Open(filePath)
    defer file.Close()

    stream, err := c.client.UploadFile(ctx)
    if err != nil {
        return err
    }

    buf := make([]byte, 64*1024)
    for {
        n, err := file.Read(buf)
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        // If this fails at 95%, we lose everything
        if err := stream.Send(&pb.FileChunk{Data: buf[:n]}); err != nil {
            return err  // Have to start over
        }
    }

    _, err = stream.CloseAndRecv()
    return err
}

// CORRECT: Resumable uploads with chunk acknowledgment
type ResumableUploader struct {
    client    pb.FileServiceClient
    chunkSize int64
}

func (u *ResumableUploader) UploadFile(ctx context.Context, filePath string) error {
    file, _ := os.Open(filePath)
    defer file.Close()

    fileInfo, _ := file.Stat()
    uploadID := generateUploadID(filePath, fileInfo.Size())

    // Check for existing partial upload
    resumeResp, err := u.client.GetUploadStatus(ctx, &pb.UploadStatusRequest{
        UploadId: uploadID,
    })

    var offset int64
    if err == nil && resumeResp.BytesReceived > 0 {
        offset = resumeResp.BytesReceived
        file.Seek(offset, io.SeekStart)
        log.Printf("Resuming upload from byte %d", offset)
    }

    stream, err := u.client.UploadFile(ctx)
    if err != nil {
        return err
    }

    // Send metadata first
    stream.Send(&pb.FileChunk{
        Metadata: &pb.ChunkMetadata{
            UploadId:   uploadID,
            FileName:   fileInfo.Name(),
            TotalSize:  fileInfo.Size(),
            ChunkStart: offset,
        },
    })

    buf := make([]byte, u.chunkSize)
    chunkNum := offset / u.chunkSize

    for {
        n, err := file.Read(buf)
        if err == io.EOF {
            break
        }
        if err != nil {
            return err
        }

        chunk := &pb.FileChunk{
            Data:       buf[:n],
            ChunkIndex: chunkNum,
            Offset:     offset,
        }

        // Retry individual chunk sends
        if err := u.sendWithRetry(ctx, stream, chunk); err != nil {
            // Save progress for resume
            u.saveProgress(uploadID, offset)
            return fmt.Errorf("upload failed at offset %d: %w", offset, err)
        }

        offset += int64(n)
        chunkNum++
    }

    resp, err := stream.CloseAndRecv()
    if err != nil {
        return err
    }

    log.Printf("Upload complete: %s", resp.FileId)
    return nil
}

func (u *ResumableUploader) sendWithRetry(ctx context.Context, stream pb.FileService_UploadFileClient, chunk *pb.FileChunk) error {
    var lastErr error
    for attempt := 0; attempt < 3; attempt++ {
        if err := stream.Send(chunk); err != nil {
            lastErr = err
            if isRetryable(err) {
                time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
                continue
            }
            return err
        }
        return nil
    }
    return lastErr
}
```

### Pitfall 5: The Bidirectional Message Ordering Assumption

**Incident Report**: A collaborative document editor assumed send/receive order was correlated in bidirectional streams. When two users edited simultaneously, operations were applied out of order, corrupting documents. The team didn't realize request/response streams are independent.

```go
// WRONG: Assuming correlated ordering between send/receive
func (c *CollabClient) EditDocument(ctx context.Context) error {
    stream, _ := c.client.Collaborate(ctx)

    // Bad: Assuming each send gets immediate response in order
    for _, op := range c.pendingOps {
        stream.Send(&pb.Operation{Op: op})

        // Wrong: This response may be for a different operation!
        resp, _ := stream.Recv()
        c.applyResponse(op, resp)  // Incorrect correlation
    }
    return nil
}

// CORRECT: Explicit operation IDs for correlation
type CollaborationClient struct {
    client     pb.CollaborationServiceClient
    pending    sync.Map  // opID -> response channel
    opCounter  atomic.Int64
}

func (c *CollaborationClient) EditDocument(ctx context.Context) error {
    stream, err := c.client.Collaborate(ctx)
    if err != nil {
        return err
    }

    errCh := make(chan error, 2)

    // Sender goroutine
    go func() {
        for {
            select {
            case <-ctx.Done():
                stream.CloseSend()
                return
            case op := <-c.outgoingOps:
                opID := c.opCounter.Add(1)

                // Register pending operation
                respCh := make(chan *pb.OperationResponse, 1)
                c.pending.Store(opID, respCh)

                err := stream.Send(&pb.Operation{
                    OperationId: opID,
                    Op:          op,
                })
                if err != nil {
                    errCh <- err
                    return
                }
            }
        }
    }()

    // Receiver goroutine - correlates responses by ID
    go func() {
        for {
            resp, err := stream.Recv()
            if err == io.EOF {
                errCh <- nil
                return
            }
            if err != nil {
                errCh <- err
                return
            }

            // Correlate response to pending operation
            if ch, ok := c.pending.LoadAndDelete(resp.OperationId); ok {
                ch.(chan *pb.OperationResponse) <- resp
            }

            // Handle remote operations from other users
            if resp.RemoteOp != nil {
                c.applyRemoteOperation(resp.RemoteOp)
            }
        }
    }()

    return <-errCh
}
```

### Pitfall 6: The Keep-Alive vs Application Heartbeat Confusion

**Incident Report**: A team relied on gRPC's HTTP/2 keep-alives for connection health. When a load balancer silently dropped idle connections (despite keep-alives passing), streams failed after 10 minutes of low activity. They confused transport-level keep-alives with application-level liveness.

```go
// WRONG: Relying solely on transport keep-alives
func main() {
    conn, _ := grpc.NewClient(
        "server:50051",
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,  // Transport-level
            Timeout:             3 * time.Second,
            PermitWithoutStream: true,
        }),
    )
    // This doesn't detect application-level hangs or LB drops
}

// CORRECT: Application-level heartbeat for long-lived streams
type HeartbeatStream struct {
    stream         pb.Service_StreamClient
    lastActivity   time.Time
    heartbeatMu    sync.Mutex
}

func (h *HeartbeatStream) Run(ctx context.Context) error {
    errCh := make(chan error, 3)

    // Application-level heartbeat sender
    go func() {
        ticker := time.NewTicker(15 * time.Second)
        defer ticker.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                h.heartbeatMu.Lock()
                idle := time.Since(h.lastActivity)
                h.heartbeatMu.Unlock()

                if idle > 10*time.Second {
                    // Send application heartbeat
                    err := h.stream.Send(&pb.Message{
                        Type: pb.MessageType_HEARTBEAT,
                    })
                    if err != nil {
                        errCh <- fmt.Errorf("heartbeat failed: %w", err)
                        return
                    }
                }
            }
        }
    }()

    // Heartbeat response monitor
    go func() {
        timeout := time.NewTimer(30 * time.Second)
        defer timeout.Stop()

        for {
            select {
            case <-ctx.Done():
                return
            case <-timeout.C:
                h.heartbeatMu.Lock()
                idle := time.Since(h.lastActivity)
                h.heartbeatMu.Unlock()

                if idle > 30*time.Second {
                    errCh <- fmt.Errorf("stream appears dead: no activity for %v", idle)
                    return
                }
                timeout.Reset(30 * time.Second)
            }
        }
    }()

    // Main receive loop
    go func() {
        for {
            msg, err := h.stream.Recv()
            if err != nil {
                errCh <- err
                return
            }

            h.heartbeatMu.Lock()
            h.lastActivity = time.Now()
            h.heartbeatMu.Unlock()

            if msg.Type != pb.MessageType_HEARTBEAT {
                h.handleMessage(msg)
            }
        }
    }()

    return <-errCh
}
```

### Quick Reference: Streaming Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Unbounded buffer growth | OOM on server | Application-level flow control, backpressure |
| Half-closed deadlock | Hung connections | Separate send/receive goroutines, proper coordination |
| Stream goroutine leak | Rising goroutine count | Always check context in selects |
| No resume capability | Failed large transfers | Chunked uploads with offset tracking |
| Ordering assumption | Data corruption | Explicit message IDs for correlation |
| Keep-alive confusion | Silent stream death | Application-level heartbeats |

### Junior -> FAANG: Incident Pattern Recognition

Each pitfall in this section corresponds to a class of production incident. Learning to recognize the symptom before reading the code is the skill that makes you effective on an on-call rotation.

**OOM on server (Pitfall 1):** Memory grows steadily. The growth rate correlates with the number of active streams. Heap profiles show large allocations in gRPC's internal write buffer or in a `chan *T` backing array. The root cause is almost always a `Send` loop that outruns a slow receiver. The immediate mitigation is to limit the number of concurrent streams (via a server interceptor semaphore) or to reduce message rate (add a `time.Sleep` or `rate.Limiter` in the send loop). The permanent fix is application-level flow control as shown in the corrected `AnalyzeFrames` handler.

**Goroutine leak (Pitfall 3):** Goroutine count grows monotonically. `runtime.NumGoroutine()` exposed as a Prometheus gauge shows a steady upward trend. `pprof` goroutine dump shows many goroutines blocked on a channel send to a channel that no one is reading from. The root cause is always a goroutine that does not select on context cancellation. The fix is always to add `case <-ctx.Done(): return` to every channel send inside a goroutine.

**Silent stream death (Pitfall 6):** Streams appear healthy (no errors) but stop delivering messages. The transport keepalive says the connection is alive. The application heartbeat has not fired in the last N seconds. This is the NAT rebinding or load balancer idle timeout scenario. The immediate mitigation is to reconnect the stream. The permanent fix is application-level heartbeats with a timeout shorter than the load balancer's idle timeout.

Develop the habit of checking these three symptoms (memory growth, goroutine growth, silent delivery halt) whenever you are on call for a streaming service. Each symptom maps to a specific class of pitfall with a known remediation.

### Senior @ FAANG: Pitfall Prevention at the Platform Level

The six pitfalls in this section recur across teams and organizations because they are structural, not accidental. Platform engineers address them structurally.

**Pitfall 1 prevention: stream-level memory limits.** Implement a server interceptor that tracks the number of in-flight `Send` calls per stream using an atomic counter and a configurable limit. When the limit is reached, the interceptor makes `Send` block until the counter drops. This is equivalent to the `outstanding` semaphore in the corrected `AnalyzeFrames` handler, but applied uniformly to all streaming handlers. Configure the limit per service based on load testing data. Document the limit in the service's capacity plan.

**Pitfall 2 prevention: stream lifecycle state machine in generated code.** The half-closed stream deadlock arises because the send goroutine and receive goroutine must coordinate shutdown correctly. This coordination is mechanical and identical across all bidirectional streaming handlers. Generate a base handler type from the proto definition that manages the goroutines and exposes only the application-level callbacks (`OnMessage`, `OnClose`, `OnError`). Teams implement the callbacks, and the generated base handles the lifecycle. This eliminates the class of bugs where a developer implements the goroutines incorrectly.

**Pitfall 3 prevention: goroutine leak detector in CI.** Add a test helper that records `runtime.NumGoroutine()` before and after each streaming test, asserts they are equal (within a small delta for GC), and fails the test with a goroutine dump if they differ. This catches leaks in CI before they reach production. The `goleak` library provides exactly this functionality. Make it a required import in all streaming test files.

**Pitfall 4 prevention: resumable upload as a platform service.** Require all large file transfer use cases to go through the shared resumable upload service rather than implementing custom client-streaming RPCs. The platform service handles chunk acknowledgment, offset tracking, and retry automatically. Teams that bypass the platform service must justify the decision in an architectural review.

**Pitfalls 5 and 6 prevention: protocol design review.** Add bidirectional streaming RPCs to the service's API review checklist: (1) does the protocol include explicit message IDs for correlation? (2) does the protocol include application-level heartbeats? (3) what is the reconnect protocol and how does the client detect `GOAWAY`? RPCs that cannot answer all three questions are sent back for redesign before implementation begins. This prevents the ordering assumption and keepalive confusion pitfalls from reaching production by catching them at the design stage.

---
