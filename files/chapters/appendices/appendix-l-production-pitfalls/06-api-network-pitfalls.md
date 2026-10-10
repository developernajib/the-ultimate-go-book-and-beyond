## API & Network Pitfalls

Network communication across distributed services is fundamentally unreliable. Go's standard library provides high-performance HTTP and TCP primitives, but its default configurations prioritize backwards compatibility and local testing over production safety. Using default settings in production leads directly to thread pool starvation, port exhaustion, and denial-of-service vulnerabilities.

---

### 1. The `http.DefaultClient` Infinite Hang Trap

#### Root Cause Mechanics
The standard library's `http.DefaultClient` (and the package-level helpers `http.Get`, `http.Post`) is configured with `Timeout: 0`—meaning **no timeout at all**. If an upstream dependency experiences network degradation, drops packets, or stalls during TLS negotiation, the calling goroutine remains blocked indefinitely. Under production traffic, thousands of goroutines accumulate, exhausting system memory and file descriptors.

#### Vulnerable Code
```go
// DANGEROUS: http.Get uses http.DefaultClient with zero timeout!
func FetchUserStatus(userID string) (*Status, error) {
    resp, err := http.Get("https://api.internal/users/" + userID) // Hangs forever if upstream stalls!
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    // ...
}
```

#### Production-Grade Solution
```go
// FIX: Always configure custom Transport with granular connection, handshake, and idle timeouts
var productionHTTPClient = &http.Client{
    Timeout: 10 * time.Second, // Hard deadline covering entire request lifecycle
    Transport: &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   3 * time.Second,  // TCP connection timeout
            KeepAlive: 30 * time.Second, // TCP keep-alive probe interval
        }).DialContext,
        TLSHandshakeTimeout:   3 * time.Second,  // TLS negotiation ceiling
        ResponseHeaderTimeout: 5 * time.Second,  // Time to wait for response headers
        IdleConnTimeout:       90 * time.Second, // How long idle keep-alive connections persist
        MaxIdleConns:          200,              // Pool capacity across all hosts
        MaxIdleConnsPerHost:   50,               // Pool capacity per upstream host
    },
}
```

---

### 2. TCP Port Exhaustion & Connection Draining

#### Root Cause Mechanics
In HTTP/1.1, connections are reused via persistent `Keep-Alive` sockets. When your code closes an HTTP response body without reading all remaining bytes, the Go runtime cannot verify that the socket stream is clean. Instead of returning the connection to the idle pool, the runtime sends a TCP `RST` packet and forcibly destroys the socket. The operating system places the socket in the `TIME_WAIT` state for 60 seconds. Under heavy load, the host exhausts all 65,535 ephemeral ports, causing subsequent outbound connections to fail with `dial: cannot assign requested address`.

#### Vulnerable Code
```go
resp, err := client.Do(req)
if err != nil {
    return err
}
defer resp.Body.Close() // Fails to drain remaining bytes! Connection destroyed.
```

#### Production-Grade Solution
```go
resp, err := client.Do(req)
if err != nil {
    return err
}
defer func() {
    // Draining the body ensures the socket is cleanly returned to the connection pool
    _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20)) // Read up to 1MB
    _ = resp.Body.Close()
}()
```

---

### 3. Reading Unbounded Request Bodies (OOM DoS Vector)

#### Root Cause Mechanics
Calling `io.ReadAll(r.Body)` on an incoming HTTP request reads until EOF. A malicious or misconfigured client can send a chunked HTTP POST request with a 10GB body. `io.ReadAll` will continuously allocate heap memory to buffer the payload until the Go process is terminated by the kernel OOM killer.

#### Production-Grade Solution
```go
func SecureUploadHandler(w http.ResponseWriter, r *http.Request) {
    const maxPayloadSize = 2 << 20 // 2 Megabytes limit

    // http.MaxBytesReader wraps the body and returns an error if limit is exceeded
    r.Body = http.MaxBytesReader(w, r.Body, maxPayloadSize)
    
    payload, err := io.ReadAll(r.Body)
    if err != nil {
        http.Error(w, "request payload too large", http.StatusRequestEntityTooLarge)
        return
    }
    // Process safely...
}
```

---

### 4. gRPC Connection Pooling and Missing Deadlines

#### Root Cause Mechanics
gRPC runs over HTTP/2, multiplexing hundreds of concurrent RPC calls over a single long-lived TCP connection. Calling `grpc.Dial` inside a request handler destroys performance by opening redundant TCP connections and TLS handshakes. Furthermore, making gRPC calls with `context.Background()` leaves RPCs open indefinitely if the server hangs.

#### Production-Grade Solution
```go
// Maintain a single long-lived gRPC client connection for the lifetime of the application
var userClient pb.UserServiceClient

func initGRPC(target string) (*grpc.ClientConn, error) {
    conn, err := grpc.Dial(target,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second, // Send ping every 10s if idle
            Timeout:             3 * time.Second,  // Wait 3s for ping response
            PermitWithoutStream: true,
        }),
    )
    if err != nil {
        return nil, err
    }
    userClient = pb.NewUserServiceClient(conn)
    return conn, nil
}

// ALWAYS enforce an explicit RPC deadline:
func GetUserProfile(ctx context.Context, id string) (*pb.User, error) {
    rpcCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    return userClient.GetUser(rpcCtx, &pb.GetUserRequest{Id: id})
}
```
