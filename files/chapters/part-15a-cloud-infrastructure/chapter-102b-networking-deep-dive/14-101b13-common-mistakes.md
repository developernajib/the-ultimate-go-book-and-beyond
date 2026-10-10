## 102B.13 Common Mistakes

### Mistake 1: Single `http.Client` per request

Constructing a new `http.Client` on every call bypasses the connection pool entirely because each client owns its own `Transport` with a private pool of idle connections. As a result, every request performs a full TCP handshake and TLS negotiation even when the previous request to the same host completed successfully just milliseconds ago. The fix is a single package-level client shared across the lifetime of the process, configured with a production-grade `Transport` and an explicit timeout so the pool can be reused.

```go
// WRONG: Creates a new connection pool and TLS session cache for every request.
// Zero connection reuse. TLS handshake overhead on every request.
func fetchData(url string) ([]byte, error) {
    client := &http.Client{Timeout: 30 * time.Second} // new client per call
    resp, err := client.Get(url)
    ...
}

// RIGHT: Package-level client shared across all requests.
var httpClient = &http.Client{
    Transport: productionTransport(),
    Timeout:   30 * time.Second,
}

func fetchData(url string) ([]byte, error) {
    resp, err := httpClient.Get(url)
    ...
}
```

### Mistake 2: Not draining the response body

Go's HTTP client can only return a connection to the pool once all response body bytes have been consumed, because the connection's read position must be at the start of the next HTTP message. Closing the body without reading it leaves the connection in an unknown state and forces Go to discard it, negating the performance benefit of keep-alive pooling. The correct pattern uses `io.Copy(io.Discard, resp.Body)` before `Close()` so remaining bytes are read and discarded efficiently, returning the connection to the pool for reuse.

```go
// WRONG: Connection returned to pool with body unread.
// Subsequent request on this connection will read stale data.
resp, err := client.Get(url)
if err != nil { return err }
if resp.StatusCode != 200 {
    resp.Body.Close() // closes without reading - connection cannot be reused
    return fmt.Errorf("status %d", resp.StatusCode)
}

// RIGHT: Always drain before close.
resp, err := client.Get(url)
if err != nil { return err }
defer func() {
    io.Copy(io.Discard, resp.Body)
    resp.Body.Close()
}()
if resp.StatusCode != 200 {
    return fmt.Errorf("status %d", resp.StatusCode)
}
```

### Mistake 3: Using `http.DefaultClient` in production

`http.DefaultClient` is defined without any timeouts, so a single slow or unresponsive upstream can hold a goroutine open indefinitely, eventually exhausting the goroutine pool under load. Three independent timeouts should be configured: a dial timeout to bound TCP connection establishment, a `ResponseHeaderTimeout` to bound the wait for the first response byte, and an overall client `Timeout` that covers the full round trip including body transfer. Configuring all three together prevents any single network phase from silently hanging the process.

```go
// WRONG: http.DefaultClient has no timeout.
// A hanging upstream will block your goroutine forever.
resp, err := http.Get(url) // uses http.DefaultClient
resp, err := http.DefaultClient.Get(url)

// RIGHT: Always configure timeouts.
var client = &http.Client{
    Timeout: 30 * time.Second,
    Transport: &http.Transport{
        ResponseHeaderTimeout: 10 * time.Second,
        DialContext: (&net.Dialer{
            Timeout: 5 * time.Second,
        }).DialContext,
    },
}
```

### Mistake 4: Ignoring TCP_NODELAY for latency-sensitive services

The Nagle algorithm buffers small outgoing TCP segments hoping to coalesce them into a larger packet, and when combined with the receiver's delayed ACK (which waits up to 40 ms before acknowledging), the result is a 40 ms latency spike on small request-response exchanges such as Redis commands or MySQL queries. Go's `net/http` disables Nagle automatically on HTTP connections, but raw TCP servers and many database driver implementations do not. Calling `tc.SetNoDelay(true)` on every accepted `*net.TCPConn` ensures small frames are sent immediately without waiting for the Nagle timer.

```go
// For Redis, MySQL, gRPC, and other request-response protocols,
// the Nagle algorithm causes ~40ms latency spikes when combined with delayed ACKs.
//
// Go's net/http sets TCP_NODELAY automatically.
// Raw TCP servers and some database drivers do NOT.
//
// Always set TCP_NODELAY for custom TCP servers:
if tc, ok := conn.(*net.TCPConn); ok {
    tc.SetNoDelay(true) // disable Nagle
}
```

### Mistake 5: Incorrect mTLS configuration

`tls.RequireAnyClientCert` demands that the client present a certificate but performs no cryptographic verification against a trusted CA pool, meaning any self-signed or attacker-generated certificate will be accepted. This creates a false sense of mutual authentication, the TLS handshake completes successfully but the client's identity is entirely unverified. `tls.RequireAndVerifyClientCert` is the correct setting because it validates the client certificate's full chain against the `ClientCAs` pool, rejecting any certificate not signed by a trusted authority.

```go
// WRONG: ClientAuth = tls.RequireAnyClientCert accepts any certificate,
// including self-signed ones not signed by your CA.
// This does NOT verify the client's identity.
tlsConfig := &tls.Config{
    ClientAuth: tls.RequireAnyClientCert, // WRONG for authentication
}

// RIGHT: RequireAndVerifyClientCert validates the certificate against ClientCAs.
tlsConfig := &tls.Config{
    ClientAuth: tls.RequireAndVerifyClientCert,
    ClientCAs:  trustedClientCAPool, // MUST provide the CA pool
}
```

### Mistake 6: Using `time.Sleep` instead of proper connection draining

A fixed `time.Sleep` before `os.Exit` is a cargo-culted pattern that provides no guarantee: under low load all requests may finish in 1 ms, and under high load some may still be in-flight after 30 s. `http.Server.Shutdown` is the correct mechanism because it stops accepting new connections, waits for all active handlers to return, and only then unblocks, making the drain period adaptive rather than fixed. Pairing `Shutdown` with a context timeout ensures the process still exits even if a misbehaving handler never returns.

```go
// WRONG: time.Sleep does not guarantee in-flight requests complete.
signal.Notify(quit, syscall.SIGTERM)
<-quit
time.Sleep(5 * time.Second) // cargo-culted, no guarantee
os.Exit(0)

// RIGHT: Use http.Server.Shutdown() with a context timeout.
signal.Notify(quit, syscall.SIGTERM)
<-quit
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()
if err := srv.Shutdown(ctx); err != nil {
    log.Printf("Shutdown error: %v", err)
}
```

### Mistake 7: Hardcoding TLS version or cipher suites unnecessarily

The Go TLS stack is regularly updated to prefer modern authenticated-encryption ciphers (such as AES-GCM and ChaCha20-Poly1305) and to deprioritize weaker ones, so a hardcoded `CipherSuites` list locks the application to the security posture of the Go version it was compiled with and prevents future Go releases from automatically upgrading cipher selection. The only configuration that should be set explicitly is `MinVersion: tls.VersionTLS12` to prevent downgrade to TLS 1.0 or 1.1, while leaving cipher selection to the Go runtime to benefit from ongoing security improvements without code changes.

```go
// WRONG: Specifying specific cipher suites unless you have a compliance requirement.
// Go's defaults are already excellent and updated with each release.
// Hardcoded lists may accidentally disable better ciphers added in future Go versions.
tlsConfig := &tls.Config{
    CipherSuites: []uint16{
        tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, // only this suite
    },
}

// RIGHT: Set minimum version, let Go select optimal ciphers.
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS12,
    // Go will use the best available cipher suites automatically.
}
```

---

### Junior → FAANG: Common Networking Mistakes as a Pre-Code Review Checklist

Before submitting any code that makes HTTP requests or serves HTTP responses, run through the common mistakes in this section as a checklist: Am I creating a new HTTP client per request? Am I forgetting to close response bodies? Am I using `http.DefaultClient` with no timeouts? Am I ignoring context cancellation?

The context cancellation point is particularly important for Go services that serve HTTP requests and make downstream HTTP calls: when the client cancels the upstream request (navigation away, timeout, explicit cancel), the context passed to downstream calls should be canceled too. This prevents wasteful computation and resource consumption for canceled requests. Using `req.Context()` when making downstream calls ensures proper propagation.

### Senior @ FAANG: Networking Mistakes at Organizational Scale

At staff level, common networking mistakes become code review standards and linting rules. The "creating an HTTP client per request" mistake can be detected by a custom golangci-lint rule that flags `&http.Client{}` or `http.NewRequest` outside of initialization functions. The "missing timeout" mistake can be detected by a rule that warns when `http.Client{}` is used without `Timeout` set.

Encoding these common mistakes as automated linting rules converts individual knowledge into organizational standards. A new engineer who has never read this chapter will still get a linting warning when they create an HTTP client per request, because the organizational standard is encoded in the linter configuration. This is the mechanism that scales networking best practices from individual knowledge to team-wide consistency.
