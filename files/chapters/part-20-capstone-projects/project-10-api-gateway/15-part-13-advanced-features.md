## Part 13: Advanced Features

A production API gateway must handle more than plain HTTP requests. Modern applications rely on WebSocket connections for real-time features like chat and live updates, gRPC for high-performance service-to-service communication, and TLS for encrypting all traffic. In this section, we add WebSocket proxying that upgrades HTTP connections and bidirectionally copies messages between the client and the backend, as well as gRPC proxying using Go's standard reverse proxy. We also add TLS support so the gateway can terminate encrypted connections at the edge, keeping backend communication internal and simple.

### WebSocket Proxying

WebSocket connections enable bidirectional real-time communication between the server and browser clients over a persistent TCP connection. After the HTTP upgrade handshake, each connection is served by a pair of dedicated goroutines for reading and writing, which Go's scheduler handles efficiently at scale.

```go
// internal/gateway/websocket.go
package gateway

import (
    "net/http"
    "net/http/httputil"
    "net/url"

    "github.com/gorilla/websocket"
)

// WebSocketProxy creates a reverse proxy for WebSocket connections
func (s *Server) createWebSocketProxy(targetURL *url.URL) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Upgrade connection
        upgrader := websocket.Upgrader{
            CheckOrigin: func(r *http.Request) bool {
                return true // Configure CORS as needed
            },
        }

        clientConn, err := upgrader.Upgrade(w, r, nil)
        if err != nil {
            s.logger.Error("websocket upgrade failed", zap.Error(err))
            return
        }
        defer clientConn.Close()

        // Connect to backend
        backendURL := *targetURL
        backendURL.Scheme = "ws"

        backendConn, _, err := websocket.DefaultDialer.Dial(backendURL.String(), nil)
        if err != nil {
            s.logger.Error("backend websocket connection failed", zap.Error(err))
            return
        }
        defer backendConn.Close()

        // Bidirectional proxy
        errChan := make(chan error, 2)

        // Client -> Backend
        go func() {
            for {
                messageType, message, err := clientConn.ReadMessage()
                if err != nil {
                    errChan <- err
                    return
                }
                if err := backendConn.WriteMessage(messageType, message); err != nil {
                    errChan <- err
                    return
                }
            }
        }()

        // Backend -> Client
        go func() {
            for {
                messageType, message, err := backendConn.ReadMessage()
                if err != nil {
                    errChan <- err
                    return
                }
                if err := clientConn.WriteMessage(messageType, message); err != nil {
                    errChan <- err
                    return
                }
            }
        }()

        // Wait for error
        <-errChan
    })
}
```

### gRPC Proxying

The REST and gRPC interfaces expose the ML platform's capabilities to training pipelines, serving infrastructure, and human operators through typed, versioned contracts. Protobuf definitions for gRPC enable efficient binary serialization for high-throughput prediction serving while the REST API serves tooling and dashboards.

```go
// internal/gateway/grpc.go
package gateway

import (
    "fmt"
    "net/http"
    "strings"

    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

// IsGRPCRequest checks if request is gRPC
func IsGRPCRequest(r *http.Request) bool {
    return r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc")
}

// CreateGRPCHandler creates an HTTP/2 handler for gRPC
func (s *Server) createGRPCHandler() http.Handler {
    h2s := &http2.Server{}
    return h2c.NewHandler(s, h2s)
}
```

### TLS Configuration

The following configuration defines the deployment parameters for TLS Configuration, including resource allocation, environment-specific overrides, and dependency bindings. These settings are the primary operational knobs for tuning behavior between staging and production.

```go
// internal/gateway/tls.go
package gateway

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "os"
)

// LoadTLSConfig loads TLS configuration
func LoadTLSConfig(config *TLSConfig) (*tls.Config, error) {
    if !config.Enabled {
        return nil, nil
    }

    cert, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
    if err != nil {
        return nil, fmt.Errorf("load certificate: %w", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        MinVersion:   tls.VersionTLS12,
    }

    // Configure client authentication
    if config.ClientAuth != "" && config.ClientAuth != "none" {
        if config.CACertFile == "" {
            return nil, fmt.Errorf("ca_cert_file required for client auth")
        }

        caCert, err := os.ReadFile(config.CACertFile)
        if err != nil {
            return nil, fmt.Errorf("read CA cert: %w", err)
        }

        caCertPool := x509.NewCertPool()
        caCertPool.AppendCertsFromPEM(caCert)

        tlsConfig.ClientCAs = caCertPool

        switch config.ClientAuth {
        case "request":
            tlsConfig.ClientAuth = tls.RequestClientCert
        case "require":
            tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
        }
    }

    // Configure TLS version
    if config.MinVersion != "" {
        switch config.MinVersion {
        case "1.2":
            tlsConfig.MinVersion = tls.VersionTLS12
        case "1.3":
            tlsConfig.MinVersion = tls.VersionTLS13
        }
    }

    return tlsConfig, nil
}

// StartTLS starts the server with TLS
func (s *Server) StartTLS(tlsConfig *tls.Config) error {
    s.httpServer.TLSConfig = tlsConfig
    return s.httpServer.ListenAndServeTLS("", "")
}
```
