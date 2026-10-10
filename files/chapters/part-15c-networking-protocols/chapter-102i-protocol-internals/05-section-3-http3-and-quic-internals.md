## 102I.3 HTTP/3 and QUIC Internals

HTTP/3 replaces the TCP transport used by HTTP/1.1 and HTTP/2 with QUIC, a UDP-based protocol that integrates reliable delivery, flow control, and TLS 1.3 into a single layer. This architectural shift means that a lost UDP packet stalls only the QUIC stream it belongs to rather than every stream sharing a TCP connection, which is the head-of-line blocking problem that limits HTTP/2 on lossy networks. Understanding the QUIC handshake and its connection migration semantics is essential for anyone building or debugging high-performance HTTP/3 services in Go.

### 3.1 QUIC Protocol Architecture

QUIC collapses the TCP three-way handshake and the TLS handshake into a single 1-RTT exchange on first connect, and uses session tickets to achieve 0-RTT on reconnection so that previously authenticated clients can send application data in the very first packet. A `Connection ID` field in each QUIC packet decouples the connection identity from the 5-tuple of (src IP, src port, dst IP, dst port, protocol), enabling seamless connection migration when a mobile client switches from Wi-Fi to cellular without a visible reconnect. Each QUIC stream has independent flow-control windows, so a stalled stream does not prevent other streams from making progress, unlike TCP where a single receive buffer is shared across all application data.

```
QUIC vs TCP comparison:

TCP + TLS 1.3 connection setup:
  Client                Server
    │── SYN ──────────────►│  (RTT 0)
    │◄─ SYN-ACK ───────────│
    │── ACK + ClientHello ►│  (RTT 1)
    │◄─ ServerHello+Cert ──│
    │── Finished ─────────►│  (RTT 2)
    │── Request ──────────►│  (RTT 2, or RTT 3 if TLS 1.2)
    │◄─ Response ──────────│

QUIC + TLS 1.3 (0-RTT on reconnect):
  Client                Server
    │── Initial+ClientHello►│  (RTT 0)
    │◄─ Initial+ServerHello │
    │◄─ Handshake+Cert ─────│
    │── Handshake+Finished ►│  (RTT 1)
    │── Request ────────────►  (RTT 1, same flight!)
    │◄─ Response ───────────│

QUIC advantages over TCP:
  ✓ Connection migration (IP change keeps connection alive via Connection ID)
  ✓ Independent stream multiplexing (no Head-of-Line blocking)
  ✓ Built-in TLS 1.3 (no separate handshake layer)
  ✓ 0-RTT reconnection
  ✓ User-space congestion control (BBR, CUBIC, Reno, custom)
  ✓ Packet number spaces (Initial, Handshake, 1-RTT)
```

The `quic-go` library exposes QUIC connections and streams with an API similar to `net.Conn`, making it straightforward to build HTTP/3 servers or raw QUIC applications in Go. The configuration below tunes the key parameters that control stream concurrency, receive window sizes, and keepalive behavior, larger receive windows are essential to fully utilize bandwidth on high-BDP (bandwidth-delay product) paths such as cross-continent links.

```go
package quicinternals

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
)

// QUICConfig holds QUIC connection parameters.
type QUICConfig struct {
	MaxIncomingStreams      int64
	MaxIncomingUniStreams   int64
	MaxStreamReceiveWindow  uint64
	MaxConnReceiveWindow    uint64
	KeepAlivePeriod         time.Duration
	HandshakeIdleTimeout    time.Duration
	MaxIdleTimeout          time.Duration
	Enable0RTT              bool
}

// DefaultQUICConfig returns production-ready QUIC settings.
func DefaultQUICConfig() *QUICConfig {
	return &QUICConfig{
		MaxIncomingStreams:     1000,
		MaxIncomingUniStreams:  1000,
		MaxStreamReceiveWindow: 6 * 1024 * 1024, // 6 MiB
		MaxConnReceiveWindow:   15 * 1024 * 1024, // 15 MiB
		KeepAlivePeriod:        30 * time.Second,
		HandshakeIdleTimeout:   10 * time.Second,
		MaxIdleTimeout:         3 * time.Minute,
		Enable0RTT:             true,
	}
}

func (c *QUICConfig) toQUICConfig() *quic.Config {
	return &quic.Config{
		MaxIncomingStreams:      c.MaxIncomingStreams,
		MaxIncomingUniStreams:   c.MaxIncomingUniStreams,
		MaxStreamReceiveWindow:  c.MaxStreamReceiveWindow,
		MaxConnectionReceiveWindow: c.MaxConnReceiveWindow,
		KeepAlivePeriod:         c.KeepAlivePeriod,
		HandshakeIdleTimeout:    c.HandshakeIdleTimeout,
		MaxIdleTimeout:          c.MaxIdleTimeout,
		Allow0RTT:               c.Enable0RTT,
	}
}

// HTTP3Server wraps quic-go's HTTP/3 server.
type HTTP3Server struct {
	server *http3.Server
	cfg    *QUICConfig
}

// NewHTTP3Server creates an HTTP/3 server.
func NewHTTP3Server(addr string, tlsCfg *tls.Config, handler http.Handler, cfg *QUICConfig) *HTTP3Server {
	if cfg == nil {
		cfg = DefaultQUICConfig()
	}

	srv := &http3.Server{
		Addr:       addr,
		TLSConfig:  tlsCfg,
		Handler:    handler,
		QUICConfig: cfg.toQUICConfig(),
	}

	return &HTTP3Server{server: srv, cfg: cfg}
}

// ListenAndServeTLS starts the HTTP/3 server with TLS.
func (s *HTTP3Server) ListenAndServeTLS(certFile, keyFile string) error {
	return s.server.ListenAndServeTLS(certFile, keyFile)
}

// ListenAndServe starts with pre-loaded TLS config.
func (s *HTTP3Server) ListenAndServe() error {
	return s.server.ListenAndServe()
}

// Close gracefully stops the server.
func (s *HTTP3Server) Close() error {
	return s.server.Close()
}

// HTTP3Client creates an HTTP client that prefers HTTP/3 with HTTP/2 fallback.
func HTTP3Client(tlsCfg *tls.Config, cfg *QUICConfig) *http.Client {
	if cfg == nil {
		cfg = DefaultQUICConfig()
	}

	roundTripper := &http3.RoundTripper{
		TLSClientConfig: tlsCfg,
		QUICConfig:      cfg.toQUICConfig(),
	}

	return &http.Client{
		Transport: roundTripper,
		Timeout:   30 * time.Second,
	}
}

// QUICEchoServer demonstrates raw QUIC stream handling.
type QUICEchoServer struct {
	listener *quic.Listener
	cfg      *QUICConfig
}

// NewQUICEchoServer creates a low-level QUIC echo server.
func NewQUICEchoServer(addr string, tlsCfg *tls.Config, cfg *QUICConfig) (*QUICEchoServer, error) {
	if cfg == nil {
		cfg = DefaultQUICConfig()
	}

	ln, err := quic.ListenAddr(addr, tlsCfg, cfg.toQUICConfig())
	if err != nil {
		return nil, fmt.Errorf("QUIC listen %s: %w", addr, err)
	}

	return &QUICEchoServer{listener: ln, cfg: cfg}, nil
}

// Serve accepts QUIC connections and handles their streams.
func (s *QUICEchoServer) Serve(ctx context.Context) error {
	for {
		conn, err := s.listener.Accept(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("accept QUIC: %w", err)
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *QUICEchoServer) handleConn(ctx context.Context, conn quic.Connection) {
	defer conn.CloseWithError(0, "done")

	log.Printf("QUIC connection from %s (ALPN: %s)",
		conn.RemoteAddr(), conn.ConnectionState().TLS.NegotiatedProtocol)

	for {
		stream, err := conn.AcceptStream(ctx)
		if err != nil {
			return
		}
		go s.handleStream(stream)
	}
}

func (s *QUICEchoServer) handleStream(stream quic.Stream) {
	defer stream.Close()

	// Read data and echo it back
	buf := make([]byte, 64*1024)
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			if _, werr := stream.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			log.Printf("stream read error: %v", err)
			return
		}
	}
}

func (s *QUICEchoServer) Close() error {
	return s.listener.Close()
}

// QUICEchoClient makes a QUIC connection and sends data.
func QUICEchoClient(ctx context.Context, addr string, tlsCfg *tls.Config, message []byte) ([]byte, error) {
	conn, err := quic.DialAddr(ctx, addr, tlsCfg, &quic.Config{
		MaxIdleTimeout: 10 * time.Second,
	})
	if err != nil {
		return nil, fmt.Errorf("QUIC dial %s: %w", addr, err)
	}
	defer conn.CloseWithError(0, "done")

	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, fmt.Errorf("open stream: %w", err)
	}
	defer stream.Close()

	if _, err := stream.Write(message); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}
	stream.Close() // signal EOF to server

	response, err := io.ReadAll(stream)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	return response, nil
}

// DualStackServer serves both HTTP/2 (TLS) and HTTP/3 (QUIC).
// The Alt-Svc header tells clients about HTTP/3 availability.
type DualStackServer struct {
	http2Server *http.Server
	http3Server *HTTP3Server
	addr        string
}

// NewDualStackServer creates servers for both protocols.
func NewDualStackServer(addr string, tlsCfg *tls.Config, handler http.Handler) *DualStackServer {
	// Wrap handler to advertise HTTP/3
	wrappedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Tell HTTP/1.1 and HTTP/2 clients that HTTP/3 is available
		w.Header().Set("Alt-Svc", fmt.Sprintf(`h3="%s"; ma=86400`, addr))
		handler.ServeHTTP(w, r)
	})

	h2Srv := &http.Server{
		Addr:      addr,
		Handler:   wrappedHandler,
		TLSConfig: tlsCfg,
	}

	h3Srv := NewHTTP3Server(addr, tlsCfg, wrappedHandler, nil)

	return &DualStackServer{
		http2Server: h2Srv,
		http3Server: h3Srv,
		addr:        addr,
	}
}

// Serve starts both HTTP/2 and HTTP/3 servers concurrently.
func (s *DualStackServer) Serve(ctx context.Context, certFile, keyFile string) error {
	errCh := make(chan error, 2)

	go func() {
		if err := s.http2Server.ListenAndServeTLS(certFile, keyFile); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("HTTP/2: %w", err)
		}
	}()

	go func() {
		if err := s.http3Server.ListenAndServeTLS(certFile, keyFile); err != nil {
			errCh <- fmt.Errorf("HTTP/3: %w", err)
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.http2Server.Shutdown(shutCtx)
		s.http3Server.Close()
		return nil
	}
}
```

### Junior → FAANG: Why QUIC Solves a Real Problem and When It Matters

The problem QUIC solves is TCP head-of-line blocking: in HTTP/2, all streams share one TCP connection, so a single lost packet pauses all streams while TCP retransmits it. QUIC solves this by implementing per-stream loss recovery at the transport layer. A lost packet in stream 3 pauses only stream 3. Streams 1, 2, 4, and 5 continue normally.

When does this matter? On high-loss networks (mobile, international links with high retransmission rates), the improvement is significant. On low-loss data center networks (0.001% packet loss), the improvement is not observable. This is why HTTP/3 adoption is driven primarily by consumer-facing services (Cloudflare, Google, YouTube) where mobile clients on lossy networks are a large fraction of traffic, and less relevant for internal data center RPC.

Interview entry point: explain QUIC as "HTTP/2's streams over UDP with per-stream loss recovery instead of TCP's connection-level loss recovery." Explain 0-RTT resumption as "clients that have connected before can send data in the first packet, saving one round trip compared to TLS 1.3's 1-RTT handshake."

### Senior @ FAANG: QUIC Deployment Tradeoffs and Operational Challenges

QUIC over UDP has specific operational challenges that TCP does not have. Firewalls and middleboxes that block UDP port 443 (which QUIC uses) will prevent QUIC connections from being established. The standard fallback is HTTP/2 over TLS. Clients must implement this fallback transparently (via `Alt-Svc` header negotiation and QUIC probe failures falling back to TCP). Measuring the QUIC adoption rate in production (what fraction of clients successfully negotiate QUIC versus falling back to HTTP/2) is necessary to evaluate whether QUIC deployment is actually beneficial.

UDP-based protocols also create different DDoS profiles. TCP's three-way handshake prevents source IP spoofing at scale (spoofed SYN packets are wasted because the attacker cannot complete the handshake). QUIC's UDP-based connection initiation requires explicit anti-spoofing mechanisms (address validation tokens in the QUIC handshake). Understanding the security model of QUIC relative to TCP is important for FAANG security architecture reviews of HTTP/3 deployment.

At the platform level, deploying HTTP/3 in a fleet requires: infrastructure support for UDP 443 in load balancers and firewalls, operational tooling that understands QUIC connection state (traditional TCP tools like `ss` and `netstat` do not show QUIC connections), and monitoring for fallback rates that indicate deployment problems. These are non-trivial operational investments that must be planned alongside the protocol decision.

---
