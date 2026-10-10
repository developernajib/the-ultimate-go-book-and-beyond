## 3. Netflix: Chaos Engineering and Performance

### 3.1 Why Netflix Uses Go

Netflix primarily uses Java, but Go is used for:
- High-performance proxy services
- Container orchestration (Titus)
- Network performance tools
- Chaos engineering tools

### 3.2 What Netflix Built with Go

#### Rend - Memcached Proxy

Rend sits between clients and memcached clusters, handling connection pooling and request routing. Its architecture follows a straightforward accept-loop pattern with per-connection goroutines.
```go
package rend

// Rend: High-performance memcached proxy
type Server struct {
    listener net.Listener
    pool     *ConnectionPool
    metrics  MetricsCollector
}

func (s *Server) Serve() error {
    for {
        conn, err := s.listener.Accept()
        if err != nil {
            return err
        }

        // Handle each connection concurrently
        go s.handleConnection(conn)
    }
}

func (s *Server) handleConnection(conn net.Conn) {
    defer conn.Close()

    scanner := bufio.NewScanner(conn)
    writer := bufio.NewWriter(conn)

    for scanner.Scan() {
        cmd := parseCommand(scanner.Bytes())

        start := time.Now()
        resp := s.execute(cmd)
        duration := time.Since(start)

        s.metrics.RecordLatency(cmd.Type, duration)

        writer.Write(resp)
        writer.Flush()
    }
}

// Connection pooling for backend
type ConnectionPool struct {
    mu    sync.Mutex
    conns chan *memcache.Client
}

func (p *ConnectionPool) Get() (*memcache.Client, error) {
    select {
    case conn := <-p.conns:
        return conn, nil
    default:
        return memcache.New("backend:11211")
    }
}

func (p *ConnectionPool) Put(conn *memcache.Client) {
    select {
    case p.conns <- conn:
    default:
        conn.Close()
    }
}
```

#### Chaos Monkey for Kubernetes

Chaos Monkey terminates random pods on a schedule to verify that services recover gracefully. The Go implementation uses a cron scheduler and the Kubernetes client library.
```go
package chaos

// Chaos Monkey: Random pod termination
type ChaosMonkey struct {
    client    *kubernetes.Clientset
    config    ChaosConfig
    scheduler *cron.Cron
}

type ChaosConfig struct {
    TargetNamespace string
    Probability     float64
    Schedule        string
}

func (cm *ChaosMonkey) Start(ctx context.Context) error {
    cm.scheduler.AddFunc(cm.config.Schedule, func() {
        if rand.Float64() < cm.config.Probability {
            cm.terminateRandomPod(ctx)
        }
    })

    cm.scheduler.Start()
    <-ctx.Done()
    return nil
}

func (cm *ChaosMonkey) terminateRandomPod(ctx context.Context) error {
    // List all pods in namespace
    pods, err := cm.client.CoreV1().Pods(cm.config.TargetNamespace).List(ctx, metav1.ListOptions{})
    if err != nil {
        return err
    }

    if len(pods.Items) == 0 {
        return nil
    }

    // Select random pod
    target := pods.Items[rand.IntN(len(pods.Items))]

    log.Printf("Terminating pod %s/%s", target.Namespace, target.Name)

    // Delete pod
    return cm.client.CoreV1().Pods(target.Namespace).Delete(
        ctx,
        target.Name,
        metav1.DeleteOptions{},
    )
}
```

### 3.3 Netflix's Performance Philosophy

**Zero-Copy I/O:**

```go
package server

// Using sendfile for zero-copy transfers
func ServeFile(w http.ResponseWriter, r *http.Request, path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()

    stat, err := f.Stat()
    if err != nil {
        return err
    }

    // Set headers
    w.Header().Set("Content-Length", strconv.FormatInt(stat.Size(), 10))
    w.Header().Set("Content-Type", "video/mp4")

    // Use sendfile syscall for zero-copy
    if tcp, ok := w.(interface{ Hijack() (net.Conn, *bufio.ReadWriter, error) }); ok {
        conn, _, err := tcp.Hijack()
        if err == nil {
            defer conn.Close()

            // Write HTTP headers manually
            fmt.Fprintf(conn, "HTTP/1.1 200 OK\r\n")
            w.Header().Write(conn)
            fmt.Fprintf(conn, "\r\n")

            // Zero-copy transfer
            return sendfile(conn, f, stat.Size())
        }
    }

    // Fallback to standard copy
    _, err = io.Copy(w, f)
    return err
}
```

**Adaptive Concurrency Control:**

```go
package limiter

// TCP Vegas-like concurrency limiter
type AdaptiveLimiter struct {
    limit       int64
    inFlight    int64
    minLatency  time.Duration
    maxLatency  time.Duration
    mu          sync.Mutex
}

func (l *AdaptiveLimiter) Acquire(ctx context.Context) (func(), error) {
    for {
        current := atomic.LoadInt64(&l.inFlight)
        if current < atomic.LoadInt64(&l.limit) {
            if atomic.CompareAndSwapInt64(&l.inFlight, current, current+1) {
                start := time.Now()
                return func() {
                    atomic.AddInt64(&l.inFlight, -1)
                    l.updateLimit(time.Since(start))
                }, nil
            }
        }

        select {
        case <-time.After(10 * time.Millisecond):
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }
}

func (l *AdaptiveLimiter) updateLimit(latency time.Duration) {
    l.mu.Lock()
    defer l.mu.Unlock()

    if latency < l.minLatency {
        // Increase concurrency
        atomic.AddInt64(&l.limit, 1)
    } else if latency > l.maxLatency {
        // Decrease concurrency
        if current := atomic.LoadInt64(&l.limit); current > 1 {
            atomic.AddInt64(&l.limit, -1)
        }
    }
}
```

### 3.4 Go 1.25/1.26 Features Relevant to Netflix

Netflix's core challenges - streaming at global scale, chaos engineering, and resilience testing - align with several Go 1.25/1.26 improvements:

- **Green Tea GC** (Go 1.26): Netflix's streaming infrastructure must maintain consistent low-latency chunk delivery to 260M+ subscribers. GC pauses in Go-based manifest servers and CDN orchestration code can cause micro-stalls visible as buffering events. The Green Tea GC (default in 1.26) reduces these pauses, improving quality-of-experience metrics that Netflix tracks to the millisecond.
- **`testing/synctest`** (Go 1.25): Netflix pioneered chaos engineering - intentionally injecting failures to test resilience. Their Go-based chaos tooling (analogous to Chaos Monkey) tests complex concurrent failure scenarios. `testing/synctest` makes it possible to write deterministic unit tests for concurrent failure-injection logic without timing-based test flakiness.
- **Self-referential types in generics** (Go 1.26): Netflix's recommendation engine and content graph use complex type-safe recursive structures. Self-referential generics in Go 1.26 allow expressing these graph structures (content nodes referencing themselves through typed edges) without `interface{}` overhead.

### 3.5 Netflix Interview Expectations

**Focus Areas:**
- System performance and optimization
- Resilience and fault tolerance
- Microservices architecture
- A/B testing infrastructure

**Sample Question:**

```go
package ratelimit

// Design a rate limiter for API gateway
type RateLimiter interface {
    Allow(userID string) bool
}

// Token bucket implementation
type TokenBucket struct {
    capacity int
    tokens   map[string]*bucket
    mu       sync.RWMutex
}

type bucket struct {
    tokens   float64
    lastSeen time.Time
}

func NewTokenBucket(capacity int) *TokenBucket {
    tb := &TokenBucket{
        capacity: capacity,
        tokens:   make(map[string]*bucket),
    }

    // Cleanup goroutine
    go tb.cleanup()

    return tb
}

func (tb *TokenBucket) Allow(userID string) bool {
    tb.mu.Lock()
    defer tb.mu.Unlock()

    now := time.Now()
    b, exists := tb.tokens[userID]

    if !exists {
        tb.tokens[userID] = &bucket{
            tokens:   float64(tb.capacity - 1),
            lastSeen: now,
        }
        return true
    }

    // Refill tokens based on elapsed time
    elapsed := now.Sub(b.lastSeen).Seconds()
    b.tokens = math.Min(float64(tb.capacity), b.tokens+elapsed*10) // 10 tokens/sec
    b.lastSeen = now

    if b.tokens >= 1.0 {
        b.tokens -= 1.0
        return true
    }

    return false
}

func (tb *TokenBucket) cleanup() {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        tb.mu.Lock()
        cutoff := time.Now().Add(-5 * time.Minute)
        for id, b := range tb.tokens {
            if b.lastSeen.Before(cutoff) {
                delete(tb.tokens, id)
            }
        }
        tb.mu.Unlock()
    }
}
```

---
