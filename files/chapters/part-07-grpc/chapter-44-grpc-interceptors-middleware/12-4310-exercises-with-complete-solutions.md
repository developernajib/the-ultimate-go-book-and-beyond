## 44.10 Exercises with Complete Solutions

### Exercise 1: Build a Caching Interceptor for Idempotent Requests

**Requirements:**
- Cache responses for GET/Read operations
- Support configurable TTL per method
- Cache key based on request content
- Handle cache invalidation

**Solution:**

```go
package caching

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "sync"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
    "google.golang.org/protobuf/proto"
)

// CacheConfig holds caching configuration
type CacheConfig struct {
    // Methods to cache with their TTL
    Methods map[string]time.Duration
    // Maximum cache size
    MaxEntries int
    // Default TTL for methods not in config
    DefaultTTL time.Duration
}

// CacheEntry holds a cached response
type CacheEntry struct {
    Response  any
    ExpiresAt time.Time
}

// CachingInterceptor provides response caching
type CachingInterceptor struct {
    config CacheConfig
    cache  sync.Map
    mu     sync.Mutex
    count  int
}

func NewCachingInterceptor(config CacheConfig) *CachingInterceptor {
    c := &CachingInterceptor{
        config: config,
    }

    // Start cleanup goroutine
    go c.cleanup()

    return c
}

// UnaryClientInterceptor returns a caching client interceptor
func (c *CachingInterceptor) UnaryClientInterceptor() grpc.UnaryClientInterceptor {
    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        // Check if method is cacheable
        ttl, cacheable := c.config.Methods[method]
        if !cacheable {
            return invoker(ctx, method, req, reply, cc, opts...)
        }

        // Generate cache key
        key := c.cacheKey(method, req)

        // Check cache
        if entry, ok := c.cache.Load(key); ok {
            cached := entry.(*CacheEntry)
            if time.Now().Before(cached.ExpiresAt) {
                // Cache hit - copy response
                if protoReply, ok := reply.(proto.Message); ok {
                    if protoCache, ok := cached.Response.(proto.Message); ok {
                        proto.Merge(protoReply, protoCache)
                        return nil
                    }
                }
            }
            // Expired or incompatible - delete
            c.cache.Delete(key)
        }

        // Cache miss - make the call
        err := invoker(ctx, method, req, reply, cc, opts...)
        if err != nil {
            return err
        }

        // Store in cache
        c.storeEntry(key, reply, ttl)

        return nil
    }
}

func (c *CachingInterceptor) cacheKey(method string, req any) string {
    h := sha256.New()
    h.Write([]byte(method))

    if protoReq, ok := req.(proto.Message); ok {
        data, _ := proto.Marshal(protoReq)
        h.Write(data)
    }

    return hex.EncodeToString(h.Sum(nil))
}

func (c *CachingInterceptor) storeEntry(key string, response any, ttl time.Duration) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Check if we need to evict
    if c.count >= c.config.MaxEntries {
        c.evictOldest()
    }

    // Clone response for storage
    var stored any
    if protoResp, ok := response.(proto.Message); ok {
        stored = proto.Clone(protoResp)
    } else {
        stored = response
    }

    c.cache.Store(key, &CacheEntry{
        Response:  stored,
        ExpiresAt: time.Now().Add(ttl),
    })
    c.count++
}

func (c *CachingInterceptor) evictOldest() {
    var oldestKey any
    var oldestTime time.Time

    c.cache.Range(func(key, value any) bool {
        entry := value.(*CacheEntry)
        if oldestKey == nil || entry.ExpiresAt.Before(oldestTime) {
            oldestKey = key
            oldestTime = entry.ExpiresAt
        }
        return true
    })

    if oldestKey != nil {
        c.cache.Delete(oldestKey)
        c.count--
    }
}

func (c *CachingInterceptor) cleanup() {
    ticker := time.NewTicker(time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        now := time.Now()
        var keysToDelete []any

        c.cache.Range(func(key, value any) bool {
            entry := value.(*CacheEntry)
            if now.After(entry.ExpiresAt) {
                keysToDelete = append(keysToDelete, key)
            }
            return true
        })

        c.mu.Lock()
        for _, key := range keysToDelete {
            c.cache.Delete(key)
            c.count--
        }
        c.mu.Unlock()
    }
}

// Invalidate removes a specific cache entry
func (c *CachingInterceptor) Invalidate(method string, req any) {
    key := c.cacheKey(method, req)
    c.mu.Lock()
    if _, ok := c.cache.LoadAndDelete(key); ok {
        c.count--
    }
    c.mu.Unlock()
}

// InvalidateAll clears the entire cache
func (c *CachingInterceptor) InvalidateAll() {
    c.mu.Lock()
    c.cache = sync.Map{}
    c.count = 0
    c.mu.Unlock()
}

// Usage example
func ExampleUsage() {
    cache := NewCachingInterceptor(CacheConfig{
        Methods: map[string]time.Duration{
            "/user.v1.UserService/GetUser":   5 * time.Minute,
            "/user.v1.UserService/ListUsers": 1 * time.Minute,
        },
        MaxEntries: 1000,
    })

    conn, _ := grpc.NewClient("localhost:50051",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithUnaryInterceptor(cache.UnaryClientInterceptor()),
    )
    defer conn.Close()
}
```

### Exercise 2: Build an Audit Logging Interceptor

**Requirements:**
- Log all mutation operations (Create, Update, Delete)
- Include user information, request details, and results
- Support structured logging for analysis
- Handle sensitive data redaction

**Solution:**

```go
package audit

import (
    "context"
    "encoding/json"
    "log/slog"
    "strings"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

// AuditConfig configures audit logging
type AuditConfig struct {
    // Methods that should be audited (e.g., Create*, Update*, Delete*)
    MutationPrefixes []string
    // Fields to redact from logs
    SensitiveFields []string
    // Logger
    Logger *slog.Logger
    // Optional: async logging
    Async bool
    // Optional: audit event channel for external processing
    EventChannel chan<- *AuditEvent
}

// AuditEvent represents an audited operation
type AuditEvent struct {
    Timestamp   time.Time     `json:"timestamp"`
    Method      string        `json:"method"`
    UserID      string        `json:"user_id,omitempty"`
    UserEmail   string        `json:"user_email,omitempty"`
    RequestID   string        `json:"request_id,omitempty"`
    ClientIP    string        `json:"client_ip,omitempty"`
    Request     any   `json:"request,omitempty"`
    Response    any   `json:"response,omitempty"`
    Error       string        `json:"error,omitempty"`
    StatusCode  string        `json:"status_code"`
    Duration    time.Duration `json:"duration"`
    Success     bool          `json:"success"`
}

// AuditInterceptor provides audit logging
type AuditInterceptor struct {
    config AuditConfig
}

func NewAuditInterceptor(config AuditConfig) *AuditInterceptor {
    return &AuditInterceptor{config: config}
}

// UnaryServerInterceptor returns an audit logging interceptor
func (a *AuditInterceptor) UnaryServerInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req any,
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (any, error) {
        // Check if method should be audited
        if !a.shouldAudit(info.FullMethod) {
            return handler(ctx, req)
        }

        start := time.Now()

        // Extract context information
        event := &AuditEvent{
            Timestamp: start,
            Method:    info.FullMethod,
            Request:   a.sanitizeRequest(req),
        }

        // Extract user info
        if user := GetUser(ctx); user != nil {
            event.UserID = user.ID
            event.UserEmail = user.Email
        }

        // Extract metadata
        if md, ok := metadata.FromIncomingContext(ctx); ok {
            event.RequestID = getFirst(md, "x-request-id")
            event.ClientIP = getFirst(md, "x-forwarded-for")
        }

        // Execute handler
        resp, err := handler(ctx, req)

        // Complete event
        event.Duration = time.Since(start)
        event.Success = err == nil

        if err != nil {
            event.Error = err.Error()
            st, _ := status.FromError(err)
            event.StatusCode = st.Code().String()
        } else {
            event.StatusCode = codes.OK.String()
            event.Response = a.sanitizeResponse(resp)
        }

        // Log event
        a.logEvent(event)

        return resp, err
    }
}

func (a *AuditInterceptor) shouldAudit(method string) bool {
    for _, prefix := range a.config.MutationPrefixes {
        // Handle prefixes like "Create", "Update", "Delete"
        methodName := method[strings.LastIndex(method, "/")+1:]
        if strings.HasPrefix(methodName, prefix) {
            return true
        }
    }
    return false
}

func (a *AuditInterceptor) sanitizeRequest(req any) any {
    return a.redactSensitiveFields(req)
}

func (a *AuditInterceptor) sanitizeResponse(resp any) any {
    return a.redactSensitiveFields(resp)
}

func (a *AuditInterceptor) redactSensitiveFields(obj any) any {
    if obj == nil {
        return nil
    }

    // Convert to map for manipulation
    data, err := json.Marshal(obj)
    if err != nil {
        return "[marshal error]"
    }

    var m map[string]any
    if err := json.Unmarshal(data, &m); err != nil {
        return "[unmarshal error]"
    }

    // Redact sensitive fields
    a.redactMap(m)

    return m
}

func (a *AuditInterceptor) redactMap(m map[string]any) {
    for key, value := range m {
        // Check if key should be redacted
        if a.isSensitive(key) {
            m[key] = "[REDACTED]"
            continue
        }

        // Recurse into nested maps
        if nested, ok := value.(map[string]any); ok {
            a.redactMap(nested)
        }

        // Handle arrays
        if arr, ok := value.([]any); ok {
            for i, item := range arr {
                if nestedMap, ok := item.(map[string]any); ok {
                    a.redactMap(nestedMap)
                    arr[i] = nestedMap
                }
            }
        }
    }
}

func (a *AuditInterceptor) isSensitive(field string) bool {
    lower := strings.ToLower(field)
    for _, sensitive := range a.config.SensitiveFields {
        if strings.Contains(lower, strings.ToLower(sensitive)) {
            return true
        }
    }
    return false
}

func (a *AuditInterceptor) logEvent(event *AuditEvent) {
    if a.config.Async {
        go a.doLog(event)
    } else {
        a.doLog(event)
    }

    // Send to event channel if configured
    if a.config.EventChannel != nil {
        select {
        case a.config.EventChannel <- event:
        default:
            // Channel full, drop event
            a.config.Logger.Warn("audit event channel full, dropping event",
                "method", event.Method)
        }
    }
}

func (a *AuditInterceptor) doLog(event *AuditEvent) {
    attrs := []any{
        "method", event.Method,
        "user_id", event.UserID,
        "request_id", event.RequestID,
        "client_ip", event.ClientIP,
        "status_code", event.StatusCode,
        "duration_ms", event.Duration.Milliseconds(),
        "success", event.Success,
    }

    if !event.Success {
        attrs = append(attrs, "error", event.Error)
    }

    // Log request/response at debug level
    a.config.Logger.Info("audit", attrs...)

    if a.config.Logger.Enabled(context.Background(), slog.LevelDebug) {
        a.config.Logger.Debug("audit details",
            "request", event.Request,
            "response", event.Response,
        )
    }
}

// Usage example
func ExampleAuditConfig() AuditConfig {
    return AuditConfig{
        MutationPrefixes: []string{"Create", "Update", "Delete", "Set", "Remove"},
        SensitiveFields:  []string{"password", "token", "secret", "key", "credential", "ssn", "credit_card"},
        Logger:           slog.Default(),
        Async:            true,
    }
}

// Helper to get user from context
type User struct {
    ID    string
    Email string
}

type contextKey string

const userKey contextKey = "user"

func GetUser(ctx context.Context) *User {
    if user, ok := ctx.Value(userKey).(*User); ok {
        return user
    }
    return nil
}

func getFirst(md metadata.MD, key string) string {
    if values := md.Get(key); len(values) > 0 {
        return values[0]
    }
    return ""
}
```

### Junior -> FAANG: Getting Value from Each Exercise

These exercises are structured to mirror real FAANG take-home and onsite coding rounds. Here is how to extract maximum value from each one.

**Exercise 1 (caching interceptor):** The SHA-256 cache key based on proto serialization is the interesting part. Understand why you cannot use `fmt.Sprintf("%v", req)` as a cache key: proto's `String()` method is not guaranteed to be stable across serializations of the same message (field ordering, unknown fields). `proto.Marshal` produces deterministic binary output for a given message value in recent protobuf versions, making it a reliable cache key source.

**Exercise 2 (audit logging):** The sensitive field redaction using JSON round-tripping is correct but slow. A production implementation would use proto reflection (`proto.Message` + `protoreflect`) to walk the message fields and redact in-place before serialization. The JSON approach is fine for an exercise. For the interview, note that field-level redaction in a Go interceptor is inherently fragile because it relies on string matching against field names, which do not survive proto renames. The reliable solution is a proto field option (a custom annotation in the proto definition) that marks a field as sensitive, combined with a code generator that emits redaction logic at build time.

**Exercise 3 (rate limiting):** Pay attention to the `time/rate` package semantics. `limiter.Allow()` returns true if a token is available immediately and consumes it. `limiter.Wait(ctx)` blocks until a token is available or the context is canceled. For an RPC interceptor, `Allow()` is the correct choice: you want to shed load immediately rather than queue requests. Queuing requests with `Wait()` in an interceptor causes requests to pile up, consuming goroutines and memory, which is exactly the problem you are trying to avoid with rate limiting.

**Exercise 7 (chain ordering audit):** This exercise is the most important for interview preparation because it forces you to think about what each interceptor layer should and should not see. Write this test matrix and run it. The act of constructing five interceptors with verifiable behavior (a panic-inducing interceptor, an auth-failing interceptor, etc.) and asserting where each failure surfaces teaches the ordering constraint at a level that reading about it cannot.

### Senior @ FAANG: Extending the Exercises to Platform Problems

**Caching interceptor at scale:** The exercise caching interceptor uses an in-process `sync.Map`. At FAANG scale, this has three problems: the cache is not shared across replicas (each replica caches independently), the cache is lost on restart (warm-up latency after deploy), and the cache key does not account for caller identity (tenant A and tenant B might get each other's cached data if the method is tenant-scoped). A production caching layer uses Redis or Memcached as the backend, with cache keys that include tenant ID extracted from the auth context, and a cache warming strategy that pre-populates the cache after deploy using the previous deploy's cache contents exported before shutdown.

**Audit logging interceptor at scale:** The `EventChannel` pattern in the exercise is correct for decoupling the interceptor from the audit log sink. At FAANG scale, the channel consumer writes to a message queue (Kafka, Pub/Sub) rather than directly to a database, providing backpressure tolerance and replay capability. The `default` case in the `select` that drops events when the channel is full is a correctness trade-off: you are prioritizing service availability over audit completeness. For certain compliance requirements (SOC 2, PCI-DSS), dropping audit events is not acceptable and the channel overflow must result in the request being rejected rather than the audit event being dropped.

**Rate limiting interceptor at scale:** The `time/rate` limiter is per-process and per-key. It does not share state across replicas. For a service running 100 replicas, each replica allows 100 RPS on `GetProduct`, meaning the actual limit across the fleet is 10,000 RPS. A distributed rate limiter uses a shared token bucket in Redis (using `INCR` with TTL) or a gossip protocol to share quota across replicas. The choice between in-process (fast, eventually consistent across replicas) and distributed (slower, consistent) depends on how strict the rate limit needs to be and how much latency is acceptable in the limiter path.

**Prometheus metrics interceptor and the test gap:** The exercise uses `testutil.GatherAndCompare` to assert metric values. This is the correct way to test Prometheus metrics. A common mistake is using a mock or checking the counter object directly. `GatherAndCompare` tests the full pipeline: metric registration, observation, gathering, and exposition format. This test also catches metric name conflicts (registering the same metric name twice with a custom `prometheus.Registry` panics).

---
