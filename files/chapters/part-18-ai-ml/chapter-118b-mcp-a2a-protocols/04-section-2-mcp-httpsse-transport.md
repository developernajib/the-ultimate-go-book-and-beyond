## 118B.3 MCP Streamable HTTP Transport

MCP's remote transport is **Streamable HTTP**, and its defining feature is that there is exactly **one** endpoint. A single URL path (say `https://example.com/mcp`) serves both POST and GET.

This matters because a lot of material still describes the older design, in which a `GET /sse` endpoint delivered an `endpoint` event naming a separate `POST /message` URL. That was the **HTTP+SSE transport of revision 2024-11-05, and Streamable HTTP replaced it.** It survives only as a backwards-compatibility path for old servers. If you are writing a new server, do not build it, and if you see an `endpoint` event in a tutorial, you are reading pre-2025 material.

How the one endpoint works:

- **POST** carries every client message. If the body is a notification or response, the server returns `202 Accepted` with no body. If it is a request, the server replies either with `Content-Type: application/json` (a single JSON object) or `Content-Type: text/event-stream` (an SSE stream that eventually carries the response). Clients must handle both, and must send an `Accept` header listing both types.
- **GET** optionally opens an SSE stream for server-initiated messages. A server with nothing to push may answer `405 Method Not Allowed`.

Two security requirements are stated as MUST/SHOULD in the spec and are the first things reviewers look for:

- **Validate the `Origin` header** and reject invalid ones with `403`. Without this, a web page the user visits can drive their local MCP server through DNS rebinding. The browser will happily send those requests - only your check stops them.
- **Bind to `127.0.0.1`, not `0.0.0.0`, when running locally.** A local MCP server on `0.0.0.0` is exposed to the whole network, and MCP servers hold tools.

```go
package mcphttp

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/yourorg/mcp"
)

// StreamableHTTPServer implements the MCP Streamable HTTP transport.
type StreamableHTTPServer struct {
	server *mcp.Server
	// allowedOrigins is the Origin allowlist. Empty means "reject any request
	// that carries an Origin header at all", which is the right default for a
	// local server that expects only non-browser clients.
	allowedOrigins map[string]bool

	mu       sync.RWMutex
	sessions map[string]*session
}

// session holds the server-to-client SSE stream, if the client opened one.
type session struct {
	// writes serialises access to the SSE stream. An http.ResponseWriter must
	// not be written from two goroutines at once, and this transport invites
	// exactly that: the GET handler owns the stream while POST handlers arrive
	// on their own goroutines wanting to push to it. Without this mutex the
	// race detector fires and, unprotected, the output interleaves into
	// corrupt frames.
	writes sync.Mutex
	enc    *sseEncoder
	done   chan struct{}
}

func NewStreamableHTTPServer(server *mcp.Server, allowedOrigins []string) *StreamableHTTPServer {
	set := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		set[o] = true
	}
	return &StreamableHTTPServer{
		server:         server,
		allowedOrigins: set,
		sessions:       make(map[string]*session),
	}
}

// Routes registers the single MCP endpoint for both methods.
func (h *StreamableHTTPServer) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", h.withOriginCheck(h.handlePOST))
	mux.HandleFunc("GET /mcp", h.withOriginCheck(h.handleGET))
	mux.HandleFunc("DELETE /mcp", h.withOriginCheck(h.handleDELETE))
	return mux
}

// withOriginCheck rejects cross-origin requests before they reach a handler.
//
// This is the DNS rebinding defense and the spec requires it. The attack: a
// user visits attacker.com, which resolves its own hostname to 127.0.0.1 and
// then issues requests to the user's local MCP server. Same-origin policy does
// not save you, because to the browser the origin really is attacker.com. The
// Origin header is what tells you the request came from a page rather than a
// real client.
func (h *StreamableHTTPServer) withOriginCheck(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !h.allowedOrigins[origin] {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func newSessionID() (string, error) {
	// Cryptographically secure and unpredictable, as the spec requires.
	// A timestamp-derived ID (fmt.Sprintf("sess-%d", time.Now().UnixNano()))
	// is guessable to within a narrow window, which turns session hijacking
	// into a brute-force problem rather than an impossible one.
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (h *StreamableHTTPServer) handlePOST(w http.ResponseWriter, r *http.Request) {
	var req mcp.Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	resp := h.server.HandleRequest(r.Context(), &req)

	// A notification produced no response: acknowledge with 202 and no body,
	// exactly as the spec prescribes.
	if resp == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}

	// Reply on this same POST rather than pushing the answer onto the GET
	// stream. Answering a request over the notification stream is what the old
	// two-endpoint transport did, and it is both a race and a spec violation:
	// the server MUST NOT send a response on the GET stream except when
	// resuming a disconnected one.
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		return
	}
}

// handleGET opens the optional server-to-client SSE stream.
func (h *StreamableHTTPServer) handleGET(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	sessionID := r.Header.Get("Mcp-Session-Id")
	if sessionID == "" {
		var err error
		if sessionID, err = newSessionID(); err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Mcp-Session-Id", sessionID)
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sess := &session{
		enc:  &sseEncoder{w: w, flusher: flusher},
		done: make(chan struct{}),
	}

	h.mu.Lock()
	h.sessions[sessionID] = sess
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.sessions, sessionID)
		h.mu.Unlock()
		close(sess.done)
	}()

	// Block until the client goes away. Returning from an http.HandlerFunc
	// closes the response, so the handler must stay alive for the life of the
	// stream.
	<-r.Context().Done()
}

// handleDELETE lets a client explicitly end its session.
func (h *StreamableHTTPServer) handleDELETE(w http.ResponseWriter, r *http.Request) {
	sessionID := r.Header.Get("Mcp-Session-Id")
	h.mu.Lock()
	sess, ok := h.sessions[sessionID]
	delete(h.sessions, sessionID)
	h.mu.Unlock()

	if ok {
		close(sess.done)
	}
	w.WriteHeader(http.StatusNoContent)
}

// Notify pushes a server-initiated message to a session's SSE stream.
func (h *StreamableHTTPServer) Notify(sessionID string, msg any) error {
	h.mu.RLock()
	sess, ok := h.sessions[sessionID]
	h.mu.RUnlock()
	if !ok {
		return fmt.Errorf("no such session: %s", sessionID)
	}

	// Serialise writes to the shared ResponseWriter.
	sess.writes.Lock()
	defer sess.writes.Unlock()

	select {
	case <-sess.done:
		return fmt.Errorf("session closed")
	default:
	}

	return sess.enc.encode(msg)
}

// sseEncoder writes one SSE event. Callers must hold the session write lock.
type sseEncoder struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func (e *sseEncoder) encode(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	// SSE frames are delimited by a blank line, and data must not contain a
	// raw newline. json.Marshal produces compact single-line output, so this
	// holds. Switching to MarshalIndent here would silently corrupt the stream.
	if _, err := fmt.Fprintf(e.w, "event: message\ndata: %s\n\n", data); err != nil {
		return err
	}
	e.flusher.Flush()
	return nil
}
```

`HandleRequest` is the exported form of the dispatcher from Section 118B.2. Bind the listener explicitly when you run this locally:

```go
// Right: reachable only from this machine.
var srv = &http.Server{Addr: "127.0.0.1:8080", Handler: h.Routes()}

// Wrong: ":8080" binds 0.0.0.0 and publishes your tools to the network.
```

---

### Junior → FAANG: Streamable HTTP as a Go Streaming Interview Topic

The Streamable HTTP transport is a concrete exercise in Go streaming HTTP, and it appears in infrastructure interviews. The key technical concepts: `http.Flusher` (the interface a `ResponseWriter` must implement to push bytes before the handler returns), the SSE frame format (`event:` line, `data:` line, blank line terminator), connection lifecycle (detecting client disconnect via request context cancellation), and the fact that returning from a handler closes the response, so a streaming handler must block.

The single-endpoint design is worth understanding as a deliberate choice. The predecessor used two endpoints and made the client learn the POST URL from an `endpoint` event on the SSE stream. That coupling meant no stream, no way to send anything: a plain request-response server was forced to maintain a long-lived connection it did not need. Streamable HTTP inverts it. POST answers on the POST, so a simple server never opens a stream at all, and the SSE stream becomes optional, used only for server-initiated messages.

On why SSE rather than WebSockets: SSE is plain HTTP, so it traverses proxies, load balancers, and corporate middleboxes that mangle or block WebSocket upgrades. It needs no separate protocol negotiation and reconnects natively via `Last-Event-ID`. MCP needs server-to-client push and ordinary requests, not full-duplex framing, and SSE covers that at lower operational cost. This is the tradeoff analysis interviewers are listening for, and note the framing: **MCP has no WebSocket transport**, so this is a design rationale, not a menu of options.

The concurrency bug in this transport is a good interview discussion in its own right. An `http.ResponseWriter` belongs to the goroutine running its handler. The GET handler owns the SSE stream, but pushes to that stream originate on other goroutines. Writing to the same `ResponseWriter` from two goroutines is a data race that `go test -race` catches immediately and that, in production without the detector, produces interleaved bytes and malformed frames. The fix is a mutex around the stream, and recognizing the need for it unprompted is the signal.

### Senior @ FAANG: SSE Transport Reliability as Production Engineering Concern

At senior level, the SSE transport introduces reliability concerns that the basic implementation does not address. SSE connections are long-lived and fragile: they break on network interruptions, load balancer timeouts, and server restarts. The production SSE transport must implement: client reconnection with exponential backoff (clients that disconnect and reconnect must replay missed events), session state management that survives server restarts (session IDs must be persistent, not in-memory), load balancer configuration for long-lived connections (timeout must be longer than the maximum tool execution time), and connection health monitoring (detect zombie connections that are technically open but not receiving data). Each of these concerns requires explicit design and testing before the transport is production-ready. Senior engineers who enumerate these concerns in a design review prevent the operational surprises that occur when the basic implementation is deployed to production without addressing them.

---

### Production Case Study: Hardening Go MCP Gateways ("The Bouncer Pattern")

In [Building a MCP Architecture with Golang and SSE](https://medium.com/@oggy.tech/building-a-mcp-architecture-with-golang-and-sse-462f4db896db), Oggy explores the practical architectural realities of deploying Go-based MCP servers into production environments. While local development servers communicate over stdio, remote AI agent architectures require robust network boundaries.

#### 1. Why SSE Over WebSockets in Agentic Infrastructure

Early implementations often attempt to adapt WebSockets for agent tool routing. In production infrastructure, SSE coupled with HTTP POST proves superior for three reasons:

1. **Middlebox Compatibility**: WebSockets require an explicit HTTP `101 Switching Protocols` handshake. Enterprise firewalls, corporate forward proxies, and standard API gateways frequently drop or terminate long-lived WebSocket connections after short idle windows (e.g., 60 seconds on standard AWS ALBs without custom ping configurations). SSE streams are standard HTTP (`Content-Type: text/event-stream`), traversing CDNs and reverse proxies without custom configuration.
2. **Decoupled Symmetry**: AI agents do not require full-duplex multiplexing on a single TCP socket. Tool invocations are naturally discrete HTTP POST operations, while agent notifications and status updates flow downward over the SSE stream. This separation permits standard HTTP load balancers to route POST requests independently across a stateless worker pool.
3. **Resilience & Reconnection**: Native SSE transports support reconnection with the `Last-Event-ID` header. If a network partition interrupts the stream, clients automatically reconnect without requiring a custom transport layer protocol.

#### 2. The Bouncer Pattern: Guardrails for Tool Execution

Unchecked tool execution exposes LLM agent systems to context window saturation, runaway costs, and security vulnerabilities. A production Go MCP gateway acts as an enforcement boundary between the model and internal tools.

```
                    ┌─────────────────────────────────────────────────────┐
                    │                 MCP Gateway Bouncer                 │
                    │                                                     │
[LLM Agent Client]  │  ┌──────────────┐   ┌─────────────┐   ┌──────────┐  │   ┌──────────────┐
       │            │  │ JSON Schema  │──►│ Rate Limit  │──►│ Tool     │──┼──►│ Backend Tool │
       │───POST────►│  │ Validator    │   │ & Authz     │   │ Dispatch │  │   │ (DB/API/FS)  │
       │            │  └──────────────┘   └─────────────┘   └──────────┘  │   └──────────────┘
       │            │                                             │       │          │
       │            │  ┌──────────────────────────────────────────┘       │          │
       │            │  ▼                                                  │          │
       │            │  ┌───────────────────────┐                          │          │
       │            │  │ Token-Aware Truncator │◄─────────────────────────┼──────────┘
       │            │  │ (Max 4,000 tokens)    │                          │     (Raw Result)
       │            │  └───────────────────────┘                          │
       │            │              │                                      │
       │◄──HTTP 200─┴──────────────┴──────────────────────────────────────┘
       │   (Formatted JSON-RPC Result or Graceful Error)
```

The gateway enforces three defensive mechanisms:

##### A. Token-Aware Payload Truncation Middleware

When a tool query returns oversized responses (e.g., querying 10,000 database rows or an entire Git diff), passing the raw output directly to the LLM overflows its context window or drives high token costs. A payload truncator middleware intercepts responses before serialization:

```go
package mcphttp

import (
	"context"
	"fmt"
	"unicode/utf8"

	"github.com/yourorg/mcp"
)

// TruncateMiddleware enforces a maximum byte budget on tool outputs.
func TruncateMiddleware(maxBytes int) mcp.Middleware {
	return func(next mcp.ToolHandler) mcp.ToolHandler {
		return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			result, err := next(ctx, req)
			if err != nil {
				return nil, err
			}

			for i := range result.Content {
				item := &result.Content[i]
				if item.Type == "text" && len(item.Text) > maxBytes {
					// Ensure valid UTF-8 boundary before slicing
					validPrefix := item.Text[:maxBytes]
					for !utf8.ValidString(validPrefix) {
						validPrefix = validPrefix[:len(validPrefix)-1]
					}
					omittedBytes := len(item.Text) - len(validPrefix)
					item.Text = fmt.Sprintf(
						"%s\n\n[WARNING: Tool output exceeded limit. %d bytes truncated. Refine filter parameters or paginate.]",
						validPrefix,
						omittedBytes,
					)
				}
			}

			return result, nil
		}
	}
}
```

##### B. Defensive Error Modeling (HTTP 200 vs. HTTP 500)

A frequent implementation error in remote MCP servers is returning HTTP 500 Internal Server Error when an underlying tool fails (such as an invalid SQL query or a missing file). HTTP 5xx errors typically cause agent orchestration frameworks (such as LangChain, AutoGen, or custom agent loops) to crash or abort the multi-turn session.

In the MCP specification, transport-level errors (network failures, invalid HTTP headers) return HTTP status codes, whereas tool execution errors must return **HTTP 200** with the error encapsulated in the JSON-RPC payload:

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Query failed: table 'audit_events_2023' does not exist. Available tables: 'audit_events_2025', 'audit_events_2026'."
      }
    ],
    "isError": true
  }
}
```

By returning `isError: true` alongside actionable diagnostic text within an HTTP 200 envelope, the LLM agent parses the feedback, modifies its SQL query or parameters, and self-corrects on the next iteration without dropping the active connection.
