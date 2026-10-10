## 102I.5 Custom Binary Protocol Design and RPC Framing

### 5.1 Designing an Efficient Binary Protocol

A custom binary protocol can reduce per-message overhead to a fixed 22-byte header versus HTTP/2's variable-length HPACK-compressed headers, making it attractive for high-frequency internal RPC where every byte and syscall counts. The GoRPC framing format below packs message type, flags, a request ID for multiplexing, payload length, and an optional header section into a compact fixed layout. Optional gzip compression is applied transparently when it reduces payload size, using a pool of `gzip.Writer` instances to avoid allocation pressure.

```
Our custom protocol: GoRPC framing

Frame format:
┌─────────────────────────────────────────────────────────────┐
│ Magic (4B) │ Version (1B) │ Type (1B) │ Flags (2B)          │
├─────────────────────────────────────────────────────────────┤
│ RequestID (8B) │ Payload Length (4B) │ Header Length (2B)   │
├─────────────────────────────────────────────────────────────┤
│ Headers (variable, Header Length bytes)                     │
├─────────────────────────────────────────────────────────────┤
│ Payload (variable, Payload Length bytes)                    │
└─────────────────────────────────────────────────────────────┘

Total fixed header: 22 bytes
Magic: 0x474F5250 ('GORP')
Types: 0x01=Request, 0x02=Response, 0x03=Heartbeat, 0x04=Error
Flags: 0x01=Compressed, 0x02=Encrypted, 0x04=Stream
```

```go
package protocol

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"sync"
)

const (
	Magic   uint32 = 0x474F5250 // 'GORP'
	Version uint8  = 1

	TypeRequest   uint8 = 0x01
	TypeResponse  uint8 = 0x02
	TypeHeartbeat uint8 = 0x03
	TypeError     uint8 = 0x04
	TypeStream    uint8 = 0x05

	FlagCompressed uint16 = 0x01
	FlagEncrypted  uint16 = 0x02
	FlagStream     uint16 = 0x04
	FlagEndStream  uint16 = 0x08

	FixedHeaderSize = 22
	MaxPayloadSize  = 64 * 1024 * 1024 // 64 MiB
)

// Frame is the basic unit of the GoRPC protocol.
type Frame struct {
	Magic        uint32
	Version      uint8
	Type         uint8
	Flags        uint16
	RequestID    uint64
	PayloadLen   uint32
	HeaderLen    uint16
	HeaderBytes  []byte
	Payload      []byte
}

// Header represents key-value metadata pairs.
type Header struct {
	Key   string
	Value string
}

// DecodeHeaders parses length-prefixed key/value pairs.
func DecodeHeaders(data []byte) ([]Header, error) {
	var headers []Header
	r := bytes.NewReader(data)
	for r.Len() > 0 {
		var keyLen uint16
		if err := binary.Read(r, binary.BigEndian, &keyLen); err != nil {
			return nil, err
		}
		key := make([]byte, keyLen)
		if _, err := io.ReadFull(r, key); err != nil {
			return nil, err
		}
		var valLen uint16
		if err := binary.Read(r, binary.BigEndian, &valLen); err != nil {
			return nil, err
		}
		val := make([]byte, valLen)
		if _, err := io.ReadFull(r, val); err != nil {
			return nil, err
		}
		headers = append(headers, Header{Key: string(key), Value: string(val)})
	}
	return headers, nil
}

// EncodeHeaders serializes headers to length-prefixed binary format.
func EncodeHeaders(headers []Header) ([]byte, error) {
	var buf bytes.Buffer
	for _, h := range headers {
		if err := binary.Write(&buf, binary.BigEndian, uint16(len(h.Key))); err != nil {
			return nil, err
		}
		buf.WriteString(h.Key)
		if err := binary.Write(&buf, binary.BigEndian, uint16(len(h.Value))); err != nil {
			return nil, err
		}
		buf.WriteString(h.Value)
	}
	return buf.Bytes(), nil
}

// FrameCodec encodes and decodes frames from a stream.
type FrameCodec struct {
	r          *bufio.Reader
	w          *bufio.Writer
	mu         sync.Mutex
	gzipPool   sync.Pool
}

// NewFrameCodec creates a codec over an io.ReadWriter.
func NewFrameCodec(rw io.ReadWriter) *FrameCodec {
	return &FrameCodec{
		r: bufio.NewReaderSize(rw, 64*1024),
		w: bufio.NewWriterSize(rw, 64*1024),
		gzipPool: sync.Pool{
			New: func() any {
				gz, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
				return gz
			},
		},
	}
}

// ReadFrame reads the next frame from the stream.
func (c *FrameCodec) ReadFrame() (*Frame, error) {
	header := make([]byte, FixedHeaderSize)
	if _, err := io.ReadFull(c.r, header); err != nil {
		return nil, fmt.Errorf("read fixed header: %w", err)
	}

	f := &Frame{}
	f.Magic = binary.BigEndian.Uint32(header[0:4])
	f.Version = header[4]
	f.Type = header[5]
	f.Flags = binary.BigEndian.Uint16(header[6:8])
	f.RequestID = binary.BigEndian.Uint64(header[8:16])
	f.PayloadLen = binary.BigEndian.Uint32(header[16:20])
	f.HeaderLen = binary.BigEndian.Uint16(header[20:22])

	if f.Magic != Magic {
		return nil, fmt.Errorf("invalid magic: got 0x%X, want 0x%X", f.Magic, Magic)
	}
	if f.Version != Version {
		return nil, fmt.Errorf("unsupported version: %d", f.Version)
	}
	if f.PayloadLen > MaxPayloadSize {
		return nil, fmt.Errorf("payload too large: %d > %d", f.PayloadLen, MaxPayloadSize)
	}

	if f.HeaderLen > 0 {
		f.HeaderBytes = make([]byte, f.HeaderLen)
		if _, err := io.ReadFull(c.r, f.HeaderBytes); err != nil {
			return nil, fmt.Errorf("read headers: %w", err)
		}
	}

	if f.PayloadLen > 0 {
		f.Payload = make([]byte, f.PayloadLen)
		if _, err := io.ReadFull(c.r, f.Payload); err != nil {
			return nil, fmt.Errorf("read payload: %w", err)
		}

		// Decompress if needed
		if f.Flags&FlagCompressed != 0 {
			decompressed, err := c.decompress(f.Payload)
			if err != nil {
				return nil, fmt.Errorf("decompress: %w", err)
			}
			f.Payload = decompressed
		}
	}

	return f, nil
}

// WriteFrame serializes and writes a frame to the stream.
func (c *FrameCodec) WriteFrame(f *Frame) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	payload := f.Payload
	flags := f.Flags

	// Compress if requested and payload is large enough
	if flags&FlagCompressed != 0 && len(payload) > 1024 {
		compressed, err := c.compress(payload)
		if err != nil {
			return fmt.Errorf("compress: %w", err)
		}
		if len(compressed) < len(payload) {
			payload = compressed
		} else {
			flags &^= FlagCompressed // not worth compressing
		}
	}

	header := make([]byte, FixedHeaderSize)
	binary.BigEndian.PutUint32(header[0:4], Magic)
	header[4] = Version
	header[5] = f.Type
	binary.BigEndian.PutUint16(header[6:8], flags)
	binary.BigEndian.PutUint64(header[8:16], f.RequestID)
	binary.BigEndian.PutUint32(header[16:20], uint32(len(payload)))
	binary.BigEndian.PutUint16(header[20:22], uint16(len(f.HeaderBytes)))

	if _, err := c.w.Write(header); err != nil {
		return err
	}
	if len(f.HeaderBytes) > 0 {
		if _, err := c.w.Write(f.HeaderBytes); err != nil {
			return err
		}
	}
	if len(payload) > 0 {
		if _, err := c.w.Write(payload); err != nil {
			return err
		}
	}

	return c.w.Flush()
}

func (c *FrameCodec) compress(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	gz := c.gzipPool.Get().(*gzip.Writer)
	defer c.gzipPool.Put(gz)

	gz.Reset(&buf)
	if _, err := gz.Write(data); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (c *FrameCodec) decompress(data []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	return io.ReadAll(gz)
}
```

### 5.2 RPC Protocol Implementation

Multiplexed RPC over a single TCP connection avoids the overhead of establishing a new connection per call while allowing many in-flight requests simultaneously. Each `Call` assigns a unique request ID, registers a response channel in a pending map, writes the frame, then blocks until the corresponding response arrives, all without a mutex on the read path because a dedicated `readLoop` goroutine owns all reads and dispatches to the correct pending channel.

```go
package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// RPCRequest is the application-level request.
type RPCRequest struct {
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	Timeout time.Duration   `json:"timeout,omitempty"`
}

// RPCResponse is the application-level response.
type RPCResponse struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

// RPCError is a structured error response.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("RPC error %d: %s", e.Code, e.Message)
}

// RPCClient is a multiplexed RPC client over the custom binary protocol.
type RPCClient struct {
	codec     *FrameCodec
	conn      net.Conn
	pending   map[uint64]chan *RPCResponse
	mu        sync.Mutex
	requestID atomic.Uint64
	done      chan struct{}
}

// NewRPCClient connects to addr and creates a client.
func NewRPCClient(ctx context.Context, addr string) (*RPCClient, error) {
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	client := &RPCClient{
		codec:   NewFrameCodec(conn),
		conn:    conn,
		pending: make(map[uint64]chan *RPCResponse),
		done:    make(chan struct{}),
	}

	go client.readLoop()
	return client, nil
}

// Call sends an RPC request and waits for the response.
func (c *RPCClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	paramsJSON, err := json.Marshal(params)
	if err != nil {
		return nil, fmt.Errorf("marshal params: %w", err)
	}

	reqBody, err := json.Marshal(RPCRequest{
		Method: method,
		Params: paramsJSON,
	})
	if err != nil {
		return nil, err
	}

	id := c.requestID.Add(1)
	respCh := make(chan *RPCResponse, 1)

	c.mu.Lock()
	c.pending[id] = respCh
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	frame := &Frame{
		Magic:     Magic,
		Version:   Version,
		Type:      TypeRequest,
		RequestID: id,
		Payload:   reqBody,
	}

	if err := c.codec.WriteFrame(frame); err != nil {
		return nil, fmt.Errorf("write frame: %w", err)
	}

	select {
	case resp := <-respCh:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.done:
		return nil, fmt.Errorf("connection closed")
	}
}

func (c *RPCClient) readLoop() {
	defer close(c.done)
	for {
		frame, err := c.codec.ReadFrame()
		if err != nil {
			return
		}

		if frame.Type != TypeResponse {
			continue
		}

		var resp RPCResponse
		if err := json.Unmarshal(frame.Payload, &resp); err != nil {
			continue
		}

		c.mu.Lock()
		ch, ok := c.pending[frame.RequestID]
		c.mu.Unlock()

		if ok {
			ch <- &resp
		}
	}
}

func (c *RPCClient) Close() error {
	return c.conn.Close()
}

// RPCServer handles incoming RPC requests.
type RPCServer struct {
	handlers map[string]RPCHandler
	mu       sync.RWMutex
}

// RPCHandler processes an RPC method call.
type RPCHandler func(ctx context.Context, params json.RawMessage) (any, error)

// NewRPCServer creates an RPC server.
func NewRPCServer() *RPCServer {
	return &RPCServer{handlers: make(map[string]RPCHandler)}
}

// Register adds a handler for a method name.
func (s *RPCServer) Register(method string, handler RPCHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[method] = handler
}

// Serve accepts connections and dispatches requests.
func (s *RPCServer) Serve(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer ln.Close()

	go func() {
		<-ctx.Done()
		ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *RPCServer) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	codec := NewFrameCodec(conn)

	for {
		frame, err := codec.ReadFrame()
		if err != nil {
			return
		}

		go func(f *Frame) {
			resp := s.dispatch(ctx, f)
			respBytes, _ := json.Marshal(resp)
			respFrame := &Frame{
				Magic:     Magic,
				Version:   Version,
				Type:      TypeResponse,
				RequestID: f.RequestID,
				Payload:   respBytes,
			}
			codec.WriteFrame(respFrame)
		}(frame)
	}
}

func (s *RPCServer) dispatch(ctx context.Context, f *Frame) *RPCResponse {
	var req RPCRequest
	if err := json.Unmarshal(f.Payload, &req); err != nil {
		return &RPCResponse{Error: &RPCError{Code: -32700, Message: "parse error"}}
	}

	s.mu.RLock()
	handler, ok := s.handlers[req.Method]
	s.mu.RUnlock()

	if !ok {
		return &RPCResponse{Error: &RPCError{Code: -32601, Message: "method not found: " + req.Method}}
	}

	if req.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, req.Timeout)
		defer cancel()
	}

	result, err := handler(ctx, req.Params)
	if err != nil {
		return &RPCResponse{Error: &RPCError{Code: -32000, Message: err.Error()}}
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return &RPCResponse{Error: &RPCError{Code: -32603, Message: "internal error"}}
	}

	return &RPCResponse{Result: resultJSON}
}
```

### Junior → FAANG: When Custom Protocols Are Worth the Cost

Custom binary protocols are appropriate in a narrow set of situations: when the application controls both client and server, when protocol overhead (HTTP headers, JSON encoding) is measurably impacting performance, or when the protocol semantics (streaming, multiplexing, custom framing) cannot be cleanly expressed in HTTP. In most cases, gRPC with Protobuf provides 95% of the performance benefit of a custom protocol with a fraction of the implementation cost.

The entry-level skill for custom protocols is understanding the frame header components: length prefix (so the receiver knows when a complete frame has arrived), type field (so the receiver knows how to parse the payload), and a request ID or sequence number (so responses can be matched to requests for multiplexed protocols). Reading an existing protocol spec (the Redis Serialization Protocol, the MySQL wire protocol, or WebSocket's frame format) and being able to identify these components is the starting point.

Interview entry point: if asked to design a custom protocol for a specific use case, define the frame header fields first, then the payload encoding (often Protobuf or MessagePack), then the error handling and versioning strategy. Explain versioning as a required first-class feature, not an afterthought, because a deployed protocol is expensive to change.

### Senior @ FAANG: Protocol Versioning as a Long-Term Governance Problem

Custom protocols have a version migration problem that HTTP/gRPC largely avoids through header-based version negotiation. A database wire protocol or message broker protocol must support old clients communicating with new servers for as long as old clients are deployed. At FAANG scale, "as long as old clients are deployed" may mean years, because mobile apps with automatic updates still have a long tail of users who do not update.

The versioning strategy matters at design time. A protocol with no version field forces breaking changes to be deployed simultaneously across all clients and servers, which is impossible at scale. A protocol with a version field allows the server to support multiple protocol versions in parallel, but requires maintaining multiple code paths indefinitely. The compromise that scales best: a version field plus a capability negotiation handshake (the client announces supported capabilities, the server responds with the intersection), similar to how TLS negotiates cipher suites. This allows the server to add new capabilities without breaking old clients, and to deprecate capabilities on a timeline that tracks client version distribution.

Protocol deprecation governance: at L6, the question "when can we stop supporting protocol version N?" requires knowing what fraction of clients are still on that version, what the migration path is, and who is responsible for migrating the remaining clients. Without this governance, protocol versions accumulate indefinitely and the maintenance cost grows with each new version.

---
