## 7. Network Optimization

Network calls are expensive. Optimize round trips and connection usage.

### 7.1 Keep-Alive Settings

**HTTP Keep-Alive**:

```go
package main

import (
    "net"
    "net/http"
    "time"
)

func newHTTPClientWithKeepalive() *http.Client {
    return &http.Client{
        Transport: &http.Transport{
            // Enable keep-alive
            DisableKeepAlives: false,

            // Connection pooling
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10,
            IdleConnTimeout:     90 * time.Second,

            // TCP keep-alive
            DialContext: (&net.Dialer{
                Timeout:   30 * time.Second,
                KeepAlive: 30 * time.Second, // Send keep-alive probes
            }).DialContext,

            // Response header timeout
            ResponseHeaderTimeout: 10 * time.Second,

            // Expect-Continue timeout
            ExpectContinueTimeout: 1 * time.Second,
        },
    }
}

// Server-side keep-alive
func startServerWithKeepalive() {
    server := &http.Server{
        Addr:              ":8080",
        ReadTimeout:       10 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       120 * time.Second, // Keep-alive timeout
        ReadHeaderTimeout: 5 * time.Second,

        // Enable keep-alive
        SetKeepAlivesEnabled: true,
    }

    server.ListenAndServe()
}
```

### 7.2 Connection Reuse

**Ensuring Connection Reuse**:

```go
package main

import (
    "io"
    "net/http"
)

// Bad: Doesn't close body, connections leak
func requestBad(url string) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    // Missing: resp.Body.Close()
    return nil
}

// Good: Always close body
func requestGood(url string) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    // Read and discard body (required for connection reuse!)
    io.Copy(io.Discard, resp.Body)

    return nil
}

// Better: Use context and handle errors
func requestBetter(ctx context.Context, url string) error {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    // Check status
    if resp.StatusCode != http.StatusOK {
        // Still need to drain body for connection reuse
        io.Copy(io.Discard, resp.Body)
        return fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    // Process response
    data, err := io.ReadAll(resp.Body)
    if err != nil {
        return err
    }

    processData(data)
    return nil
}
```

### 7.3 HTTP/2 Tuning

**HTTP/2 Optimization**:

```go
package main

import (
    "crypto/tls"
    "golang.org/x/net/http2"
    "net/http"
)

func newHTTP2Client() *http.Client {
    // Configure HTTP/2
    transport := &http.Transport{
        TLSClientConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
        },
    }

    // Enable HTTP/2
    if err := http2.ConfigureTransport(transport); err != nil {
        panic(err)
    }

    return &http.Client{
        Transport: transport,
    }
}

// HTTP/2 server
func startHTTP2Server() {
    server := &http.Server{
        Addr: ":8443",
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS12,
            CipherSuites: []uint16{
                tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
                tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            },
        },
    }

    // HTTP/2 is automatic with TLS
    server.ListenAndServeTLS("cert.pem", "key.pem")
}

// HTTP/2 push
func handleWithPush(w http.ResponseWriter, r *http.Request) {
    // Push related resources
    if pusher, ok := w.(http.Pusher); ok {
        // Push CSS
        if err := pusher.Push("/style.css", nil); err != nil {
            // Handle error
        }

        // Push JavaScript
        if err := pusher.Push("/app.js", nil); err != nil {
            // Handle error
        }
    }

    // Serve main page
    w.Write([]byte("<html>...</html>"))
}
```

### 7.4 gRPC Optimization

**gRPC Performance Tuning**:

```go
package main

import (
    "google.golang.org/grpc"
    "google.golang.org/grpc/keepalive"
    "time"
)

func newOptimizedGRPCClient(target string) (*grpc.ClientConn, error) {
    return grpc.Dial(target,
        // Connection pooling
        grpc.WithDefaultCallOptions(
            grpc.MaxCallRecvMsgSize(10 * 1024 * 1024), // 10MB
            grpc.MaxCallSendMsgSize(10 * 1024 * 1024),
        ),

        // Keep-alive
        grpc.WithKeepaliveParams(keepalive.ClientParameters{
            Time:                10 * time.Second,
            Timeout:             3 * time.Second,
            PermitWithoutStream: true,
        }),

        // Connection timeout
        grpc.WithConnectParams(grpc.ConnectParams{
            Backoff: backoff.DefaultConfig,
            MinConnectTimeout: 5 * time.Second,
        }),

        // Compression
        grpc.WithDefaultCallOptions(grpc.UseCompressor("gzip")),

        // Load balancing
        grpc.WithDefaultServiceConfig(`{"loadBalancingPolicy":"round_robin"}`),
    )
}

func newOptimizedGRPCServer() *grpc.Server {
    return grpc.NewServer(
        // Connection limits
        grpc.MaxConcurrentStreams(1000),

        // Keep-alive
        grpc.KeepaliveParams(keepalive.ServerParameters{
            Time:    10 * time.Second,
            Timeout: 3 * time.Second,
        }),

        // Keep-alive enforcement
        grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
            MinTime:             5 * time.Second,
            PermitWithoutStream: true,
        }),

        // Message size
        grpc.MaxRecvMsgSize(10 * 1024 * 1024),
        grpc.MaxSendMsgSize(10 * 1024 * 1024),
    )
}

// Streaming for large data
func (s *server) StreamData(stream pb.DataService_StreamDataServer) error {
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            return nil
        }
        if err != nil {
            return err
        }

        // Process request
        resp := processRequest(req)

        // Send response
        if err := stream.Send(resp); err != nil {
            return err
        }
    }
}
```

---
