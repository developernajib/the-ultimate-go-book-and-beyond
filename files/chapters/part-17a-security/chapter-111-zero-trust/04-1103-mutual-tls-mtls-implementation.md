## 111.3 Mutual TLS (mTLS) Implementation

mTLS requires both client and server to present certificates. This provides bidirectional authentication.

### mTLS Server with Certificate Verification

TLS secures communication channels by providing authentication and encryption at the transport layer, critical for any service handling sensitive data. The following configuration demonstrates mutual TLS (mTLS) setup in Go, requiring both server and client certificate verification to prevent man-in-the-middle attacks.

```go
package main

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "log"
    "net/http"
    "os"
)

// MTLSServer provides mutual TLS authentication
type MTLSServer struct {
    certFile string
    keyFile  string
    caFile   string
}

// NewMTLSServer creates an mTLS server
func NewMTLSServer(certFile, keyFile, caFile string) *MTLSServer {
    return &MTLSServer{
        certFile: certFile,
        keyFile:  keyFile,
        caFile:   caFile,
    }
}

// LoadTLSConfig creates TLS configuration requiring client certificates
func (s *MTLSServer) LoadTLSConfig() (*tls.Config, error) {
    // Load server certificate
    cert, err := tls.LoadX509KeyPair(s.certFile, s.keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading server cert: %w", err)
    }

    // Load CA certificate for verifying client certs
    caCert, err := os.ReadFile(s.caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA cert: %w", err)
    }

    caCertPool := x509.NewCertPool()
    if !caCertPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    caCertPool,
        ClientAuth:   tls.RequireAndVerifyClientCert, // CRITICAL: require client cert
        MinVersion:   tls.VersionTLS13,               // Enforce TLS 1.3
        // Note: Go does not allow configuring TLS 1.3 cipher suites,
        // the CipherSuites field is ignored when 1.3 is negotiated.
        // Verify peer certificate
        VerifyPeerCertificate: func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
            if len(verifiedChains) == 0 {
                return fmt.Errorf("no verified certificate chains")
            }

            cert := verifiedChains[0][0]
            log.Printf("Client authenticated: CN=%s, Organization=%v",
                cert.Subject.CommonName, cert.Subject.Organization)

            // Additional custom validation can go here
            // E.g., check SPIFFE ID in SAN
            if len(cert.URIs) > 0 {
                log.Printf("Client SPIFFE ID: %s", cert.URIs[0])
            }

            return nil
        },
    }, nil
}

// Start begins the HTTPS server with mTLS
func (s *MTLSServer) Start(addr string) error {
    tlsConfig, err := s.LoadTLSConfig()
    if err != nil {
        return err
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/api/data", s.handleData)
    mux.HandleFunc("/health", s.handleHealth)

    server := &http.Server{
        Addr:      addr,
        TLSConfig: tlsConfig,
        Handler:   s.loggingMiddleware(mux),
    }

    log.Printf("Starting mTLS server on %s", addr)
    return server.ListenAndServeTLS("", "") // Certs already in TLSConfig
}

// handleData is an example protected endpoint
func (s *MTLSServer) handleData(w http.ResponseWriter, r *http.Request) {
    // Extract client identity from certificate
    if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
        http.Error(w, "No client certificate", http.StatusUnauthorized)
        return
    }

    clientCert := r.TLS.PeerCertificates[0]
    clientID := clientCert.Subject.CommonName

    // Authorization check based on identity
    if !s.isAuthorized(clientID, r.URL.Path) {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"message": "Hello %s", "authorized": true}`, clientID)
}

func (s *MTLSServer) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

// isAuthorized implements policy-based access control
func (s *MTLSServer) isAuthorized(clientID, path string) bool {
    // Example: simple RBAC
    policies := map[string][]string{
        "service-payment": {"/api/data", "/api/transactions"},
        "service-user":    {"/api/data"},
    }

    allowedPaths, exists := policies[clientID]
    if !exists {
        return false
    }

    for _, allowed := range allowedPaths {
        if allowed == path {
            return true
        }
    }
    return false
}

// loggingMiddleware logs request details
func (s *MTLSServer) loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        clientID := "unknown"
        if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
            clientID = r.TLS.PeerCertificates[0].Subject.CommonName
        }

        log.Printf("%s %s from client=%s", r.Method, r.URL.Path, clientID)
        next.ServeHTTP(w, r)
    })
}

func main() {
    server := NewMTLSServer("server.crt", "server.key", "ca.crt")
    if err := server.Start(":8443"); err != nil {
        log.Fatalf("Server failed: %v", err)
    }
}
```

### mTLS Client

The client side mirrors the server: it presents its own certificate via `Certificates` and verifies the server against the CA pool in `RootCAs`. `ServerName` pins the expected identity in the server's certificate, so a valid certificate for a different host is rejected.

```go
package main

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "io"
    "net/http"
    "os"
)

// MTLSClient provides mutual TLS client
type MTLSClient struct {
    client *http.Client
}

// NewMTLSClient creates a client with mTLS configuration
func NewMTLSClient(certFile, keyFile, caFile, serverName string) (*MTLSClient, error) {
    // Load client certificate
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("loading client cert: %w", err)
    }

    // Load CA certificate to verify server
    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("reading CA cert: %w", err)
    }

    caCertPool := x509.NewCertPool()
    if !caCertPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        RootCAs:      caCertPool,
        ServerName:   serverName,
        MinVersion:   tls.VersionTLS13,
    }

    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
    }

    return &MTLSClient{client: client}, nil
}

// Get performs authenticated GET request
func (c *MTLSClient) Get(url string) ([]byte, error) {
    resp, err := c.client.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
    }

    return io.ReadAll(resp.Body)
}

func main() {
    client, err := NewMTLSClient("client.crt", "client.key", "ca.crt", "localhost")
    if err != nil {
        fmt.Printf("Client init failed: %v\n", err)
        return
    }
    data, err := client.Get("https://localhost:8443/api/data")
    if err != nil {
        fmt.Printf("Request failed: %v\n", err)
        return
    }
    fmt.Printf("Received: %s\n", data)
}
```

### Junior → FAANG: Implementing mTLS Correctly in Go

mTLS is the foundational mechanism for service-to-service authentication in zero-trust architectures. Getting the Go `tls.Config` right is required knowledge for any senior backend interview.

**Gap to close:** Know the four key `tls.Config` fields for mTLS: `Certificates` (the server's or client's certificate and private key), `ClientAuth: tls.RequireAndVerifyClientCert` (on the server side, requires the client to present a valid certificate), `ClientCAs` (on the server side, the pool of CAs that are trusted to issue client certificates), and `RootCAs` (on the client side, the pool of CAs trusted to issue server certificates). Missing `ClientAuth` on the server means the client certificate is optional, which defeats mTLS.

**Common mistake:** Setting `InsecureSkipVerify: true` to work around certificate verification failures. This disables all TLS verification and is worse than plain HTTP in terms of security (it provides encryption but no authentication). Never use `InsecureSkipVerify` in production. Diagnose the actual certificate verification failure instead.

**Interview framing:** When implementing mTLS, describe the certificate lifecycle as well as the configuration: certificates are issued by a shared CA, rotated before expiry (SPIRE handles this automatically), and the CA trust bundle is distributed to all services. The mTLS handshake verifies both certificates against the shared CA. Authentication is complete before any application-layer code runs.

### Senior @ FAANG: mTLS at Scale: Certificate Distribution and Rotation

At senior level, mTLS is not about configuring one pair of services. It is about building infrastructure that provides mTLS to every service pair without per-service configuration.

**Service mesh as mTLS infrastructure:** Service meshes (Istio, Linkerd) provide mTLS between all services in the mesh automatically, without any changes to service code. The mesh sidecar handles the TLS handshake. Services communicate as if they were talking plain TCP. The sidecar encrypts and authenticates. This approach is the most practical path to universal mTLS in a large Kubernetes deployment. The trade-off is added latency (two extra network hops: service to sidecar, sidecar to sidecar) and operational complexity (managing the mesh control plane).

**Certificate revocation in mTLS:** Short-lived certificates (1 hour TTL from SPIRE) make revocation practical: a compromised certificate expires quickly without manual intervention. Long-lived certificates (months or years) require a revocation mechanism (CRL or OCSP) that services check before accepting a certificate. Design your certificate TTL based on your incident response capability: if you can detect and respond to a compromised service in under 1 hour, 1-hour TTL SVIDs provide effective revocation without an explicit mechanism.

**mTLS in a hybrid environment:** Organizations with both cloud-native services (Kubernetes) and legacy services (VMs, on-premises) need an mTLS strategy that works across environments. SPIRE with multiple attestors (Kubernetes attestor for pods, node attestor for VMs) can issue SVIDs to both. The SPIRE agent runs on each node and the VM, and services use the SVID for mTLS regardless of where they run. This provides consistent workload identity across a hybrid environment without separate credential systems.

---
