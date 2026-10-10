## 102I.2 HTTP/2 Internals and Frame-Level Multiplexing

### 2.1 HTTP/2 Frame Format and Multiplexing

HTTP/2 sends all data as binary frames over a single TCP connection. Each frame has a 9-byte header: 3-byte length, 1-byte type, 1-byte flags, 4-byte stream ID (R bit + 31-bit ID).

```
HTTP/2 Frame Layout:
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
├───────────────────────────────┬───────────────────────────────┤
│         Length (24)           │    Type (8)   │   Flags (8)   │
├─────────────────────────────────────────────────────────────────┤
│R│                 Stream Identifier (31)                        │
├─────────────────────────────────────────────────────────────────┤
│                   Frame Payload (0 to 2^24-1 octets)           │
└─────────────────────────────────────────────────────────────────┘

Frame Types:
  0x0 DATA        - request/response body
  0x1 HEADERS     - request/response headers (HPACK encoded)
  0x2 PRIORITY    - stream priority
  0x3 RST_STREAM  - cancel stream
  0x4 SETTINGS    - connection settings negotiation
  0x5 PUSH_PROMISE - server push
  0x6 PING        - RTT measurement / keepalive
  0x7 GOAWAY      - graceful shutdown
  0x8 WINDOW_UPDATE - flow control
  0x9 CONTINUATION - continuation of HEADERS
```

```go
package http2internals

import (
	"encoding/binary"
	"fmt"
	"io"
)

// FrameType identifies the type of an HTTP/2 frame.
type FrameType uint8

const (
	FrameData         FrameType = 0x0
	FrameHeaders      FrameType = 0x1
	FramePriority     FrameType = 0x2
	FrameRSTStream    FrameType = 0x3
	FrameSettings     FrameType = 0x4
	FramePushPromise  FrameType = 0x5
	FramePing         FrameType = 0x6
	FrameGoAway       FrameType = 0x7
	FrameWindowUpdate FrameType = 0x8
	FrameContinuation FrameType = 0x9
)

// Flags for frames.
const (
	FlagEndStream  = 0x1
	FlagEndHeaders = 0x4
	FlagPadded     = 0x8
	FlagPriority   = 0x20
	FlagAck        = 0x1
)

// Frame represents an HTTP/2 frame header + payload.
type Frame struct {
	Length   uint32    // 24 bits
	Type     FrameType
	Flags    uint8
	StreamID uint32 // 31 bits
	Payload  []byte
}

// ReadFrame reads one HTTP/2 frame from r.
func ReadFrame(r io.Reader) (*Frame, error) {
	header := make([]byte, 9)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("read frame header: %w", err)
	}

	length := uint32(header[0])<<16 | uint32(header[1])<<8 | uint32(header[2])
	frameType := FrameType(header[3])
	flags := header[4]
	streamID := binary.BigEndian.Uint32(header[5:]) & 0x7FFFFFFF // mask R bit

	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, fmt.Errorf("read frame payload: %w", err)
		}
	}

	return &Frame{
		Length:   length,
		Type:     frameType,
		Flags:    flags,
		StreamID: streamID,
		Payload:  payload,
	}, nil
}

// WriteFrame serializes an HTTP/2 frame to w.
func WriteFrame(w io.Writer, f *Frame) error {
	header := make([]byte, 9)
	length := len(f.Payload)

	header[0] = byte(length >> 16)
	header[1] = byte(length >> 8)
	header[2] = byte(length)
	header[3] = byte(f.Type)
	header[4] = f.Flags
	sid := f.StreamID & 0x7FFFFFFF
	binary.BigEndian.PutUint32(header[5:], sid)

	if _, err := w.Write(header); err != nil {
		return err
	}
	if len(f.Payload) > 0 {
		_, err := w.Write(f.Payload)
		return err
	}
	return nil
}

// IsEndStream returns whether this frame has END_STREAM set.
func (f *Frame) IsEndStream() bool {
	return f.Flags&FlagEndStream != 0
}

// IsEndHeaders returns whether this frame has END_HEADERS set.
func (f *Frame) IsEndHeaders() bool {
	return f.Flags&FlagEndHeaders != 0
}
```

### 2.2 HPACK Header Compression

HPACK compresses HTTP/2 headers using a static table of 61 common headers, a dynamic table per connection, and Huffman encoding.

```go
package http2internals

import (
	"bytes"
	"fmt"
)

// StaticTableEntry is a pre-defined header name/value pair.
type StaticTableEntry struct {
	Name  string
	Value string
}

// staticTable contains the 61 predefined HPACK entries (RFC 7541 Appendix A).
var staticTable = []StaticTableEntry{
	{},                              // index 0 unused
	{":authority", ""},              // 1
	{":method", "GET"},              // 2
	{":method", "POST"},             // 3
	{":path", "/"},                  // 4
	{":path", "/index.html"},        // 5
	{":scheme", "http"},             // 6
	{":scheme", "https"},            // 7
	{":status", "200"},              // 8
	{":status", "204"},              // 9
	{":status", "206"},              // 10
	{":status", "304"},              // 11
	{":status", "400"},              // 12
	{":status", "404"},              // 13
	{":status", "500"},              // 14
	{"accept-charset", ""},          // 15
	{"accept-encoding", "gzip, deflate"}, // 16
	{"accept-language", ""},         // 17
	{"accept-ranges", ""},           // 18
	{"accept", ""},                  // 19
	{"access-control-allow-origin", ""}, // 20
	{"age", ""},                     // 21
	{"allow", ""},                   // 22
	{"authorization", ""},           // 23
	{"cache-control", ""},           // 24
	{"content-disposition", ""},     // 25
	{"content-encoding", ""},        // 26
	{"content-language", ""},        // 27
	{"content-length", ""},          // 28
	{"content-location", ""},        // 29
	{"content-range", ""},           // 30
	{"content-type", ""},            // 31
	{"cookie", ""},                  // 32
	{"date", ""},                    // 33
	{"etag", ""},                    // 34
	{"expect", ""},                  // 35
	{"expires", ""},                 // 36
	{"from", ""},                    // 37
	{"host", ""},                    // 38
	{"if-match", ""},                // 39
	{"if-modified-since", ""},       // 40
	{"if-none-match", ""},           // 41
	{"if-range", ""},                // 42
	{"if-unmodified-since", ""},     // 43
	{"last-modified", ""},           // 44
	{"link", ""},                    // 45
	{"location", ""},                // 46
	{"max-forwards", ""},            // 47
	{"proxy-authenticate", ""},      // 48
	{"proxy-authorization", ""},     // 49
	{"range", ""},                   // 50
	{"referer", ""},                 // 51
	{"refresh", ""},                 // 52
	{"retry-after", ""},             // 53
	{"server", ""},                  // 54
	{"set-cookie", ""},              // 55
	{"strict-transport-security", ""}, // 56
	{"transfer-encoding", ""},       // 57
	{"user-agent", ""},              // 58
	{"vary", ""},                    // 59
	{"via", ""},                     // 60
	{"www-authenticate", ""},        // 61
}

// DynamicTable maintains the HPACK dynamic header table per connection.
type DynamicTable struct {
	entries    []StaticTableEntry
	maxSize    int
	currentSize int
}

// NewDynamicTable creates a table with the default 4096-byte max size.
func NewDynamicTable() *DynamicTable {
	return &DynamicTable{maxSize: 4096}
}

// Add inserts a header into the dynamic table, evicting old entries as needed.
func (dt *DynamicTable) Add(name, value string) {
	entrySize := 32 + len(name) + len(value) // RFC 7541 §4.1
	for dt.currentSize+entrySize > dt.maxSize && len(dt.entries) > 0 {
		// Evict oldest (last) entry
		oldest := dt.entries[len(dt.entries)-1]
		dt.currentSize -= 32 + len(oldest.Name) + len(oldest.Value)
		dt.entries = dt.entries[:len(dt.entries)-1]
	}
	if entrySize <= dt.maxSize {
		dt.entries = append([]StaticTableEntry{{name, value}}, dt.entries...)
		dt.currentSize += entrySize
	}
}

// Lookup searches static + dynamic tables for name/value pair.
// Returns (index, nameOnly) where nameOnly means only name matched.
func (dt *DynamicTable) Lookup(name, value string) (int, bool) {
	nameMatch := -1
	// Static table (1-indexed)
	for i := 1; i < len(staticTable); i++ {
		if staticTable[i].Name == name {
			if staticTable[i].Value == value {
				return i, false
			}
			if nameMatch == -1 {
				nameMatch = i
			}
		}
	}
	// Dynamic table (index starts at 62)
	for i, e := range dt.entries {
		idx := 62 + i
		if e.Name == name {
			if e.Value == value {
				return idx, false
			}
			if nameMatch == -1 {
				nameMatch = idx
			}
		}
	}
	return nameMatch, nameMatch != -1
}

// EncodeInt encodes an integer with prefix bits per HPACK integer encoding.
func EncodeInt(prefix uint8, n int) []byte {
	maxPrefix := (1 << prefix) - 1
	if n < maxPrefix {
		return []byte{byte(n)}
	}
	buf := []byte{byte(maxPrefix)}
	n -= maxPrefix
	for n >= 128 {
		buf = append(buf, byte(n%128+128))
		n /= 128
	}
	buf = append(buf, byte(n))
	return buf
}

// HPACKEncoder encodes HTTP headers using HPACK.
type HPACKEncoder struct {
	table *DynamicTable
}

func NewHPACKEncoder() *HPACKEncoder {
	return &HPACKEncoder{table: NewDynamicTable()}
}

// Encode encodes a slice of name/value header pairs.
func (e *HPACKEncoder) Encode(headers [][2]string) ([]byte, error) {
	var buf bytes.Buffer
	for _, h := range headers {
		name, value := h[0], h[1]
		idx, nameOnly := e.table.Lookup(name, value)

		if idx > 0 && !nameOnly {
			// Indexed header - single byte or integer encoding
			b := EncodeInt(7, idx)
			b[0] |= 0x80 // set high bit
			buf.Write(b)
		} else {
			// Literal header with incremental indexing (0x40)
			if idx > 0 {
				b := EncodeInt(6, idx)
				b[0] |= 0x40
				buf.Write(b)
			} else {
				buf.WriteByte(0x40) // new name
				// Write name length + name
				b := EncodeInt(7, len(name))
				buf.Write(b)
				buf.WriteString(name)
			}
			// Write value length + value
			b := EncodeInt(7, len(value))
			buf.Write(b)
			buf.WriteString(value)
			// Add to dynamic table
			e.table.Add(name, value)
		}
	}
	return buf.Bytes(), nil
}

// CompressionRatio estimates header compression efficiency.
func CompressionRatio(original, compressed int) float64 {
	if original == 0 {
		return 1.0
	}
	return float64(compressed) / float64(original)
}

// DemoHPACK shows the compression benefit for repeated requests.
func DemoHPACK() {
	enc := NewHPACKEncoder()

	// First request - no dynamic table entries yet
	req1 := [][2]string{
		{":method", "GET"},
		{":path", "/api/users"},
		{":scheme", "https"},
		{":authority", "api.example.com"},
		{"user-agent", "Go-HTTP/2"},
		{"accept", "application/json"},
	}
	encoded1, _ := enc.Encode(req1)

	// Second identical request - many entries now in dynamic table
	encoded2, _ := enc.Encode(req1)

	total1 := 0
	for _, h := range req1 {
		total1 += len(h[0]) + len(h[1])
	}

	fmt.Printf("Request 1: %d bytes raw → %d bytes HPACK (ratio %.2f)\n",
		total1, len(encoded1), CompressionRatio(total1, len(encoded1)))
	fmt.Printf("Request 2: %d bytes raw → %d bytes HPACK (ratio %.2f)\n",
		total1, len(encoded2), CompressionRatio(total1, len(encoded2)))
}
```

### 2.3 HTTP/2 Flow Control

HTTP/2 implements two levels of flow control: a per-stream window that limits how much data a sender can push on any single stream, and a per-connection window that limits total data across all streams combined. Both windows start at 65,535 bytes and grow when the receiver sends `WINDOW_UPDATE` frames. The `FlowController` below tracks these windows atomically so that the sender can check available capacity before writing without holding a lock during the check itself.

```go
package http2internals

import (
	"fmt"
	"sync"
	"sync/atomic"
)

// FlowController implements HTTP/2 flow control windows.
// Both connection-level and stream-level windows must be respected.
type FlowController struct {
	mu              sync.Mutex
	connWindow      atomic.Int32  // connection-level send window
	streams         map[uint32]*streamWindow
	defaultWinSize  int32
}

type streamWindow struct {
	window atomic.Int32
}

// NewFlowController creates a flow controller with the given initial window size.
func NewFlowController(initialWindowSize int32) *FlowController {
	fc := &FlowController{
		streams:        make(map[uint32]*streamWindow),
		defaultWinSize: initialWindowSize,
	}
	fc.connWindow.Store(65535) // HTTP/2 default connection window
	return fc
}

// AddStream registers a new stream with the initial window size.
func (fc *FlowController) AddStream(streamID uint32) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	sw := &streamWindow{}
	sw.window.Store(fc.defaultWinSize)
	fc.streams[streamID] = sw
}

// RemoveStream cleans up a stream's flow control state.
func (fc *FlowController) RemoveStream(streamID uint32) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	delete(fc.streams, streamID)
}

// CanSend checks if n bytes can be sent on streamID.
// Returns actual number of bytes allowed (may be less than n).
func (fc *FlowController) CanSend(streamID uint32, n int32) int32 {
	connAvail := fc.connWindow.Load()
	if connAvail <= 0 {
		return 0
	}

	fc.mu.Lock()
	sw, ok := fc.streams[streamID]
	fc.mu.Unlock()
	if !ok {
		return 0
	}

	streamAvail := sw.window.Load()
	if streamAvail <= 0 {
		return 0
	}

	// Allowed = min(n, connWindow, streamWindow)
	allowed := n
	if connAvail < allowed {
		allowed = connAvail
	}
	if streamAvail < allowed {
		allowed = streamAvail
	}
	return allowed
}

// Consume deducts bytes from both connection and stream windows.
func (fc *FlowController) Consume(streamID uint32, n int32) error {
	fc.mu.Lock()
	sw, ok := fc.streams[streamID]
	fc.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown stream %d", streamID)
	}

	fc.connWindow.Add(-n)
	sw.window.Add(-n)
	return nil
}

// UpdateConnWindow processes a WINDOW_UPDATE for the connection.
func (fc *FlowController) UpdateConnWindow(increment int32) {
	fc.connWindow.Add(increment)
}

// UpdateStreamWindow processes a WINDOW_UPDATE for a stream.
func (fc *FlowController) UpdateStreamWindow(streamID uint32, increment int32) error {
	fc.mu.Lock()
	sw, ok := fc.streams[streamID]
	fc.mu.Unlock()
	if !ok {
		return fmt.Errorf("unknown stream %d", streamID)
	}
	sw.window.Add(increment)
	return nil
}

// ShouldSendWindowUpdate returns true if the receiver should send WINDOW_UPDATE.
// Strategy: update when window drops below half of initial size.
func (fc *FlowController) ShouldSendWindowUpdate(current, initial int32) bool {
	return current < initial/2
}
```

### 2.4 Using Go's HTTP/2 Server with Advanced Configuration

Go's `golang.org/x/net/http2` package allows fine-grained control over stream concurrency, frame sizes, and initial flow control windows beyond what `net/http` exposes directly. Larger initial window sizes dramatically improve throughput on high-latency links by allowing the sender to push more data before waiting for a `WINDOW_UPDATE`. The code below also demonstrates h2c (HTTP/2 cleartext) for internal service-to-service communication behind a TLS-terminating proxy, and server push to proactively deliver assets to browser clients.

```go
package http2internals

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// HTTP2ServerConfig holds tunable HTTP/2 settings.
type HTTP2ServerConfig struct {
	Addr                string
	MaxConcurrentStreams uint32
	MaxReadFrameSize    uint32
	InitialWindowSize   int32
	MaxHeaderListSize   uint32
	IdleTimeout         time.Duration
	ReadTimeout         time.Duration
	WriteTimeout        time.Duration
	TLSConfig           *tls.Config
}

// DefaultHTTP2Config returns a production-ready HTTP/2 configuration.
func DefaultHTTP2Config(addr string, tlsCfg *tls.Config) HTTP2ServerConfig {
	return HTTP2ServerConfig{
		Addr:                addr,
		MaxConcurrentStreams: 250,
		MaxReadFrameSize:    1 << 20, // 1 MiB
		InitialWindowSize:   1 << 20, // 1 MiB (larger than default 65535)
		MaxHeaderListSize:   8192,
		IdleTimeout:         3 * time.Minute,
		ReadTimeout:         30 * time.Second,
		WriteTimeout:        30 * time.Second,
		TLSConfig:           tlsCfg,
	}
}

// NewHTTP2Server creates an HTTP/2 server with the given configuration.
func NewHTTP2Server(cfg HTTP2ServerConfig, handler http.Handler) (*http.Server, error) {
	h2Server := &http2.Server{
		MaxConcurrentStreams: cfg.MaxConcurrentStreams,
		MaxReadFrameSize:    cfg.MaxReadFrameSize,
		IdleTimeout:         cfg.IdleTimeout,
	}

	srv := &http.Server{
		Addr:         cfg.Addr,
		Handler:      handler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		TLSConfig:    cfg.TLSConfig,
	}

	if err := http2.ConfigureServer(srv, h2Server); err != nil {
		return nil, fmt.Errorf("configure HTTP/2: %w", err)
	}

	return srv, nil
}

// NewH2CServer creates an HTTP/2 server without TLS (cleartext - h2c).
// Useful for internal services behind a TLS-terminating proxy.
func NewH2CServer(addr string, handler http.Handler) *http.Server {
	h2Server := &http2.Server{
		MaxConcurrentStreams: 200,
	}
	return &http.Server{
		Addr:    addr,
		Handler: h2c.NewHandler(handler, h2Server),
	}
}

// ServerPushHandler demonstrates HTTP/2 Server Push.
// When the browser requests /index.html, we proactively push /style.css.
func ServerPushHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/index.html" && r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	// Attempt server push if the client supports it
	if pusher, ok := w.(http.Pusher); ok {
		pushOpts := &http.PushOptions{
			Header: http.Header{
				"Content-Type": {"text/css"},
			},
		}
		if err := pusher.Push("/style.css", pushOpts); err != nil {
			// Push not supported or already pushed - not fatal
			fmt.Printf("Push skipped: %v\n", err)
		}
		if err := pusher.Push("/app.js", &http.PushOptions{
			Header: http.Header{"Content-Type": {"application/javascript"}},
		}); err != nil {
			fmt.Printf("Push skipped: %v\n", err)
		}
	}

	w.Header().Set("Content-Type", "text/html")
	fmt.Fprint(w, `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/style.css">
  <script src="/app.js"></script>
</head>
<body><h1>Hello HTTP/2!</h1></body>
</html>`)
}

// HTTP2ClientTransport creates an HTTP/2 client with connection pooling.
func HTTP2ClientTransport(tlsCfg *tls.Config) *http.Transport {
	transport := &http.Transport{
		TLSClientConfig:     tlsCfg,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}

	if err := http2.ConfigureTransport(transport); err != nil {
		panic(fmt.Sprintf("configure HTTP/2 transport: %v", err))
	}

	return transport
}

// StreamInfo holds per-stream metadata for instrumentation.
type StreamInfo struct {
	ID            uint32
	Method        string
	Path          string
	StartTime     time.Time
	HeadersBytes  int
	BodyBytes     int64
	Completed     bool
	Error         error
}

// HTTP2InstrumentedHandler wraps a handler to collect per-stream metrics.
type HTTP2InstrumentedHandler struct {
	handler http.Handler
	onDone  func(*StreamInfo)
}

func NewHTTP2InstrumentedHandler(h http.Handler, onDone func(*StreamInfo)) *HTTP2InstrumentedHandler {
	return &HTTP2InstrumentedHandler{handler: h, onDone: onDone}
}

func (h *HTTP2InstrumentedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	info := &StreamInfo{
		Method:    r.Method,
		Path:      r.URL.Path,
		StartTime: time.Now(),
	}

	// Estimate header bytes
	for name, vals := range r.Header {
		info.HeadersBytes += len(name)
		for _, v := range vals {
			info.HeadersBytes += len(v)
		}
	}

	defer func() {
		info.Completed = true
		h.onDone(info)
	}()

	h.handler.ServeHTTP(w, r)
}

// RunHTTP2Demo starts a demo HTTP/2 server and makes a request.
func RunHTTP2Demo(ctx context.Context) error {
	// In production, use real certs. For demo, generate self-signed.
	// tlsCfg := generateSelfSignedTLS()  -- omitted for brevity

	mux := http.NewServeMux()
	mux.HandleFunc("/", ServerPushHandler)
	mux.HandleFunc("/style.css", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/css")
		fmt.Fprint(w, "body { font-family: sans-serif; }")
	})
	mux.HandleFunc("/app.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		fmt.Fprint(w, "console.log('HTTP/2 push works!');")
	})

	// h2c (no TLS) for local demo
	srv := NewH2CServer(":8080", mux)

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
	}()

	fmt.Println("HTTP/2 server listening on :8080 (h2c)")
	return srv.ListenAndServe()
}
```

### Junior → FAANG: HTTP/2 Multiplexing and Why It Matters

HTTP/1.1's connection model requires one request-response cycle to complete before the next can begin on the same connection. HTTP/2 multiplexes multiple concurrent request/response pairs as streams over a single connection, each with an independent stream ID. A single connection can have hundreds of concurrent in-flight streams, eliminating the need for connection pooling to achieve parallelism.

The practical implication for gRPC: gRPC is built on HTTP/2, and the flow control mechanism (both connection-level and stream-level) directly affects how many concurrent RPCs a connection can carry. A gRPC client that opens a new connection for every RPC is wasting the multiplexing advantage. Correct gRPC configuration uses a small number of connections (often one per server endpoint) with the HTTP/2 flow control window sized for the expected concurrency.

Interview entry point: explain HTTP/2 multiplexing as "multiple request/response pairs as streams on one TCP connection, identified by stream IDs." Explain head-of-line blocking as "HTTP/2 streams share one TCP connection, so a single TCP packet loss pauses all streams until that packet is retransmitted."

### Senior @ FAANG: HTTP/2 Flow Control Tuning for gRPC at Scale

HTTP/2 has two flow control mechanisms: connection-level (applies to all streams) and stream-level (applies to individual requests). Flow control is implemented via WINDOW_UPDATE frames that grant the sender permission to send more bytes. If a receiver is slow (slow client or slow server), the flow control window fills up and the sender must block until the receiver sends a WINDOW_UPDATE. In gRPC, this manifests as requests that complete at the gRPC layer but then block sending the response because the HTTP/2 window is exhausted.

The tuning levers in Go's HTTP/2 implementation are `golang.org/x/net/http2` configuration: `InitialWindowSize` (default 65KB, maximum 2GB per stream) and `MaxReadFrameSize` (default 16KB). For high-throughput streaming RPCs (binary blobs, large responses), increasing `InitialWindowSize` to 4MB or 16MB eliminates window-blocking overhead and increases throughput significantly. The tradeoff is memory: each connection holds buffers sized to the window.

The HPACK compression concern at FAANG scale: HPACK uses a shared compression context per connection that is updated with each request. If connections are not reused (connection pool exhaustion causes new connection creation), the HPACK context starts fresh and header compression is ineffective. Monitoring HPACK compression ratio (via HTTP/2 server-side statistics) reveals whether connection reuse is working correctly or whether connection pool misconfiguration is causing repeated context initialization.

---
