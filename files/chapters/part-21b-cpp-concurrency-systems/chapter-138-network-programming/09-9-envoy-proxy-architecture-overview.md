## 9. Envoy Proxy Architecture Overview

Envoy is a high-performance C++ edge and service proxy, originally built at Lyft and now the foundation of many service mesh implementations (Istio, AWS App Mesh).

### Architecture

Envoy uses a multi-threaded Reactor architecture:

```
                    ┌────────────────────────┐
                    │     Main Thread        │
                    │  - Config management   │
                    │  - xDS gRPC streams    │
                    │  - Admin API           │
                    └────────────┬───────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                   ▼
    ┌──────────────┐  ┌──────────────┐    ┌──────────────┐
    │  Worker 0    │  │  Worker 1    │    │  Worker N    │
    │  (1 thread)  │  │  (1 thread)  │    │  (1 thread)  │
    │              │  │              │    │              │
    │  Event Loop  │  │  Event Loop  │    │  Event Loop  │
    │  Listeners   │  │  Listeners   │    │  Listeners   │
    │  Connections │  │  Connections │    │  Connections │
    └──────────────┘  └──────────────┘    └──────────────┘
```

**Key design decisions**:

1. **Thread-local architecture**: Each worker thread owns its connections entirely. No mutexes on the data path. A connection is accepted by one worker and lives on that worker's event loop for its entire lifetime.

2. **libevent-based event loop**: Each worker runs a libevent event loop (Reactor pattern). Recent versions are migrating to a custom Event interface that can support `io_uring`.

3. **Filter chains**: Request processing is a pipeline of filters. Each listener has a filter chain that processes bytes (network filters like TCP proxy, TLS) and HTTP-level filters (routing, rate limiting, authentication). Filters are composable and independent.

4. **xDS dynamic configuration**: Envoy receives its configuration dynamically via gRPC streams from a control plane. Listeners (LDS), routes (RDS), clusters (CDS), endpoints (EDS), and secrets (SDS) can all be updated without restart.

5. **Hot restart**: Envoy can restart in-place, passing listen sockets from the old process to the new one via Unix domain sockets, draining existing connections gracefully.

### Connection Handling in Envoy (Simplified)

Envoy's filter chain is a linked list of `NetworkFilter` objects. Each filter's `on_data` returns `Continue` to pass data downstream or `StopIteration` to buffer it (e.g., waiting for the full TLS handshake). This design allows TLS termination, HTTP/2 framing, and routing logic to be composed as independent filters without any filter knowing about the others, the same architectural principle as Go's `http.Handler` middleware chain.
```cpp
// Conceptual model of Envoy's filter chain processing
class NetworkFilter {
public:
    virtual ~NetworkFilter() = default;

    enum class Status { Continue, StopIteration };

    virtual Status on_data(Buffer& data, bool end_stream) = 0;
    virtual Status on_new_connection() = 0;
};

class TlsFilter : public NetworkFilter {
    Status on_new_connection() override {
        // Perform TLS handshake
        // Populate connection metadata (SNI, client cert)
        return Status::Continue;
    }

    Status on_data(Buffer& data, bool end_stream) override {
        // Decrypt incoming data, encrypt outgoing data
        return Status::Continue;
    }
};

class HttpConnectionManager : public NetworkFilter {
    Status on_data(Buffer& data, bool end_stream) override {
        // Parse HTTP frames (HTTP/1.1 or HTTP/2)
        // Route to upstream cluster
        // Apply HTTP filters (auth, rate limit, etc.)
        return Status::Continue;
    }
};

// A listener's filter chain
// TLS → HttpConnectionManager → [Router → Upstream]
```

Envoy achieves millions of requests per second on modern hardware. Its architecture demonstrates how the Reactor pattern, thread-local design, and careful avoidance of shared mutable state produce extreme performance in C++.

---
