## 108.7 TLS Configuration in Go

TLS (Transport Layer Security) secures network communication. Go's `crypto/tls` package makes it easy to configure, but the defaults aren't always secure enough for production.

### Production-Ready TLS Server

TLS secures communication channels by providing authentication and encryption at the transport layer, critical for any service handling sensitive data. The following configuration demonstrates mutual TLS (mTLS) setup in Go, requiring both server and client certificate verification to prevent man-in-the-middle attacks.

```go
package main

import (
    "crypto/tls"
    "fmt"
    "log"
    "net/http"
    "time"
)

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Hello, TLS!")
    })

    // Production TLS configuration
    tlsConfig := &tls.Config{
        // Minimum TLS version - TLS 1.3 is recommended
        // TLS 1.3 cipher suites are not configurable (they are always secure)
        MinVersion: tls.VersionTLS13,

        // Note: PreferServerCipherSuites has been ignored since Go 1.17.
        // Go automatically applies the server's cipher suite preference.

        // CipherSuites only applies to TLS 1.2. When MinVersion is
        // TLS 1.3, these are unused. If you need TLS 1.2 compatibility,
        // set MinVersion to tls.VersionTLS12 and specify these:
        // CipherSuites: []uint16{
        //     tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        //     tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        //     tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
        //     tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
        // },

        // Curve preferences
        CurvePreferences: []tls.CurveID{
            tls.X25519,
            tls.CurveP256,
        },
    }

    server := &http.Server{
        Addr:         ":8443",
        Handler:      mux,
        TLSConfig:    tlsConfig,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    log.Println("Starting TLS server on :8443")
    // In production, use proper certificates from Let's Encrypt or your CA
    log.Fatal(server.ListenAndServeTLS("server.crt", "server.key"))
}
```

### TLS Client with Certificate Pinning

On the client side, replacing the system root pool with your own CA pool (a form of CA pinning) means the client only accepts server certificates issued by that specific CA, shrinking the trust surface from hundreds of public CAs to one you control. The commented `Certificates` field shows where a client certificate would be added for mutual TLS.

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

func main() {
    // Load CA certificate for verification
    caCert, err := os.ReadFile("ca.crt")
    if err != nil {
        panic(err)
    }

    caCertPool := x509.NewCertPool()
    caCertPool.AppendCertsFromPEM(caCert)

    // Configure TLS client
    tlsConfig := &tls.Config{
        RootCAs:    caCertPool,
        MinVersion: tls.VersionTLS13,

        // For mutual TLS (mTLS), provide client certificate
        // Certificates: []tls.Certificate{clientCert},
    }

    client := &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
    }

    resp, err := client.Get("https://secure-api.example.com/data")
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("Response: %s\n", body)
}
```

### Mutual TLS (mTLS)

mTLS requires both client and server to present certificates, providing strong authentication in both directions.

```go
// Server-side mTLS configuration
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS13,
    ClientAuth: tls.RequireAndVerifyClientCert,
    ClientCAs:  clientCACertPool, // Pool of trusted client CAs
}
```

### Junior → FAANG: TLS Configuration Is Not Just "Enable HTTPS"

Enabling TLS is necessary but not sufficient. Misconfigured TLS can provide false confidence while remaining vulnerable to protocol downgrade attacks, weak cipher suites, and expired certificates.

**Gap to close:** Know the difference between TLS 1.2 and TLS 1.3. TLS 1.3 is mandatory for new systems: it removes weak cipher suites entirely, mandates Perfect Forward Secrecy in all handshakes, and reduces handshake latency. Go's `crypto/tls` defaults to TLS 1.2 minimum with TLS 1.3 support. For new services, set `MinVersion: tls.VersionTLS13` to enforce TLS 1.3 only. Accept TLS 1.2 only if you have documented legacy client requirements.

**Common mistake:** Using self-signed certificates in production beyond a controlled internal PKI context. Self-signed certificates provide encryption but no authentication: a man-in-the-middle can substitute their own self-signed certificate and clients have no way to detect the substitution. Use certificates from a trusted CA (Let's Encrypt for public services, internal CA for internal services).

**Interview framing:** When asked "how do you configure a secure Go HTTP server?", mention: `tls.Config` with `MinVersion: tls.VersionTLS13`, certificates from a managed certificate authority, HSTS header to prevent protocol downgrade, and certificate rotation with monitoring for expiry. This four-point answer covers the critical configuration dimensions.

### Senior @ FAANG: TLS Infrastructure and Certificate Lifecycle Management

At senior level, TLS is an infrastructure concern that spans certificate issuance, rotation, monitoring, and incident response for certificate compromise.

**Automated certificate management:** Manual certificate rotation is an operational risk: certificates expire, humans forget, and outages result. Use ACME (Let's Encrypt protocol) automation for public certificates or cert-manager for Kubernetes workloads. The certificate rotation process must be: automated (no human action required), monitored (alert when a certificate has fewer than 30 days remaining), and tested (rotation is exercised regularly, not just when it fails). Document your certificate management infrastructure and the failure modes.

**mTLS for service-to-service communication:** In a zero-trust architecture, services verify each other's identity using mTLS (mutual TLS). Each service has a certificate issued by the internal CA, and each service verifies the other's certificate on every connection. This provides workload identity without requiring separate authentication credentials. The operational challenge is certificate issuance and rotation at scale: tools like SPIFFE/SPIRE automate this. Staff engineers design the mTLS architecture and the SPIFFE trust domain policy.

**TLS termination policy:** Decide where TLS terminates in your architecture. At the load balancer (TLS offloading) is simpler but means traffic between the load balancer and backend services is unencrypted if they share a network. End-to-end TLS (TLS re-encryption or pass-through) adds latency but maintains encryption throughout. For regulated environments (PCI DSS, HIPAA), end-to-end TLS may be required. Document the termination policy and its security rationale in your architecture documentation.

**Certificate pinning:** Certificate pinning (refusing to connect to servers that do not present a specific certificate or public key) provides additional protection against CA compromise but is operationally complex. If the pinned certificate expires or is revoked, connections fail until the pin is updated. For mobile clients, this requires an app update. Certificate pinning is appropriate for very high-security contexts (banking apps, corporate MDM clients) with robust operational processes for rotation. For most server-to-server communication, mTLS with CA verification is sufficient.

---
