## 111.2 Workload Identity with SPIFFE/SPIRE

**SPIFFE** (Secure Production Identity Framework For Everyone) provides a standard for service identity in dynamic environments. **SPIRE** is an open-source implementation.

### SPIFFE ID Format

A SPIFFE ID uniquely identifies a workload:

```
spiffe://trust-domain/path/to/workload
```

Examples:
```
spiffe://example.com/service/payments
spiffe://prod.example.com/namespace/default/service/api
spiffe://example.com/k8s/ns/production/sa/backend
```

### SPIRE Architecture

The SPIRE architecture diagram illustrates how the SPIRE server acts as the root CA, holding the trust bundle and registration API, while SPIRE agents run on each node to attest workload identity using platform-specific proofs (Kubernetes pod annotations, AWS instance identity documents). The agent presents the node's attestation to the server, receives a node SVID, and then issues workload SVIDs to locally attested pods via a Unix domain socket. This node-level attestation means individual pods never need cloud credentials or service account keys. Identity is derived entirely from the platform's cryptographic attestation chain.

```
┌──────────────────────────────────────────────────────────────┐
│                      SPIRE Server                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   Identity   │  │     CA       │  │  Registration│        │
│  │   Registry   │  │ (Signs SVIDs)│  │   API        │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
└──────────────────────────────────────────────────────────────┘
                            ↓
                    gRPC over mTLS
                            ↓
┌──────────────────────────────────────────────────────────────┐
│                     SPIRE Agent (Node)                       │
│                                                              │
│   ┌────────────────────────────────────────────────────┐     │
│   │              Workload API                          │     │
│   │ (Unix Domain Socket: /run/spire/sockets/agent.sock)│     │
│   └────────────────────────────────────────────────────┘     │
│            ↑                    ↑                    ↑       │
│   ┌────────┴──┐         ┌──────┴─────┐      ┌───────┴───┐    │
│   │ Service A │         │ Service B  │      │ Service C │    │
│   │(gets SVID)│         │ (gets SVID)│      │(gets SVID)│    │
│   └───────────┘         └────────────┘      └───────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Fetching SPIFFE Identity in Go

The Go client connects to the agent's workload API socket using the `go-spiffe` library. Its `workloadapi.X509Source` watches for SVID updates in the background, so the application automatically presents a fresh certificate before the current one expires, without a restart. The `tlsconfig` helpers build a `tls.Config` directly from the source, using the trust bundle delivered over the same workload API as the CA pool for peer verification. The result is mTLS between services where both sides prove their SPIFFE identity before any application data is exchanged.

```go
package main

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "log"
    "time"

    "github.com/spiffe/go-spiffe/v2/spiffeid"
    "github.com/spiffe/go-spiffe/v2/spiffetls/tlsconfig"
    "github.com/spiffe/go-spiffe/v2/workloadapi"
)

// SPIFFEClient wraps workload API access
type SPIFFEClient struct {
    source *workloadapi.X509Source
}

// NewSPIFFEClient creates a client that fetches identity from SPIRE agent
func NewSPIFFEClient(ctx context.Context) (*SPIFFEClient, error) {
    // Connect to SPIRE agent via Unix domain socket
    source, err := workloadapi.NewX509Source(
        ctx,
        workloadapi.WithClientOptions(
            workloadapi.WithAddr("unix:///run/spire/sockets/agent.sock"),
        ),
    )
    if err != nil {
        return nil, err
    }

    return &SPIFFEClient{source: source}, nil
}

// GetSVID returns the current X.509 SVID (SPIFFE Verifiable Identity Document)
func (c *SPIFFEClient) GetSVID() (*x509.Certificate, error) {
    svid, err := c.source.GetX509SVID()
    if err != nil {
        return nil, err
    }

    // SVID automatically rotates before expiration
    log.Printf("SVID expires at: %v", svid.Certificates[0].NotAfter)

    return svid.Certificates[0], nil
}

// GetTLSConfig returns a TLS config with automatic SVID rotation
func (c *SPIFFEClient) GetTLSConfig(serverID spiffeid.ID) *tls.Config {
    return tlsconfig.MTLSClientConfig(c.source, c.source, tlsconfig.AuthorizeID(serverID))
}

// GetServerTLSConfig returns server TLS config with client verification
func (c *SPIFFEClient) GetServerTLSConfig(authorizer tlsconfig.Authorizer) *tls.Config {
    return tlsconfig.MTLSServerConfig(c.source, c.source, authorizer)
}

// Close releases resources
func (c *SPIFFEClient) Close() error {
    return c.source.Close()
}

// Example usage
func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    client, err := NewSPIFFEClient(ctx)
    if err != nil {
        log.Fatalf("Failed to create SPIFFE client: %v", err)
    }
    defer client.Close()

    svid, err := client.GetSVID()
    if err != nil {
        log.Fatalf("Failed to get SVID: %v", err)
    }

    log.Printf("My SPIFFE ID: %s", svid.URIs[0])
    log.Printf("Certificate expires: %v", svid.NotAfter)
}
```

### Junior → FAANG: SPIFFE/SPIRE as a Workload Identity Vocabulary

SPIFFE/SPIRE is referenced frequently in zero-trust architecture discussions at FAANG companies. Understanding what it does, even if you have not implemented it, demonstrates that you are familiar with the current state of the art.

**Gap to close:** Understand what an SVID (SPIFFE Verifiable Identity Document) is. It is an X.509 certificate or JWT that encodes the service's identity as a SPIFFE URI (e.g., `spiffe://example.org/ns/default/sa/my-service`). The SVID is short-lived (typically 1 hour) and automatically renewed by the SPIRE agent running alongside each workload. The consuming service verifies the SVID using the SPIRE trust bundle (the CA certificate) to establish that the SVID was issued by the trusted SPIRE server.

**Interview framing:** When asked "how do services prove their identity to each other without static credentials?", describe SPIFFE/SPIRE: the SPIRE agent runs as a sidecar or DaemonSet, attests the workload identity (using Kubernetes service account, node identity, or hardware attestation), and issues short-lived X.509 SVIDs. Services use these SVIDs in mTLS connections. The short lifetime means a compromised SVID expires quickly without manual revocation.

### Senior @ FAANG: SPIFFE/SPIRE Infrastructure Design

At senior level, SPIFFE/SPIRE is infrastructure that you design, deploy, and operate. The decisions you make about trust domain design, attestor selection, and federation affect every service in your organization.

**Trust domain design:** The SPIFFE trust domain (`spiffe://example.org`) is the root of your workload identity namespace. Within it, SVIDs are namespaced by Kubernetes namespace, service account, and other attributes. Design the trust domain hierarchy to reflect your organizational boundaries: separate trust domains for production and staging (so staging credentials cannot be used in production), separate trust domains for different regulated environments. Trust domain federation allows controlled cross-domain trust for specific service pairs.

**Attestor selection and security properties:** SPIRE supports multiple attestors for verifying workload identity: Kubernetes service account attestor (verifies the pod's service account JWT against the Kubernetes API), AWS IID attestor (uses EC2 instance identity document), hardware attestors (TPM, etc.). The Kubernetes attestor is the most common in cloud-native deployments. Its security property is that an SVID is only issued to a pod with the correct Kubernetes service account, preventing unauthorized pods from obtaining another service's identity. Document the security assumptions and limits of your chosen attestor.

**SPIRE availability and DR:** SPIRE must be highly available: if the SPIRE server is unavailable and an SVID expires, services cannot renew and will fail to establish new connections. Design SPIRE for HA (multiple server instances with a replicated datastore), configure the SPIRE agent to cache SVIDs locally (connections can continue using cached SVIDs for the SVID lifetime even if the server is briefly unavailable), and have a DR procedure for SPIRE server recovery. SPIRE availability is a dependency for the availability of every service that uses it.

---
