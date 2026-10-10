## Section 6: gRPC TLS, mTLS, and Security

### 6.1 TLS Configuration

Securing gRPC with TLS prevents eavesdropping and enables mutual authentication. Server-side TLS requires loading a certificate and key with `credentials.NewServerTLSFromFile`. Mutual TLS additionally requires the server to verify the client certificate against a CA.

```go
package grpcsecurity

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

// ServerTLSCredentials creates server-side TLS credentials.
func ServerTLSCredentials(certFile, keyFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server cert/key: %w", err)
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
	}

	return credentials.NewTLS(tlsConfig), nil
}

// mTLSServerCredentials creates mutual TLS credentials.
// Both client and server must present a certificate signed by the CA.
func mTLSServerCredentials(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load server cert/key: %w", err)
	}

	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    caPool,
		MinVersion:   tls.VersionTLS13,
	}

	return credentials.NewTLS(tlsConfig), nil
}

// mTLSClientCredentials creates client-side mTLS credentials.
func mTLSClientCredentials(certFile, keyFile, caFile string) (credentials.TransportCredentials, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load client cert/key: %w", err)
	}

	caCert, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("read CA cert: %w", err)
	}

	caPool := x509.NewCertPool()
	if !caPool.AppendCertsFromPEM(caCert) {
		return nil, fmt.Errorf("parse CA cert")
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS13,
	}

	return credentials.NewTLS(tlsConfig), nil
}

// NewSecureServer builds a gRPC server with mTLS.
func NewSecureServer(certFile, keyFile, caFile string) (*grpc.Server, error) {
	creds, err := mTLSServerCredentials(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}

	return grpc.NewServer(
		grpc.Creds(creds),
		grpc.ChainUnaryInterceptor(
			authInterceptorFromCert, // extract subject from peer certificate
		),
	), nil
}

// authInterceptorFromCert extracts the client identity from the mTLS peer certificate.
func authInterceptorFromCert(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	p, ok := peer.FromContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "no peer info")
	}

	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 {
		return nil, status.Error(codes.Unauthenticated, "no client certificate")
	}

	subject := tlsInfo.State.PeerCertificates[0].Subject.CommonName
	ctx = context.WithValue(ctx, clientIDKey{}, subject)
	return handler(ctx, req)
}

type clientIDKey struct{}
```

### 6.2 SPIFFE / SPIRE for Workload Identity

Rotating mTLS certificates by hand does not scale. In production, workload identity is issued by a control plane that mints short-lived SPIFFE IDs (e.g., `spiffe://prod.example.com/ns/orders/sa/order-service`) via SPIRE, Istio citadel, or Linkerd's identity service. Each pod receives a certificate valid for minutes, and the gRPC server validates the peer's SPIFFE URI SAN instead of `CommonName` - giving cryptographic service identity with automatic rotation. For Kubernetes, `spiffe/go-spiffe/v2` plugs directly into gRPC `credentials.TransportCredentials`.

```go
// Pseudocode: validate a SPIFFE ID from the peer certificate URI SANs.
func spiffeAuthorize(expected string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		p, _ := peer.FromContext(ctx)
		tlsInfo := p.AuthInfo.(credentials.TLSInfo)
		for _, cert := range tlsInfo.State.PeerCertificates {
			for _, u := range cert.URIs {
				if u.String() == expected {
					return handler(ctx, req)
				}
			}
		}
		return nil, status.Error(codes.PermissionDenied, "spiffe id not authorized")
	}
}
```

---

### Junior → FAANG: TLS vs mTLS and What Each Actually Proves

Standard TLS (one-way TLS) proves only that the server is who it claims to be. The client validates the server's certificate against a trusted CA and proceeds if valid. The server has no cryptographic proof of who the client is. This is appropriate for public APIs where clients are anonymous or identify themselves via application-layer tokens (JWT, API keys).

Mutual TLS adds a layer: the server also validates the client's certificate. If the certificate is signed by the shared CA and the server trusts that CA, the client is authenticated at the transport layer without any application-layer token. This is appropriate for service-to-service gRPC in a zero-trust network where you want to eliminate the token-in-metadata pattern entirely and rely on certificate-based identity.

The first-job pitfall is assuming that because your services run inside a Kubernetes cluster, they are on a "trusted network" and TLS is unnecessary. Modern security practice treats the internal network as untrusted: a compromised pod on the same network can sniff unencrypted gRPC traffic, which is binary protobuf and therefore readable with a proto schema. Always run TLS on gRPC, even for internal services.

`tls.VersionTLS13` is the correct minimum. TLS 1.2 has cipher suite vulnerabilities that TLS 1.3 eliminates. There is no valid reason to support TLS 1.2 for a new internal service in 2026.

### Senior @ FAANG: Zero-Trust Architecture, Certificate Rotation, and SPIFFE at Platform Scale

mTLS with static certificates is a step up from no mutual auth, but it introduces a lifecycle problem: certificates expire, and rotating them manually across a fleet of hundreds of services is error-prone and slow. The failure mode is severe: when a certificate expires in production, every RPC between affected services fails with an auth error until the cert is rotated. This is a high-severity incident with a clear root cause but an unnecessarily high cost.

SPIFFE (Secure Production Identity Framework for Everyone) and SPIRE (the reference implementation) solve this by treating workload identity as a platform-managed primitive rather than a per-service operational task. SPIRE runs a server that issues short-lived X.509 SVIDs (SPIFFE Verifiable Identity Documents) to workloads via a node agent. Each SVID has a URI SAN of the form `spiffe://trust-domain/ns/namespace/sa/service-account`. The SVID is valid for minutes to hours, not years. The node agent rotates it automatically before expiry. From the application perspective, the cert-loading code is replaced by a SPIFFE workload API call that returns a rotating credential, and the gRPC `credentials.TransportCredentials` implementation handles the rotation transparently.

The authorization half of zero-trust is separate from the authentication half. mTLS proves which service is calling. It does not prove that service is authorized to call this specific RPC. Service-level RBAC via a policy engine (OPA, Istio AuthorizationPolicy, or application-level) maps SPIFFE IDs to allowed methods. The `spiffeAuthorize` interceptor in the example is the simplest form: check if the caller's SPIFFE ID matches an expected value. Production implementations check the ID against a policy that might allow multiple callers, or deny specific methods to specific callers.

At platform scale, the cert authority trust hierarchy is an architectural decision. A single CA for all services means a CA compromise can impersonate any service in the entire fleet. A per-environment CA (dev, staging, prod) limits blast radius. A per-namespace or per-cluster CA limits it further. The trade-off is operational complexity: more CAs mean more renewal and rotation processes. The standard FAANG approach is a two-tier hierarchy: an offline root CA that issues intermediate CAs, and per-environment intermediate CAs that issue SVIDs. The root CA private key is never online.
