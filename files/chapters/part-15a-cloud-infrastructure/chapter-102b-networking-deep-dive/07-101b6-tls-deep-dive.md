## 102B.6 TLS Deep Dive

### Why TLS (Not SSL)

SSL (Secure Sockets Layer) was developed by Netscape. SSL 1.0 was never published. SSL 2.0 (1995) and SSL 3.0 (1996) are both broken and must never be used. TLS 1.0 (1999) and 1.1 (2006) are deprecated. In 2023, all modern clients and servers use TLS 1.2 or TLS 1.3.

TLS provides:
- **Confidentiality**: data is encrypted in transit
- **Integrity**: data cannot be modified in transit without detection (AEAD encryption)
- **Authentication**: the server's identity is verified via X.509 certificate

### TLS 1.2 Handshake

The TLS 1.2 handshake requires two full round-trips before application data can flow. The client first advertises its capabilities, the server responds with its chosen parameters and certificate, and only then does the client send its key material. This means every new connection pays at minimum two network latency penalties before a single byte of payload is transmitted.

```
Client                              Server
  │                                    │
  │──ClientHello ─────────────────────►│  Supported cipher suites, TLS version,
  │  (random, ciphers, extensions)     │  client random, SNI extension
  │                                    │
  │◄──ServerHello ─────────────────────│  Chosen cipher suite, server random
  │◄──Certificate ─────────────────────│  Server's X.509 certificate chain
  │◄──ServerHelloDone ─────────────────│  "I'm done with my hello"
  │                                    │
  │  [Client validates certificate]    │
  │  [Client extracts server pubkey]   │
  │                                    │
  │──ClientKeyExchange ───────────────►│  Encrypted pre-master secret (RSA)
  │                                    │  OR ephemeral DH key share (ECDHE)
  │──ChangeCipherSpec ────────────────►│  "Switching to encrypted mode"
  │──Finished (encrypted) ────────────►│  HMAC of handshake transcript
  │                                    │
  │◄──ChangeCipherSpec ─────────────────│
  │◄──Finished (encrypted) ─────────────│
  │                                    │
  │════════ Encrypted Application Data ════════│
```

**RTT cost:** 2 full round-trips (ClientHello → ServerHelloDone, ClientKeyExchange → Finished).

### TLS 1.3 Improvements

TLS 1.3 (RFC 8446, 2018) made fundamental improvements:

**1-RTT handshake:** The client includes its key share in ClientHello. The server can respond with its key share and start sending encrypted data in the same round-trip.

```
Client                              Server
  │                                    │
  │──ClientHello ─────────────────────►│  Includes key_share extension
  │  + key_share (ECDHE key)          │
  │                                    │
  │◄──ServerHello ─────────────────────│  Includes key_share
  │◄──EncryptedExtensions ─────────────│  Encrypted from this point
  │◄──Certificate (encrypted) ─────────│
  │◄──CertificateVerify (encrypted) ───│
  │◄──Finished (encrypted) ─────────────│
  │                                    │
  │──Finished ────────────────────────►│
  │                                    │
  │════════ Application Data ════════│
```

**Forward secrecy by default:** TLS 1.3 removed RSA key exchange. Only ephemeral Diffie-Hellman (ECDHE) is supported. This means past communications cannot be decrypted even if the server's private key is later compromised.

**Removed weak cipher suites:** RC4, 3DES, SHA-1, MD5 - all gone. TLS 1.3 supports only 5 cipher suites, all modern AEAD ciphers (AES-GCM, ChaCha20-Poly1305).

### Certificate Chains

A certificate chain establishes trust from the leaf certificate to a trusted root CA.

```
Root CA (self-signed, in OS/browser trust store)
    │  signs
    ▼
Intermediate CA (cross-signed by root, provides operational separation)
    │  signs
    ▼
Leaf Certificate (issued to api.example.com, contains public key)
```

When a client validates a certificate, it builds the chain from leaf to a trusted root. Intermediate certificates are typically served by the server in the `Certificate` message (not present in the OS trust store by default).

**Common certificate mistakes:**
- Serving the leaf certificate without the intermediate chain → "certificate verify failed" on some clients
- Including the root CA in the served chain → unnecessary but harmless
- Certificate expiry → schedule renewals at 60-70% of lifetime, use Let's Encrypt's ACME automation

### SNI (Server Name Indication)

Before SNI, a TLS server could only host one certificate per IP address (the certificate must be presented before the HTTP Host header is read). SNI, an extension to the TLS ClientHello, includes the target hostname in plaintext, allowing the server to select the correct certificate.

This enables virtual hosting with TLS: one IP, multiple domains, each with its own certificate. All major CDNs and cloud load balancers rely on SNI.

**Privacy implication:** SNI is sent in plaintext, revealing the target hostname to anyone on the network path. ESNI (Encrypted SNI) and its successor ECH (Encrypted Client Hello) address this, but adoption is still limited.

### ALPN: Negotiating HTTP/2 vs HTTP/1.1

ALPN (Application-Layer Protocol Negotiation) is a TLS extension that negotiates the application protocol during the TLS handshake - eliminating a round-trip for protocol upgrade. The client sends a list of supported protocols (`h2`, `http/1.1`), and the server selects one.

Go's `net/http` automatically handles ALPN:

```go
// Go sets up ALPN automatically when using net/http with TLS.
// The default is ["h2", "http/1.1"].
// To restrict to HTTP/2 only:
srv := &http.Server{
    TLSConfig: &tls.Config{
        NextProtos: []string{"h2"}, // only HTTP/2
    },
}

// To restrict to HTTP/1.1 only (for debugging or compatibility):
srv := &http.Server{
    TLSConfig: &tls.Config{
        NextProtos: []string{"http/1.1"}, // only HTTP/1.1
    },
}
```

### mTLS: Mutual TLS

In standard TLS, only the server is authenticated (the server presents its certificate to the client). In mTLS (mutual TLS), both parties present certificates, giving cryptographic proof of identity to both sides.

mTLS is the foundation of zero-trust service meshes (Istio, Linkerd) and secure B2B integrations (Stripe Webhook signatures use mTLS-like verification).

```
Standard TLS:              mTLS:
Client verifies Server     Client verifies Server
                           Server verifies Client
```

```go
package mtls

import (
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net/http"
    "os"
    "time"
)

// NewMTLSServer creates an HTTP server that requires client certificate authentication.
// Only clients presenting a certificate signed by the specified CA are accepted.
func NewMTLSServer(addr, certFile, keyFile, clientCAFile string) (*http.Server, error) {
    // Load the CA certificate that signed client certificates.
    clientCA, err := os.ReadFile(clientCAFile)
    if err != nil {
        return nil, fmt.Errorf("read client CA: %w", err)
    }

    clientCAPool := x509.NewCertPool()
    if !clientCAPool.AppendCertsFromPEM(clientCA) {
        return nil, fmt.Errorf("parse client CA certificate")
    }

    // Load server certificate and key.
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("load server cert: %w", err)
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    clientCAPool,
        // RequireAndVerifyClientCert: require client cert AND verify it against ClientCAs.
        // Other options: NoClientCert, RequestClientCert, RequireAnyClientCert.
        ClientAuth: tls.RequireAndVerifyClientCert,
        MinVersion: tls.VersionTLS13,
        // Modern cipher suites only (TLS 1.3 enforces this automatically).
    }

    return &http.Server{
        Addr:      addr,
        TLSConfig: tlsConfig,
        Handler:   http.HandlerFunc(mtlsHandler),
    }, nil
}

func mtlsHandler(w http.ResponseWriter, r *http.Request) {
    // The client certificate is available after TLS verification.
    // At this point, we know the client is authenticated.
    if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
        http.Error(w, "no client certificate", http.StatusUnauthorized)
        return
    }

    clientCert := r.TLS.PeerCertificates[0]
    // Use CommonName or SAN for service identity.
    // In Kubernetes/Istio, this is typically the SPIFFE URI: spiffe://cluster.local/ns/default/sa/myservice
    serviceIdentity := clientCert.Subject.CommonName
    w.Header().Set("X-Client-Identity", serviceIdentity)
    fmt.Fprintf(w, "Authenticated as: %s\n", serviceIdentity)
}

// NewMTLSClient creates an HTTP client that presents a client certificate to servers.
func NewMTLSClient(certFile, keyFile, serverCAFile string) (*http.Client, error) {
    // Load the client certificate and key.
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("load client cert: %w", err)
    }

    // Load the CA that signed the server certificate.
    serverCA, err := os.ReadFile(serverCAFile)
    if err != nil {
        return nil, fmt.Errorf("read server CA: %w", err)
    }

    serverCAPool := x509.NewCertPool()
    if !serverCAPool.AppendCertsFromPEM(serverCA) {
        return nil, fmt.Errorf("parse server CA certificate")
    }

    tlsConfig := &tls.Config{
        Certificates: []tls.Certificate{cert}, // present our cert to the server
        RootCAs:      serverCAPool,             // trust this CA for server verification
        MinVersion:   tls.VersionTLS13,
    }

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10,
            IdleConnTimeout:     90 * time.Second,
        },
        Timeout: 30 * time.Second,
    }, nil
}
```

### Go TLS Configuration: Best Practices

Go's `crypto/tls` package exposes a rich `tls.Config` struct that controls every aspect of the TLS negotiation. The following configuration enforces a secure baseline (TLS 1.2 minimum, ECDHE-only cipher suites, HTTP/2 via ALPN, and dynamic certificate reloading), allowing certificates to be rotated without restarting the server process.

```go
package tlsutil

import (
    "crypto/tls"
    "sync"
)

// SecureTLSConfig returns a TLS configuration suitable for production servers.
func SecureTLSConfig(certFile, keyFile string) (*tls.Config, error) {
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, err
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},

        // Minimum TLS version. Never use TLS 1.0 or 1.1.
        MinVersion: tls.VersionTLS12,
        // Prefer TLS 1.3 where available. Go negotiates the highest mutual version.

        // Cipher suites for TLS 1.2 (TLS 1.3 ciphers are non-configurable in Go).
        // These are Go's defaults and are already excellent. Only override to restrict further.
        CipherSuites: []uint16{
            tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
            tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
        },

        // Prefer server cipher suite order (less critical in TLS 1.3).
        PreferServerCipherSuites: true,

        // ALPN protocols in preference order.
        NextProtos: []string{"h2", "http/1.1"},

        // For dynamic certificate reloading (zero-downtime cert rotation):
        GetCertificate: dynamicCertLoader(),
    }, nil
}

// dynamicCertLoader enables hot reloading of certificates without restart.
// Essential for services using short-lived Let's Encrypt certificates.
func dynamicCertLoader() func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
    var mu sync.RWMutex
    var current *tls.Certificate

    // In production, use a goroutine or fsnotify to reload on cert change.
    reload := func() error {
        cert, err := tls.LoadX509KeyPair("cert.pem", "key.pem")
        if err != nil {
            return err
        }
        mu.Lock()
        current = &cert
        mu.Unlock()
        return nil
    }

    if err := reload(); err != nil {
        panic(err)
    }

    return func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
        mu.RLock()
        defer mu.RUnlock()
        return current, nil
    }
}
```

### Common TLS Mistakes in Go

Even experienced Go developers fall into a handful of recurring TLS pitfalls that silently degrade security or reliability. The examples below illustrate the most damaging patterns (from disabling certificate verification entirely to creating a fresh `http.Client` on every request), along with the correct approach for each.

```go
// MISTAKE 1: Disabling certificate verification.
// This is NEVER acceptable in production - it defeats the purpose of TLS.
tlsConfig := &tls.Config{
    InsecureSkipVerify: true, // DO NOT DO THIS
}

// MISTAKE 2: Using the default http.Client for external services (no timeout).
resp, err := http.Get("https://api.example.com/") // no timeout - can hang forever

// MISTAKE 3: Not closing response bodies.
resp, _ := client.Get(url)
// missing: defer resp.Body.Close()
// missing: io.Copy(io.Discard, resp.Body)

// MISTAKE 4: Creating a new http.Client (and new TLS session cache) per request.
// This prevents TLS session resumption and connection pooling.
for _, url := range urls {
    client := &http.Client{} // DON'T DO THIS IN A LOOP
    client.Get(url)
}

// MISTAKE 5: Using TLS 1.0/1.1 or RC4 cipher suites.
tlsConfig := &tls.Config{
    MinVersion: tls.VersionTLS10,        // insecure
    CipherSuites: []uint16{tls.TLS_RSA_WITH_RC4_128_SHA}, // broken
}
```

---

### Junior → FAANG: TLS in Go and the Common Certificate Mistakes

TLS configuration in Go is more explicit than in many other languages. The `tls.Config` struct exposes every TLS parameter: minimum version, cipher suites, certificate verification, client certificate requirements. This explicitness is a feature: it prevents silent downgrade attacks and makes the security configuration auditable.

The most common TLS mistakes junior Go engineers make: setting `InsecureSkipVerify: true` in production (never acceptable, disables all certificate validation), not configuring a minimum TLS version (allowing TLS 1.0 or 1.1 connections from legacy clients), and not handling certificate expiry monitoring (services fail when certificates expire without warning).

For production Go services that make HTTPS connections, always verify the certificate against a trusted CA root, use TLS 1.2 as the minimum version (`MinVersion: tls.VersionTLS12`), and monitor certificate expiry with alerts at 30 days and 7 days before expiry. cert-manager in Kubernetes automates certificate provisioning and rotation, eliminating the manual expiry problem.

### Senior @ FAANG: TLS Architecture and mTLS for Zero-Trust Networks

At staff level, TLS is a network security boundary. In a zero-trust architecture, every service-to-service connection requires mTLS (mutual TLS), where both sides present certificates. This ensures that only authorized services can communicate, regardless of network position. A compromised pod cannot call other services without a valid certificate issued by the organization's internal CA.

Implementing mTLS organization-wide requires a certificate infrastructure: an internal CA (CFSSL, HashiCorp Vault, or a cloud CA service), a certificate issuance mechanism (cert-manager with the internal CA as an issuer, or a service mesh that issues certificates automatically), and certificate lifecycle management (rotation before expiry, revocation for compromised certificates).

The service mesh approach (Istio, Linkerd) automates mTLS without requiring application changes: the sidecar proxy handles certificate issuance, rotation, and mTLS negotiation transparently. The eBPF-based approach (Cilium) achieves similar results without a sidecar. Each approach has different operational complexity and performance characteristics that need to be evaluated for the organization's specific requirements and operational capabilities.

TLS session resumption (session tickets or session IDs) reduces the latency overhead of TLS for repeated connections to the same server. In a Go server, session resumption is handled automatically. The operational concern is session ticket key rotation: if the session ticket key is not rotated, an attacker who obtains the key can decrypt all past and future sessions encrypted with it. Automatic key rotation (controlled by the `SessionTicketKey` field or by using a shared key store for multi-instance deployments) is the production requirement for session ticket security.
