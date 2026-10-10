## 43.7 Company Case Studies

### How Google Uses gRPC

Google created gRPC as the open-source evolution of Stubby, their internal RPC framework. Their public Cloud APIs are all available via gRPC, and their API design guide has become the de facto standard for proto-based service design. The code below demonstrates Google's resource-oriented proto pattern and their field mask approach for partial updates.

```go
package google

/*
GOOGLE'S gRPC USAGE

1. Internal Communication:
   - Stubby (predecessor to gRPC) handles 10^10 RPCs/second
   - Used between all internal services
   - Standardized interface definitions

2. Google Cloud APIs:
   - All Cloud APIs available via gRPC
   - Cloud Pub/Sub uses streaming extensively
   - Cloud Spanner uses gRPC for distributed transactions

3. Key Patterns:
   - Strict API versioning (google.api.http annotations)
   - Rich error model with google.rpc.Status
   - Field masks for partial updates
   - Resource-oriented design

4. gRPC Ecosystem:
   - grpc-go: Official Go implementation
   - gRPC-Web: Browser support via proxy
   - gRPC-Gateway: REST/gRPC transcoding
*/

// Google-style resource-oriented proto design
/*
syntax = "proto3";
package google.example.library.v1;

import "google/api/annotations.proto";
import "google/api/field_behavior.proto";
import "google/protobuf/field_mask.proto";

message Book {
  // Resource name: "shelves/{shelf}/books/{book}"
  string name = 1;
  string title = 2 [(google.api.field_behavior) = REQUIRED];
  string author = 3;
  bool read = 4;
}

message GetBookRequest {
  string name = 1 [(google.api.field_behavior) = REQUIRED];
}

message UpdateBookRequest {
  Book book = 1 [(google.api.field_behavior) = REQUIRED];
  google.protobuf.FieldMask update_mask = 2;
}

service LibraryService {
  rpc GetBook(GetBookRequest) returns (Book) {
    option (google.api.http) = {
      get: "/v1/{name=shelves/*/books/*}"
    };
  }

  rpc UpdateBook(UpdateBookRequest) returns (Book) {
    option (google.api.http) = {
      patch: "/v1/{book.name=shelves/*/books/*}"
      body: "book"
    };
  }
}
*/

// Google-style field mask update implementation
type BookServer struct {
    pb.UnimplementedLibraryServiceServer
    store BookStore
}

func (s *BookServer) UpdateBook(ctx context.Context, req *pb.UpdateBookRequest) (*pb.Book, error) {
    if req.Book == nil {
        return nil, status.Error(codes.InvalidArgument, "book is required")
    }

    existing, err := s.store.Get(ctx, req.Book.Name)
    if err != nil {
        return nil, status.Errorf(codes.NotFound, "book %s not found", req.Book.Name)
    }

    // Apply field mask for partial updates
    if req.UpdateMask != nil && len(req.UpdateMask.Paths) > 0 {
        for _, path := range req.UpdateMask.Paths {
            switch path {
            case "title":
                existing.Title = req.Book.Title
            case "author":
                existing.Author = req.Book.Author
            case "read":
                existing.Read = req.Book.Read
            default:
                return nil, status.Errorf(codes.InvalidArgument, "unknown field: %s", path)
            }
        }
    } else {
        // Full update if no mask
        existing.Title = req.Book.Title
        existing.Author = req.Book.Author
        existing.Read = req.Book.Read
    }

    updated, err := s.store.Update(ctx, existing)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "failed to update: %v", err)
    }

    return updated, nil
}
```

### How Uber Uses gRPC

Uber processes millions of trips daily and relies on gRPC for service-to-service communication across its microservices architecture. Two patterns from stacks at that scale are particularly instructive: hedged requests for tail latency reduction, and deadline propagation for resource management across call chains.

```go
package uber

/*
UBER'S gRPC PATTERNS

1. Service Mesh Integration:
   - gRPC integrated with custom service mesh
   - Automatic mTLS between services
   - Service discovery via Ringpop

2. Schema Registry:
   - Centralized proto repository
   - Breaking change detection in CI
   - Auto-generated documentation

3. Observability:
   - Custom interceptors for tracing
   - Automatic metrics collection
   - Request/response logging

4. Resilience:
   - Hedged requests for critical paths
   - Deadline propagation
   - Circuit breakers

5. Code Generation:
   - Unified code gen pipeline
   - Go, Java, Node.js, Python clients
   - Strongly typed SDKs
*/

// Uber-style client with hedged requests
type HedgedClient struct {
    clients      []pb.RideServiceClient
    timeout      time.Duration
    hedgeDelay   time.Duration
    maxHedges    int
}

func NewHedgedClient(addresses []string, opts ...grpc.DialOption) (*HedgedClient, error) {
    clients := make([]pb.RideServiceClient, len(addresses))

    for i, addr := range addresses {
        conn, err := grpc.NewClient(addr, opts...)
        if err != nil {
            return nil, fmt.Errorf("failed to connect to %s: %w", addr, err)
        }
        clients[i] = pb.NewRideServiceClient(conn)
    }

    return &HedgedClient{
        clients:    clients,
        timeout:    5 * time.Second,
        hedgeDelay: 50 * time.Millisecond,
        maxHedges:  3,
    }, nil
}

// GetRide sends hedged requests for lower tail latency
func (c *HedgedClient) GetRide(ctx context.Context, rideID string) (*pb.Ride, error) {
    ctx, cancel := context.WithTimeout(ctx, c.timeout)
    defer cancel()

    type result struct {
        ride *pb.Ride
        err  error
    }

    results := make(chan result, c.maxHedges)

    // Send first request immediately
    go func() {
        ride, err := c.clients[0].GetRide(ctx, &pb.GetRideRequest{RideId: rideID})
        results <- result{ride, err}
    }()

    // Hedge: send additional requests after delay
    for i := 1; i < c.maxHedges && i < len(c.clients); i++ {
        client := c.clients[i]
        go func(delay time.Duration) {
            select {
            case <-time.After(delay):
                ride, err := client.GetRide(ctx, &pb.GetRideRequest{RideId: rideID})
                select {
                case results <- result{ride, err}:
                default:
                }
            case <-ctx.Done():
            }
        }(time.Duration(i) * c.hedgeDelay)
    }

    // Return first successful response
    var lastErr error
    for i := 0; i < c.maxHedges; i++ {
        select {
        case r := <-results:
            if r.err == nil {
                return r.ride, nil
            }
            lastErr = r.err
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    return nil, lastErr
}

// Uber-style interceptor for deadline propagation
func DeadlinePropagationInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Extract deadline from incoming context
        deadline, ok := ctx.Deadline()
        if !ok {
            // Set default deadline if none
            var cancel context.CancelFunc
            ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
            defer cancel()
        } else {
            // Subtract buffer for network overhead
            remaining := time.Until(deadline) - 10*time.Millisecond
            if remaining <= 0 {
                return status.Error(codes.DeadlineExceeded, "deadline already passed")
            }

            var cancel context.CancelFunc
            ctx, cancel = context.WithTimeout(ctx, remaining)
            defer cancel()
        }

        return invoker(ctx, method, req, reply, cc, opts...)
    }
}
```

### How Netflix Uses gRPC

Netflix operates a polyglot microservices architecture spanning Java, Node.js, and Go. Their gRPC usage emphasizes resilience - circuit breakers prevent cascade failures, and request coalescing batches individual calls into efficient bulk operations. The two patterns below show a circuit breaker wrapper around a gRPC client and a coalescing client that groups concurrent requests into batch RPCs.

```go
package netflix

/*
NETFLIX'S gRPC PATTERNS

1. Polyglot Support:
   - Java, Node.js, Go services
   - Shared proto definitions
   - Language-specific best practices

2. Streaming for Data Pipeline:
   - Real-time recommendation updates
   - Content delivery metadata
   - User activity streaming

3. Resilience Engineering:
   - Hystrix-style circuit breakers
   - Fallback responses
   - Chaos engineering integration

4. Performance:
   - Connection pooling
   - Client-side load balancing
   - Request coalescing
*/

// Netflix-style circuit breaker wrapper
type CircuitBreakerClient struct {
    client  pb.ContentServiceClient
    breaker *CircuitBreaker
}

type CircuitBreaker struct {
    mu              sync.RWMutex
    state           CircuitState
    failures        int
    successCount    int
    failureThreshold int
    successThreshold int
    timeout         time.Duration
    lastFailure     time.Time
}

type CircuitState int

const (
    CircuitClosed CircuitState = iota
    CircuitOpen
    CircuitHalfOpen
)

func (c *CircuitBreakerClient) GetContent(ctx context.Context, contentID string) (*pb.Content, error) {
    // Check circuit state
    if !c.breaker.Allow() {
        // Circuit is open - return cached/fallback response
        return c.getFallbackContent(contentID)
    }

    resp, err := c.client.GetContent(ctx, &pb.GetContentRequest{ContentId: contentID})
    if err != nil {
        c.breaker.RecordFailure()

        // Check if we should use fallback
        if c.breaker.IsOpen() {
            return c.getFallbackContent(contentID)
        }

        return nil, err
    }

    c.breaker.RecordSuccess()
    return resp, nil
}

func (c *CircuitBreakerClient) getFallbackContent(contentID string) (*pb.Content, error) {
    // Return cached or degraded response
    return &pb.Content{
        ContentId: contentID,
        Title:     "Content Temporarily Unavailable",
        Available: false,
    }, nil
}

func (cb *CircuitBreaker) Allow() bool {
    cb.mu.RLock()
    defer cb.mu.RUnlock()

    switch cb.state {
    case CircuitClosed:
        return true
    case CircuitOpen:
        // Check if timeout has passed
        if time.Since(cb.lastFailure) > cb.timeout {
            cb.mu.RUnlock()
            cb.mu.Lock()
            cb.state = CircuitHalfOpen
            cb.successCount = 0
            cb.mu.Unlock()
            cb.mu.RLock()
            return true
        }
        return false
    case CircuitHalfOpen:
        return true
    }

    return false
}

// Netflix-style request coalescing for batch efficiency
type CoalescingClient struct {
    client   pb.ContentServiceClient
    pending  map[string][]chan *contentResult
    mu       sync.Mutex
    interval time.Duration
}

type contentResult struct {
    content *pb.Content
    err     error
}

func NewCoalescingClient(client pb.ContentServiceClient, interval time.Duration) *CoalescingClient {
    c := &CoalescingClient{
        client:   client,
        pending:  make(map[string][]chan *contentResult),
        interval: interval,
    }

    go c.processLoop()
    return c
}

func (c *CoalescingClient) GetContent(ctx context.Context, contentID string) (*pb.Content, error) {
    resultCh := make(chan *contentResult, 1)

    c.mu.Lock()
    c.pending[contentID] = append(c.pending[contentID], resultCh)
    c.mu.Unlock()

    select {
    case result := <-resultCh:
        return result.content, result.err
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

func (c *CoalescingClient) processLoop() {
    ticker := time.NewTicker(c.interval)
    defer ticker.Stop()

    for range ticker.C {
        c.mu.Lock()
        pending := c.pending
        c.pending = make(map[string][]chan *contentResult)
        c.mu.Unlock()

        if len(pending) == 0 {
            continue
        }

        // Batch request
        contentIDs := make([]string, 0, len(pending))
        for id := range pending {
            contentIDs = append(contentIDs, id)
        }

        resp, err := c.client.BatchGetContent(context.Background(), &pb.BatchGetContentRequest{
            ContentIds: contentIDs,
        })

        // Distribute results
        for id, channels := range pending {
            result := &contentResult{err: err}
            if err == nil {
                if content, ok := resp.Contents[id]; ok {
                    result.content = content
                } else {
                    result.err = status.Error(codes.NotFound, "content not found")
                }
            }

            for _, ch := range channels {
                ch <- result
            }
        }
    }
}
```

### How Dropbox Uses gRPC

Dropbox migrated its legacy RPC frameworks to gRPC (the migration behind their public Courier post) for better performance and type safety at scale. Their file synchronization system handles billions of operations across a global edge network. Two patterns from their migration stand out: consistent hashing for routing requests to the correct backend, and server-streaming for efficient metadata synchronization.

```go
package dropbox

/*
DROPBOX'S gRPC MIGRATION

1. Migration Strategy:
   - Gradual migration from a legacy HTTP/1.1 + protobuf RPC framework
   - Dual-protocol period
   - Performance validation

2. Scale:
   - Billions of file sync operations
   - Global edge network
   - Consistent hashing for routing

3. Key Optimizations:
   - Custom load balancing
   - Connection reuse
   - Efficient metadata serialization

4. Observability:
   - OpenTelemetry integration
   - Custom metrics
   - Distributed tracing
*/

// Dropbox-style client with consistent hashing
type ConsistentHashClient struct {
    ring       *ConsistentHash
    clients    map[string]pb.FileServiceClient
    clientsMu  sync.RWMutex
}

type ConsistentHash struct {
    nodes    []uint32
    nodeMap  map[uint32]string
    replicas int
}

func NewConsistentHashClient(addresses []string) (*ConsistentHashClient, error) {
    c := &ConsistentHashClient{
        ring:    NewConsistentHash(100), // 100 virtual nodes per server
        clients: make(map[string]pb.FileServiceClient),
    }

    for _, addr := range addresses {
        if err := c.addNode(addr); err != nil {
            return nil, err
        }
    }

    return c, nil
}

func (c *ConsistentHashClient) addNode(addr string) error {
    conn, err := grpc.NewClient(addr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             5 * time.Second,
            PermitWithoutStream: true,
        }),
    )
    if err != nil {
        return err
    }

    c.clientsMu.Lock()
    c.clients[addr] = pb.NewFileServiceClient(conn)
    c.ring.Add(addr)
    c.clientsMu.Unlock()

    return nil
}

func (c *ConsistentHashClient) GetFile(ctx context.Context, fileID string) (*pb.File, error) {
    // Use file ID to determine which server handles this file
    addr := c.ring.Get(fileID)

    c.clientsMu.RLock()
    client, ok := c.clients[addr]
    c.clientsMu.RUnlock()

    if !ok {
        return nil, status.Error(codes.Unavailable, "no client for node")
    }

    return client.GetFile(ctx, &pb.GetFileRequest{FileId: fileID})
}

// Dropbox-style efficient metadata sync using streaming
func (c *ConsistentHashClient) SyncMetadata(ctx context.Context, cursor string, callback func(*pb.FileMetadata)) error {
    // Determine server from cursor
    addr := c.ring.Get(cursor)

    c.clientsMu.RLock()
    client, ok := c.clients[addr]
    c.clientsMu.RUnlock()

    if !ok {
        return status.Error(codes.Unavailable, "no client for node")
    }

    stream, err := client.StreamMetadataChanges(ctx, &pb.MetadataChangesRequest{
        Cursor: cursor,
    })
    if err != nil {
        return err
    }

    for {
        metadata, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        callback(metadata)
    }
}
```

### Junior → FAANG: Extracting Transferable Patterns from Company Case Studies

The four company patterns above are not just interesting stories. They are reusable design vocabulary for interviews and real systems.

**Google's field mask pattern.** The `UpdateBook` implementation that iterates over `update_mask.paths` and applies only the named fields is the correct approach to partial updates in any gRPC service. It eliminates a class of bugs where a client that knows only about fields A and B accidentally clears field C (which was added later) because it sends a full replacement. When you see an update RPC in an interview that does not use `FieldMask`, mention it. Knowing this pattern signals familiarity with the Google API design guide.

**Uber's deadline propagation.** The `DeadlinePropagationInterceptor` subtracts a buffer from the incoming deadline before calling downstream. This is the correct approach because network latency and serialization overhead consume some of the remaining deadline budget. Always subtract 10-20ms for a local datacenter hop, more for cross-region calls. In interviews, when asked about reliability in a distributed system, mentioning deadline propagation as a resource management mechanism (not just a timeout mechanism) demonstrates depth.

**Netflix's circuit breaker.** The `CircuitBreakerClient` prevents cascade failure by rejecting calls locally when the downstream is failing. The key interview point is that a circuit breaker and a retry are complementary: retries reduce the impact of transient failures, circuit breakers prevent you from amplifying load against a system that is already failing. Never retry indefinitely without a circuit breaker to stop the retry storm.

**Dropbox's consistent hashing.** The `ConsistentHashClient` routes requests for a given file ID to a specific backend, enabling per-request caching at the backend level. The interview application: when data affinity matters (user-specific caching, shard-based storage), consistent hashing gives you deterministic routing without a central coordinator.

### Senior @ FAANG: Evaluating Company Patterns Against Your Platform's Constraints

The case studies above represent mature, well-funded engineering organizations that built custom solutions to specific problems. At the L6 level, the question is not "should I implement hedged requests like Uber?" but "which of my services have tail-latency-sensitive paths where hedging provides meaningful value, and what is the load amplification cost?"

**Hedging as a load amplification decision.** Uber's `HedgedClient` sends up to 3 requests to get the first successful response. In the worst case (all three requests complete), you have tripled the load on the downstream service. At Google scale with very large fleets this is absorbed easily. At a 10-pod fleet with 5% error rates, hedging can amplify a traffic spike into an overload cascade. Before implementing hedging, measure your p50, p95, and p99 latencies. Hedging is only beneficial when the p99 is significantly higher than the p50 (long tail) and the downstream can absorb the additional load. Document this analysis in the ADR.

**Circuit breakers as a platform-level primitive.** Netflix's circuit breaker is implemented in the client. At the platform level, circuit breakers belong in the service mesh or the platform's shared client interceptor, not in individual service implementations. When each team implements their own circuit breaker with different thresholds and state machines, you cannot get a fleet-wide view of circuit breaker state, and teams make inconsistent decisions about what constitutes a "failure." The platform team should provide a circuit breaker interceptor with configurable thresholds and expose circuit breaker state as a metric (`circuit_breaker_state{service="user-svc", state="open"}`) so SREs can observe fleet-wide circuit breaker patterns from a single dashboard.

**Consistent hashing and stateful routing.** Dropbox's consistent hashing solves a real problem: backends need to cache data per user/file to reduce storage latency, but random load balancing defeats per-backend caches. The senior-level concern is what happens during topology changes. When a backend is added or removed, roughly `1/N` of keys remap to new backends (the property that defines consistent hashing). The backends that lose their keys experience cache cold-start, a potential latency spike. At large scale, this spike must be managed: stagger backend additions, use virtual nodes to minimize remapping, pre-warm caches from the previous backend before switching, or use read-through caches so cold misses are still served (slowly) from the origin. Document the expected cold-start duration and the latency impact in your service's SLO.

**Request coalescing and the thundering herd.** Netflix's `CoalescingClient` batches concurrent requests for the same content ID into a single RPC. This prevents the "thundering herd" problem: a popular content item expires from cache and 10,000 requests simultaneously miss and call the origin. The coalescing client collapses those 10,000 calls into one batch. The design trade-off is latency: requests arriving within the `interval` window are held until the batch fires. For sub-millisecond latency requirements, the coalescing interval must be very short (1-5ms), which reduces the batch efficiency. For high-latency, high-cost operations (database reads, external API calls), a longer interval provides more benefit. Tune based on measured request arrival rates and acceptable latency budgets.

---
