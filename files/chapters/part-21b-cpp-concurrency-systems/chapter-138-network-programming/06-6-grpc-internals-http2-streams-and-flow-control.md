## 6. GRPC Internals: HTTP/2 Streams and Flow Control

gRPC uses HTTP/2 as its transport, Protocol Buffers as its serialization format, and length-prefixed framing for individual messages.

### HTTP/2 Multiplexing

HTTP/2 multiplexes multiple logical streams over a single TCP connection. Each RPC call becomes an HTTP/2 stream with a unique stream ID. Frames from different streams interleave on the wire, eliminating HTTP/1.1's head-of-line blocking.

```
TCP Connection
├── Stream 1: UnaryCall /service.Method1
│   ├── HEADERS frame (request metadata)
│   ├── DATA frame (protobuf request, length-prefixed)
│   ├── HEADERS frame (response metadata)
│   └── DATA frame (protobuf response)
├── Stream 3: ServerStreaming /service.Watch
│   ├── HEADERS frame
│   ├── DATA frame (response 1)
│   ├── DATA frame (response 2)
│   └── DATA frame (response N)
└── Stream 5: UnaryCall /service.Method2
    └── ...
```

### gRPC Wire Format

Each gRPC message on the wire has a 5-byte prefix:

```cpp
// gRPC message framing (over HTTP/2 DATA frames)
struct GrpcMessageHeader {
    uint8_t  compressed;  // 0 = uncompressed, 1 = compressed
    uint32_t length;      // big-endian message length
};

std::vector<uint8_t> frame_grpc_message(std::span<const uint8_t> protobuf_bytes,
                                         bool compress = false) {
    std::vector<uint8_t> frame(5 + protobuf_bytes.size());
    frame[0] = compress ? 1 : 0;
    uint32_t len = htonl(static_cast<uint32_t>(protobuf_bytes.size()));
    std::memcpy(&frame[1], &len, 4);
    std::memcpy(&frame[5], protobuf_bytes.data(), protobuf_bytes.size());
    return frame;
}
```

### HTTP/2 Flow Control

HTTP/2 implements per-stream and per-connection flow control using WINDOW_UPDATE frames. Each side advertises how many bytes it is willing to receive. This prevents a fast sender from overwhelming a slow receiver, critical for streaming RPCs.

```cpp
// Simplified flow control state
class FlowController {
public:
    explicit FlowController(int32_t initial_window = 65535)
        : window_(initial_window) {}

    // Called before sending data - returns how many bytes we can send
    int32_t available() const { return window_; }

    // Called after sending data
    void consume(int32_t bytes) {
        window_ -= bytes;
    }

    // Called when WINDOW_UPDATE is received from the peer
    void replenish(int32_t increment) {
        window_ += increment;
        // wake up any writers blocked on zero window
    }

private:
    int32_t window_;
};
```

gRPC's flow control interacts with TCP's flow control. When the gRPC receiver stops sending WINDOW_UPDATE frames, the sender's HTTP/2 window fills. This propagates to the TCP send buffer filling, which causes TCP's own flow control (receive window) to slow the sender at the kernel level. This two-level backpressure is by design.

---
