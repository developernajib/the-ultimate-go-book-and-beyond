## 102I.4 TLS 1.3 Internals and Mutual TLS (mTLS)

### 4.1 TLS 1.3 Handshake

The TLS 1.3 handshake completes in a single round-trip (1-RTT) compared to two for TLS 1.2, and allows the client to send application data in the same flight as the `Finished` message. Session resumption via Pre-Shared Keys (PSK) further reduces this to 0-RTT for reconnecting clients, though 0-RTT data is vulnerable to replay attacks so it should only carry idempotent requests. The diagram and code below illustrate both paths and show how to configure Go's `crypto/tls` for TLS 1.3-only operation.

```
TLS 1.3 Full Handshake (1-RTT):

Client                           Server
  │                                │
  │─── ClientHello ───────────────►│
  │    key_share (ECDH public key) │
  │    supported_versions: [1.3]   │
  │    cipher_suites               │
  │    signature_algorithms        │
  │                                │
  │◄── ServerHello ────────────────│
  │    key_share (server ECDH pub) │
  │    selected cipher suite       │
  │                                │
  │   [Both derive handshake keys] │
  │   ECDH(client_priv, srv_pub)   │
  │   → early_secret               │
  │   → handshake_secret           │
  │                                │
  │◄── EncryptedExtensions ────────│ (encrypted with handshake key)
  │◄── Certificate ────────────────│
  │◄── CertificateVerify ──────────│
  │◄── Finished ───────────────────│
  │                                │
  │   [Derive application keys]    │
  │                                │
  │─── Finished ──────────────────►│
  │─── HTTP Request ──────────────►│ ← same flight!
  │                                │
  │◄── HTTP Response ──────────────│

0-RTT (resumed session):
Client                           Server
  │─── ClientHello ───────────────►│
  │    pre_shared_key (PSK)        │
  │─── Early Data (0-RTT) ────────►│ ← request in FIRST packet!
  │◄── ServerHello ────────────────│
  │◄── Finished ───────────────────│
  │─── Finished ──────────────────►│
```

```go
package tlsinternals

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"sync/atomic"
	"time"
)

// TLS13Config creates a minimal TLS 1.3-only configuration.
func TLS13Config(cert tls.Certificate) *tls.Config {
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		MaxVersion:   tls.VersionTLS13,
		// TLS 1.3 cipher suites are fixed - this list is ignored for 1.3
		// but we set them for potential TLS 1.2 fallback scenarios
		CipherSuites: []uint16{
			tls.TLS_AES_128_GCM_SHA256,
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
		},
		CurvePreferences: []tls.CurveID{
			tls.X25519,    // fastest, most secure
			tls.CurveP256, // fallback
		},
	}
}

// TLS13ClientConfig creates a strict TLS 1.3 client configuration.
func TLS13ClientConfig(rootCAs *x509.CertPool) *tls.Config {
	return &tls.Config{
		RootCAs:    rootCAs,
		MinVersion: tls.VersionTLS13,
		// No ServerName - use SNI from request Host header
		InsecureSkipVerify: false,
	}
}

// GenerateSelfSignedCert creates a self-signed TLS certificate for testing.
func GenerateSelfSignedCert(hosts []string, validFor time.Duration) (tls.Certificate, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate key: %w", err)
	}

	notBefore := time.Now().Add(-time.Minute) // small grace period
	notAfter := notBefore.Add(validFor)

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"Go Test"},
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		} else {
			template.DNSNames = append(template.DNSNames, h)
		}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	privDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: privDER})

	return tls.X509KeyPair(certPEM, keyPEM)
}

// TLSSessionCache implements a session ticket key rotation mechanism.
// TLS 1.3 uses PSK (Pre-Shared Key) for session resumption.
type TLSSessionCache struct {
	cache tls.ClientSessionCache
}

// NewTLSSessionCache creates a bounded LRU session cache.
func NewTLSSessionCache(capacity int) *TLSSessionCache {
	return &TLSSessionCache{
		cache: tls.NewLRUClientSessionCache(capacity),
	}
}

// TLSConnectionInfo extracts handshake metadata from a connection.
type TLSConnectionInfo struct {
	Version            uint16
	CipherSuite        uint16
	NegotiatedProtocol string
	ServerName         string
	HandshakeComplete  bool
	PeerCertificates   int
	DidResume          bool
}

// InspectTLSConn extracts TLS state from a live connection.
func InspectTLSConn(conn *tls.Conn) TLSConnectionInfo {
	state := conn.ConnectionState()
	return TLSConnectionInfo{
		Version:            state.Version,
		CipherSuite:        state.CipherSuite,
		NegotiatedProtocol: state.NegotiatedProtocol,
		ServerName:         state.ServerName,
		HandshakeComplete:  state.HandshakeComplete,
		PeerCertificates:   len(state.PeerCertificates),
		DidResume:          state.DidResume,
	}
}

func (i TLSConnectionInfo) String() string {
	version := map[uint16]string{
		tls.VersionTLS10: "TLS 1.0",
		tls.VersionTLS11: "TLS 1.1",
		tls.VersionTLS12: "TLS 1.2",
		tls.VersionTLS13: "TLS 1.3",
	}[i.Version]

	cipher := tls.CipherSuiteName(i.CipherSuite)

	return fmt.Sprintf("Version=%s Cipher=%s ALPN=%q ServerName=%q Resumed=%v Certs=%d",
		version, cipher, i.NegotiatedProtocol, i.ServerName, i.DidResume, i.PeerCertificates)
}

// TLSHandshakeTimer measures TLS handshake latency.
func TLSHandshakeTimer(conn *tls.Conn) (time.Duration, TLSConnectionInfo, error) {
	start := time.Now()
	if err := conn.Handshake(); err != nil {
		return 0, TLSConnectionInfo{}, fmt.Errorf("TLS handshake: %w", err)
	}
	elapsed := time.Since(start)
	return elapsed, InspectTLSConn(conn), nil
}

// CertificateManager handles automatic certificate loading and rotation.
type CertificateManager struct {
	certFile string
	keyFile  string
	cert     atomic.Pointer[tls.Certificate]
}

// Note: for brevity we reference atomic.Pointer from sync/atomic (Go 1.19+)

// NewCertificateManager creates a certificate manager that hot-reloads certs.
func NewCertificateManager(certFile, keyFile string) (*CertificateManager, error) {
	cm := &CertificateManager{certFile: certFile, keyFile: keyFile}
	if err := cm.reload(); err != nil {
		return nil, err
	}
	return cm, nil
}

func (cm *CertificateManager) reload() error {
	cert, err := tls.LoadX509KeyPair(cm.certFile, cm.keyFile)
	if err != nil {
		return fmt.Errorf("load cert: %w", err)
	}
	cm.cert.Store(&cert)
	return nil
}

// GetCertificate implements tls.Config.GetCertificate for hot reload.
func (cm *CertificateManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return cm.cert.Load(), nil
}

// StartRotation periodically reloads certificates (for Let's Encrypt renewal).
func (cm *CertificateManager) StartRotation(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := cm.reload(); err != nil {
					log.Printf("cert reload failed: %v", err)
				} else {
					log.Println("certificate reloaded successfully")
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

// TLSConfig with hot-reload support.
func (cm *CertificateManager) TLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: cm.GetCertificate,
		MinVersion:     tls.VersionTLS13,
		NextProtos:     []string{"h2", "http/1.1"},
	}
}
```

### 4.2 mTLS (Mutual TLS) for Service-to-Service Authentication

Mutual TLS requires both parties to present and verify a certificate, turning every service-to-service connection into a cryptographically authenticated channel without needing API keys or tokens. The `MTLSServerConfig` and `MTLSClientConfig` helpers below load the certificate and CA bundle from disk, set `tls.RequireAndVerifyClientCert`, and optionally enforce custom constraints on the peer certificate such as required organization fields.

```go
package tlsinternals

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// MTLSConfig creates a mutual TLS configuration for service-to-service auth.
// Both client and server present certificates and verify each other.
func MTLSServerConfig(certFile, keyFile, caCertFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server cert: %w", err)
	}

	caCert, err := os.ReadFile(caCertFile)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caCertPool := x509.NewCertPool()
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    caCertPool,
		MinVersion:   tls.VersionTLS13,
		// Verify additional client cert constraints
		VerifyPeerCertificate: func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
			if len(verifiedChains) == 0 || len(verifiedChains[0]) == 0 {
				return fmt.Errorf("no verified certificate chain")
			}
			cert := verifiedChains[0][0]
			// Example: enforce specific organization
			if len(cert.Subject.Organization) == 0 {
				return fmt.Errorf("client cert must have organization")
			}
			return nil
		},
	}, nil
}

// MTLSClientConfig creates a client config that presents a certificate.
func MTLSClientConfig(certFile, keyFile, caCertFile, serverName string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client cert: %w", err)
	}

	caCert, err := os.ReadFile(caCertFile)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caCertPool := x509.NewCertPool()
	if !caCertPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caCertPool,
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS13,
	}, nil
}
```

### Junior → FAANG: TLS 1.3 vs TLS 1.2: The Practical Differences

TLS 1.3 makes three improvements that matter in practice. First, it reduces the handshake to 1 round trip (TLS 1.2 requires 2), cutting connection establishment latency by one network round trip. Second, it removes deprecated cipher suites (RSA key exchange, RC4, DES), leaving only AEAD ciphers that provide both encryption and authentication. Third, forward secrecy is mandatory: session keys are derived from ephemeral key exchanges, so a future compromise of the server's private key does not decrypt past sessions.

For interviews: when asked "what are the advantages of TLS 1.3 over 1.2?", the answer is: one less round trip, mandatory forward secrecy, and removal of weak cipher suites. When asked about the tradeoff of 0-RTT, the answer is: 0-RTT data is vulnerable to replay attacks (an attacker can replay the first packet to the server), so it should only be used for idempotent operations (GET requests, not POST requests that modify state).

### Senior @ FAANG: TLS Certificate Management and mTLS at Scale

At FAANG scale, TLS certificate management is a platform problem. Each service in a microservice fleet needs a certificate. Manual certificate rotation is not feasible at hundreds of services. The standard solution is a PKI (Public Key Infrastructure) service (HashiCorp Vault's PKI secrets engine, or cert-manager in Kubernetes) that issues short-lived certificates (24-48 hours) and rotates them automatically. Short certificate lifetimes reduce the impact of compromise: a stolen certificate expires within hours rather than the one-year validity of a manually managed certificate.

Mutual TLS (mTLS) extends the TLS model to authenticate both sides of a connection: the server presents a certificate to the client, and the client presents a certificate to the server. In a service mesh, mTLS is enforced at the proxy level, providing service-to-service authentication without requiring application code changes. The architectural decision at L6 is whether mTLS is enforced by the service mesh (transparent to applications) or by the application itself (requires every service to implement TLS client certificate handling). Service mesh enforcement is almost always the right choice for ease of operations and consistent policy enforcement, but requires the mesh itself to be trusted and auditable.

---
