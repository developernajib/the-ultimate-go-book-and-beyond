## 102G.10 Zero-Trust Microservices with mTLS

### SPIFFE/SPIRE Workload Identity

Zero-trust networking for microservices requires that every service authenticate its identity to every other service on every request, rather than trusting based on network location. SPIFFE (Secure Production Identity Framework for Everyone) is the standard that defines workload identities as URI-shaped SVIDs (SPIFFE Verifiable Identity Documents), and SPIRE is its reference implementation. Each workload receives a short-lived X.509 certificate from the SPIRE agent, which is renewed automatically before expiry, enabling mutual TLS between services without hardcoded credentials or long-lived secrets.

```
SPIFFE (Secure Production Identity Framework for Everyone):
  Standard for workload identity in cloud-native environments.
  Each workload gets a SPIFFE ID: spiffe://trust-domain/path
  Example: spiffe://myorg.com/ns/production/sa/shopapp-api

SPIRE (SPIFFE Runtime Environment):
  SPIRE Server: issues SVIDs (SPIFFE Verifiable Identity Documents)
  SPIRE Agent: runs on each node, fetches SVIDs for workloads

  SVIDs are short-lived X.509 certificates (~1 hour TTL):
  - Subject: SPIFFE ID (spiffe://myorg.com/ns/production/sa/shopapp-api)
  - SANs: include the SPIFFE ID as URI SAN
  - Auto-rotated by SPIRE agent before expiry
```

### mTLS Server and Client in Go

Implementing mTLS in Go means configuring both the server and the client to present and verify X.509 certificates. The server sets `ClientAuth: tls.RequireAndVerifyClientCert` and loads the CA certificate bundle used to verify client identities. The client loads its own certificate and private key for presentation, and optionally verifies the server's SPIFFE ID from the presented certificate's URI SAN field to confirm it is talking to the intended peer. In a SPIRE-based environment, both certificate and private key are obtained from the Workload API rather than from static files, which means they rotate automatically without a service restart.

```go
package mtls

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "fmt"
    "net/http"
    "os"
    "time"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

// Server starts an mTLS HTTP server using SPIRE-issued certificates
func StartMTLSServer(ctx context.Context, addr string, handler http.Handler) error {
    // Connect to SPIRE agent's workload API socket
    source, err := workloadapi.NewX509Source(ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        return fmt.Errorf("connect to SPIRE: %w", err)
    }
    defer source.Close()

    // Only allow connections from services in our trust domain
    tlsConfig := tlsconfig.MTLSServerConfig(
        source,
        source,
        tlsconfig.AuthorizeAny(), // or use AuthorizeMemberOf for specific trust domains
    )

    server := &http.Server{
        Addr:      addr,
        Handler:   handler,
        TLSConfig: tlsConfig,
    }

    return server.ListenAndServeTLS("", "") // certificates from SPIRE, not files
}

// Client creates an HTTP client that authenticates with mTLS
func NewMTLSClient(ctx context.Context, serverSPIFFEID string) (*http.Client, error) {
    source, err := workloadapi.NewX509Source(ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        return nil, fmt.Errorf("connect to SPIRE: %w", err)
    }

    // Parse expected server SPIFFE ID
    serverID, err := spiffeid.IDFromString(serverSPIFFEID)
    if err != nil {
        return nil, fmt.Errorf("parse server SPIFFE ID: %w", err)
    }

    tlsConfig := tlsconfig.MTLSClientConfig(
        source,
        source,
        tlsconfig.AuthorizeID(serverID), // only accept this specific SPIFFE ID
    )

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: tlsConfig,
        },
        Timeout: 30 * time.Second,
    }, nil
}

// Manual mTLS without SPIRE (certificate files)
func ManualMTLSServer(certFile, keyFile, caFile string) (*tls.Config, error) {
    // Load server certificate
    cert, err := tls.LoadX509KeyPair(certFile, keyFile)
    if err != nil {
        return nil, fmt.Errorf("load server cert: %w", err)
    }

    // Load CA for client certificate verification
    caCert, err := os.ReadFile(caFile)
    if err != nil {
        return nil, fmt.Errorf("read CA cert: %w", err)
    }

    caPool := x509.NewCertPool()
    if !caPool.AppendCertsFromPEM(caCert) {
        return nil, fmt.Errorf("failed to parse CA certificate")
    }

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientAuth:   tls.RequireAndVerifyClientCert, // require client cert
        ClientCAs:    caPool,
        MinVersion:   tls.VersionTLS13,
        CipherSuites: []uint16{
            tls.TLS_AES_256_GCM_SHA384,
            tls.TLS_CHACHA20_POLY1305_SHA256,
        },
    }, nil
}
```

### Zero-Trust HTTP Middleware

A zero-trust HTTP middleware extracts the verified client SPIFFE ID from the TLS peer certificate on every request and enforces an allowlist of authorized callers. Because mTLS provides cryptographic proof of the caller's identity at the transport layer, this middleware can make authorization decisions without consulting an external identity service. The extracted SPIFFE ID is added to the request context so that downstream handlers can use it for audit logging and fine-grained permission checks.

```go
package middleware

import (
    "context"
    "crypto/x509"
    "fmt"
    "net/http"
)

type contextKey string
const callerIDKey contextKey = "caller_spiffe_id"

// ZeroTrustMiddleware verifies mTLS client certificates and extracts SPIFFE ID
func ZeroTrustMiddleware(allowedCallers []string) func(http.Handler) http.Handler {
    allowed := make(map[string]bool)
    for _, c := range allowedCallers {
        allowed[c] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // mTLS: client certificate must be present
            if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
                http.Error(w, "client certificate required", http.StatusUnauthorized)
                return
            }

            // Extract SPIFFE ID from client certificate's URI SAN
            clientCert := r.TLS.PeerCertificates[0]
            spiffeID, err := extractSPIFFEID(clientCert)
            if err != nil {
                http.Error(w, "invalid client certificate", http.StatusUnauthorized)
                return
            }

            // Authorize: only known services allowed
            if len(allowed) > 0 && !allowed[spiffeID] {
                http.Error(w, fmt.Sprintf("caller %q not authorized", spiffeID), http.StatusForbidden)
                return
            }

            // Attach caller identity to context
            ctx := context.WithValue(r.Context(), callerIDKey, spiffeID)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func extractSPIFFEID(cert *x509.Certificate) (string, error) {
    for _, uri := range cert.URIs {
        if uri.Scheme == "spiffe" {
            return uri.String(), nil
        }
    }
    return "", fmt.Errorf("no SPIFFE ID in certificate")
}

// GetCallerID retrieves the caller's SPIFFE ID from context
func GetCallerID(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(callerIDKey).(string)
    return id, ok
}
```

---

### Junior → FAANG: Zero Trust as an Interview Concept and a First-Job Reality

"Zero trust" is frequently misused in interviews to mean "we use TLS." True zero trust means no implicit trust based on network location: a service inside the cluster must authenticate to another service inside the cluster with the same rigor as a service connecting from the public internet. mTLS with SPIFFE workload identities is the implementation of that principle.

The SPIFFE ID format (`spiffe://trust-domain/path`) encodes meaningful information: the trust domain (your organization), the namespace, and the service account. When the `ZeroTrustMiddleware` extracts this ID and checks it against an allowlist, it is enforcing that only specific services (identified cryptographically, not by IP or hostname) can call this endpoint. This is authorization based on identity, not based on network position.

Prerequisite gap: juniors often conflate TLS (encryption and server authentication) with mTLS (mutual authentication, where both sides present certificates). Standard HTTPS is one-way: the client verifies the server's certificate but does not present its own. mTLS adds the client certificate requirement, enabling the server to verify who is calling it. The `ClientAuth: tls.RequireAndVerifyClientCert` line is the field that enables mutual authentication.

First-job interview framing: when asked "how do you secure service-to-service communication," the complete answer is: mTLS for authentication and encryption (using SPIFFE/SPIRE for automatic certificate management), network policies to restrict which pods can initiate connections to which services, and application-layer authorization (the SPIFFE ID allowlist in the middleware) to enforce business-level access control beyond transport security.

### Senior @ FAANG: SPIRE as Platform Infrastructure and Certificate Lifecycle Governance

SPIRE is the most operationally complex component in this chapter because it is the trust anchor for the entire zero-trust system. If SPIRE is unavailable, new service connections cannot be established (new certificates cannot be issued). If SPIRE issues an incorrect certificate, a service can impersonate another service. The operational maturity requirements are correspondingly high.

The SPIRE server must run in HA mode with a clustered backend (typically etcd or an external database for the certificate store). The SPIRE agent runs as a DaemonSet on every node and must be available for workloads to obtain certificates at startup. A SPIRE agent restart should not interrupt running workloads (connections using already-issued certificates remain valid), but new pods starting during an agent outage cannot obtain their initial certificate. The platform team's on-call runbook must define: how long certificate issuance can be unavailable before it constitutes an incident, and what the procedure is for emergency certificate issuance if SPIRE is unavailable.

The TTL policy for SVID certificates is a governance decision with security implications. The Go-SPIFFE library's `workloadapi.NewX509Source` handles automatic rotation, so short TTLs (1 hour) are operationally feasible without manual rotation. Shorter TTLs reduce the window of exposure if a private key is compromised. The trade-off is that shorter TTLs increase the load on the SPIRE server (more certificate issuance events). At FAANG scale with thousands of workloads, the SPIRE server's issuance throughput must be capacity planned against the TTL.

The `AuthorizeAny()` vs `AuthorizeID()` choice in the SPIRE client configuration is a significant authorization decision that deserves its own ADR. `AuthorizeAny` allows any workload in the trust domain to connect. `AuthorizeID` enforces explicit peer identity verification. For internal APIs that should only be called by specific services, `AuthorizeID` is the correct choice. `AuthorizeAny` is appropriate only for services that intentionally accept connections from any authenticated workload in the trust domain, such as a telemetry collector. This distinction is often glossed over in implementations but matters for lateral movement containment: with `AuthorizeAny`, a compromised workload can connect to any other service in the cluster using its legitimate SPIFFE ID.

The middleware's allowlist hardcoding (`allowedCallers` as a string slice) is a starting point, not a production implementation. At scale, the authorization policy needs to come from a policy store (OPA, or a dedicated AuthZ service) rather than being compiled into the binary. When a new service needs to call an existing service, the change should be a policy update, not a code change and redeploy of the called service. A staff engineer designing this system should propose a policy management layer that externalizes the SPIFFE ID allowlist into a configurable, auditable policy store.

