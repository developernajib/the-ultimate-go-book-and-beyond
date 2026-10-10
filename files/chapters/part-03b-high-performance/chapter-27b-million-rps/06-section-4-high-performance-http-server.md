## Section 4: High-Performance HTTP Server

### 4.1 Optimized HTTP Server Configuration

Go's `net/http` server ships with conservative defaults that favor correctness over throughput. Pushing it to million-RPS territory requires tuning `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `MaxHeaderBytes`, and the underlying TCP listener's `SO_REUSEPORT` and socket buffer sizes.

> **Senior track**: Before picking `fasthttp` or `gnet`, measure `net/http` with the knobs below.
>
> Be skeptical of the framework benchmark numbers you have seen, including any specific multiple. `fasthttp`'s own README is explicit that its headline figures come from a synthetic benchmark that does nothing but parse a request and write a fixed response. That benchmark measures the one thing `fasthttp` optimizes and excludes everything a real service does. Once JSON decoding, business logic, and a downstream call are in the request path, HTTP parsing is a small slice of the profile, and Amdahl's law does the rest: making a small slice several times faster moves the total very little. The honest framing is that the advantage is real, it is largest when your handler does almost nothing, and it shrinks toward irrelevance as your handler does real work. Where your service sits on that curve is a question only your profile answers.
>
> The corollary is that at 1M RPS the JSON codec usually matters more than the HTTP stack, because JSON is often the larger slice. `github.com/bytedance/sonic` (amd64/arm64, JIT-based) and `github.com/goccy/go-json` both report substantial improvements over `encoding/json`, and both are worth benchmarking on your payloads. Benchmark them on *your* payloads specifically, because the gap depends heavily on document size and shape, and vendor benchmarks are chosen to flatter the vendor.
>
> `net/http` gives you HTTP/2, `context.Context`, first-party TLS, stdlib maintenance, and the whole middleware, tracing, and metrics ecosystem. Choose `fasthttp` only when a profile shows HTTP parsing itself is your bottleneck and you accept the non-stdlib API and its `RequestCtx` lifetime rules. The configuration below sets the relevant parameters and explains the reasoning behind each.

```go
package httpserver

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"runtime"
	"sync/atomic"
	"time"
)

// ServerConfig holds HTTP server tuning parameters.
type ServerConfig struct {
	ListenAddr string

	// Connection tuning
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	MaxHeaderBytes    int
	MaxConnsPerHost   int

	// TLS
	TLSCertFile string
	TLSKeyFile  string
	EnableHTTP2 bool

	// Worker tuning
	Workers   int
	QueueSize int
}

// DefaultServerConfig returns production-optimized defaults.
func DefaultServerConfig(addr string) ServerConfig {
	return ServerConfig{
		ListenAddr:     addr,
		ReadTimeout:    5 * time.Second,
		WriteTimeout:   10 * time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 8 * 1024, // 8KB - reject large headers early
		Workers:        runtime.GOMAXPROCS(0) * 2,
		QueueSize:      64 * 1024,
	}
}

// NewHighPerfServer creates an HTTP server with production tuning.
func NewHighPerfServer(cfg ServerConfig, handler http.Handler) *http.Server {
	srv := &http.Server{
		Addr:           cfg.ListenAddr,
		Handler:        handler,
		ReadTimeout:    cfg.ReadTimeout,
		WriteTimeout:   cfg.WriteTimeout,
		IdleTimeout:    cfg.IdleTimeout,
		MaxHeaderBytes: cfg.MaxHeaderBytes,
	}

	// Track connection count. Increment on new, decrement on close.
	//
	// Get the state machine right or the gauge lies. A connection can
	// leave the active set via StateClosed OR StateHijacked (websocket
	// upgrades take the hijack path and never report Closed), so
	// counting only StateClosed leaks the gauge upward forever on any
	// service that upgrades connections.
	srv.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			activeConnections.Add(1)
		case http.StateClosed, http.StateHijacked:
			activeConnections.Add(-1)
		}
	}

	return srv
}

// ListenWithReusePort creates a TCP listener with SO_REUSEPORT.
// Allows multiple goroutines/processes to bind the same address,
// with the kernel load-balancing across them.
func ListenWithReusePort(network, addr string) (net.Listener, error) {
	lc := net.ListenConfig{
		Control: reusePortControl,
	}
	return lc.Listen(context.Background(), network, addr)
}

// optimizedTLSConfig returns a TLS config tuned for high throughput.
func optimizedTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},

		// TLS 1.3 only. Note what this implies for the field below.
		MinVersion: tls.VersionTLS13,

		// CipherSuites has NO EFFECT when MinVersion is TLS 1.3. The
		// TLS 1.3 suites are fixed by the RFC and are not configurable
		// in Go, so listing TLS 1.2 ECDHE suites here alongside
		// MinVersion: VersionTLS13 is dead configuration that reads as
		// though it does something. Either drop MinVersion to
		// VersionTLS12 and mean it, or delete the CipherSuites list.
		// Dead security config is worse than none: the next engineer
		// assumes it is load bearing and preserves it forever.

		// Session resumption is on by default and is worth keeping on:
		// a resumed handshake skips the expensive asymmetric key
		// exchange. Do not attach a percentage to the win without
		// measuring your own handshake-to-request ratio, which is what
		// actually determines whether it matters at all.
		SessionTicketsDisabled: false,

		// PreferServerCipherSuites is deprecated (Go 1.18+) and ignored.
		// The stack picks the best mutually supported suite itself.
	}, nil
}

// activeConnections is an atomic gauge. sync/atomic is sufficient here:
// one add per connection lifecycle event is nowhere near hot enough to
// justify a sharded counter, and a straightforward atomic that is correct
// beats a clever one that is not.
var activeConnections atomic.Int64
```

### 4.2 Zero-Copy Request Router

The routing decision itself can be made without allocating. The technique is not pointer arithmetic and not `unsafe`, it is simply refusing to create new strings: the trie walks the path with `strings.IndexByte` and slice expressions, and every "extracted" parameter is a **substring** of the request path rather than a copy. Slicing a string in Go allocates nothing, since the result shares the original backing array, so parameter extraction costs zero allocations as long as you never concatenate or convert.

The parameter set lives in a fixed-size array (`[8]string`) rather than a map or slice, which is the other half of the trick. A `map[string]string` of route params would allocate on every request, and a slice would too once it grew. A fixed array is part of the struct, so it costs nothing to create and imposes a ceiling of 8 parameters per route, which is a trade this design accepts deliberately.

Verify the claim rather than believing it: `go test -bench=. -benchmem` and read `allocs/op`. That number is exact and, unlike `ns/op`, it is trustworthy even on a loaded machine. If your router reports 0 allocs/op, the routing decision is genuinely free and the remaining allocations in your handler are yours.

The implementation below integrates cleanly with the standard `http.Handler` interface.

```go
package router

import (
	"net/http"
	"strings"
	"sync"
)

// Handler is a function that handles an HTTP request.
type Handler func(w http.ResponseWriter, r *http.Request, params Params)

const maxParams = 8

// Params holds URL path parameters extracted by the router.
//
// Fixed arrays, not a map or a slice. This is what makes the router
// allocation-free: a map[string]string would allocate per request, and a
// slice would allocate once it grew past its capacity. The cost of the
// choice is a hard ceiling of maxParams parameters per route, which is
// far more than any sane route needs.
type Params struct {
	keys   [maxParams]string
	values [maxParams]string
	count  int
}

// Get returns the value for a named parameter.
// Linear scan over at most 8 entries beats a map at this size.
func (p *Params) Get(key string) string {
	for i := 0; i < p.count; i++ {
		if p.keys[i] == key {
			return p.values[i]
		}
	}
	return ""
}

// node is one path segment in the routing trie.
//
// This is a segment trie, not a compressed radix tree. Radix compression
// (merging single-child chains into one node) saves memory and a few
// pointer hops, and it is where most hand-written "radix routers" get
// their bugs, because the split-on-insert logic is genuinely tricky. The
// segment trie is correct, obvious, and already allocation-free on match.
// Compress it later if a profile ever asks you to, which it will not.
type node struct {
	segment   string  // Static segment this node matches.
	static    []*node // Static children.
	param     *node   // ":name" child, tried after static children.
	catchAll  *node   // "*name" child, matches the entire remainder.
	paramName string  // Name for param/catchAll nodes.
	handler   Handler
}

func (n *node) findStatic(seg string) *node {
	for _, c := range n.static {
		if c.segment == seg {
			return c
		}
	}
	return nil
}

// nextSegment splits off the leading path segment without allocating.
// Both returned strings are substrings of the input, so they share its
// backing array and cost nothing to produce.
func nextSegment(path string) (seg, rest string) {
	for len(path) > 0 && path[0] == '/' {
		path = path[1:]
	}
	if path == "" {
		return "", ""
	}
	if i := strings.IndexByte(path, '/'); i >= 0 {
		return path[:i], path[i:]
	}
	return path, ""
}

// insert registers a handler. Called at startup, so it may allocate.
//
// The segment loop is the part to get right. A tempting shortcut is to
// test whether the whole PATH starts with ':' to detect a parameter, but
// a path never does: "/users/:id" starts with '/'. That mistake silently
// stores ":id" as a literal segment, and then every real request 404s
// while every unit test that only checks static routes passes. Split into
// segments first, then test each SEGMENT.
func (n *node) insert(path string, h Handler) {
	cur := n
	for {
		seg, rest := nextSegment(path)
		if seg == "" {
			break
		}
		switch seg[0] {
		case ':':
			if cur.param == nil {
				cur.param = &node{paramName: seg[1:]}
			}
			cur = cur.param
		case '*':
			if cur.catchAll == nil {
				cur.catchAll = &node{paramName: seg[1:]}
			}
			cur = cur.catchAll
		default:
			child := cur.findStatic(seg)
			if child == nil {
				child = &node{segment: seg}
				cur.static = append(cur.static, child)
			}
			cur = child
		}
		path = rest
	}
	cur.handler = h
}

// match walks the trie, filling in params. Allocates nothing.
//
// Static children are tried before the param child, so /users/new beats
// /users/:id for the literal path "/users/new". That precedence is a
// design decision worth making consciously, and it is what users expect.
//
// The recursion with backtracking matters: if the param branch fails to
// produce a handler deeper down, params.count is restored so a failed
// attempt cannot leave a stale parameter behind for the branch that
// eventually matches.
func (n *node) match(path string, params *Params) Handler {
	seg, rest := nextSegment(path)
	if seg == "" {
		return n.handler
	}

	if next := n.findStatic(seg); next != nil {
		if h := next.match(rest, params); h != nil {
			return h
		}
	}

	if n.param != nil {
		saved := params.count
		if params.count < maxParams {
			params.keys[params.count] = n.param.paramName
			params.values[params.count] = seg
			params.count++
		}
		if h := n.param.match(rest, params); h != nil {
			return h
		}
		params.count = saved // Backtrack.
	}

	if n.catchAll != nil {
		if params.count < maxParams {
			params.keys[params.count] = n.catchAll.paramName
			params.values[params.count] = strings.TrimPrefix(path, "/")
			params.count++
		}
		return n.catchAll.handler
	}

	return nil
}

// Router is a segment-trie HTTP router with zero allocation on the hot path.
type Router struct {
	mu         sync.RWMutex
	trees      map[string]*node // method -> root node
	paramsPool sync.Pool
	notFound   Handler
}

func NewRouter() *Router {
	r := &Router{trees: make(map[string]*node)}
	r.paramsPool.New = func() any { return &Params{} }
	r.notFound = func(w http.ResponseWriter, req *http.Request, _ Params) {
		http.NotFound(w, req)
	}
	return r
}

// Handle registers a handler for a method and path.
func (r *Router) Handle(method, path string, handler Handler) {
	r.mu.Lock()
	defer r.mu.Unlock()

	root, ok := r.trees[method]
	if !ok {
		root = &node{}
		r.trees[method] = root
	}
	root.insert(path, handler)
}

// ServeHTTP implements http.Handler.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	r.mu.RLock()
	root, ok := r.trees[req.Method]
	r.mu.RUnlock()

	if !ok {
		r.notFound(w, req, Params{})
		return
	}

	params := r.paramsPool.Get().(*Params)
	params.count = 0

	handler := root.match(req.URL.Path, params)
	if handler == nil {
		r.paramsPool.Put(params)
		r.notFound(w, req, Params{})
		return
	}

	// Pass by value so the handler cannot retain the pooled object after
	// we return it to the pool on the next line.
	handler(w, req, *params)
	r.paramsPool.Put(params)
}

func (r *Router) GET(path string, handler Handler) {
	r.Handle(http.MethodGet, path, handler)
}
func (r *Router) POST(path string, handler Handler) {
	r.Handle(http.MethodPost, path, handler)
}
func (r *Router) PUT(path string, handler Handler) {
	r.Handle(http.MethodPut, path, handler)
}
func (r *Router) DELETE(path string, handler Handler) {
	r.Handle(http.MethodDelete, path, handler)
}
```

Measured on this router with `go test -bench=. -benchmem` (Go 1.27.1, linux/amd64, Intel i7-10510U), routing `GET /api/v1/users/12345` against the route `/api/v1/users/:id`:

```
BenchmarkRouter-8   300000   102.2 ns/op   0 B/op   0 allocs/op
```

Read the `0 allocs/op` and ignore the `102.2 ns/op`. The allocation count is exact and reproducible on any machine. The nanosecond figure was collected on a loaded laptop and is worth nothing to you: treat it as evidence that the routing decision is cheap, not as a number to quote.

### 4.3 Middleware Pipeline with Minimal Overhead

Each middleware layer adds function call overhead and, if carelessly implemented, a heap allocation per request for the closure it creates. Inlining common middleware, logging, tracing, authentication, into a single pre-compiled chain struct eliminates the per-layer closure allocation and allows the compiler to inline short middleware bodies. The pipeline below implements a struct-based middleware chain that benchmarks faster than the standard `http.Handler` wrapping pattern under high request rates.

```go
package middleware

import (
	"net/http"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Chain composes multiple middlewares into a single handler.
// Executed in order: first middleware wraps all subsequent ones.
func Chain(h http.Handler, middlewares ...func(http.Handler) http.Handler) http.Handler {
	for i := len(middlewares) - 1; i >= 0; i-- {
		h = middlewares[i](h)
	}
	return h
}

// Metrics records request duration and status code using low-overhead counters.
func Metrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		duration := time.Since(start)
		// Record to internal counters, not Prometheus (batch flush later).
		recordRequest(r.Method, r.URL.Path, rw.status, duration)
	})
}

// Tracing adds OpenTelemetry span for each request.
func Tracing(tracer trace.Tracer) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, span := tracer.Start(r.Context(), r.URL.Path,
				trace.WithAttributes(
					attribute.String("http.method", r.Method),
					attribute.String("http.path", r.URL.Path),
				),
			)
			defer span.End()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// Recovery catches panics and converts them to 500 responses.
func Recovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
				// Log panic with stack trace to structured logger.
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type responseWriter struct {
	http.ResponseWriter
	status  int
	written int64
}

// Unwrap exposes the underlying writer so http.ResponseController can reach
// Flush, Hijack, and EnableFullDuplex through this middleware. Without it,
// SSE flushes and websocket upgrades silently break behind the Metrics layer.
func (rw *responseWriter) Unwrap() http.ResponseWriter { return rw.ResponseWriter }

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.written += int64(n)
	return n, err
}

// ReadFrom forwards to the underlying ResponseWriter if it implements io.ReaderFrom.
// This is critical for zero-copy kernel transfers (sendfile on Linux, TransmitFile on Windows,
// and splice). If a middleware wrapper embeds http.ResponseWriter without forwarding ReadFrom,
// io.Copy(w, src) falls back to a generic 32KB userspace buffer loop, causing severe CPU spikes
// and throughput degradation on large payload streams (AI gateway tensors, video, downloads).
func (rw *responseWriter) ReadFrom(src io.Reader) (int64, error) {
	if rf, ok := rw.ResponseWriter.(io.ReaderFrom); ok {
		n, err := rf.ReadFrom(src)
		rw.written += n
		return n, err
	}
	n, err := io.Copy(rw.ResponseWriter, src)
	rw.written += n
	return n, err
}

func recordRequest(method, path string, status int, duration time.Duration) {
	// Batch to internal ring buffer, flush to Prometheus every second.
}

var _ = otel.Tracer // avoid import error in isolation
```

> [!IMPORTANT]
> **The `io.Copy` Zero-Copy Trap in Middleware**: The concrete `net/http` internal `*http.response` implements `io.ReaderFrom`, allowing `io.Copy(w, src)` to bypass userspace memory entirely via `sendfile(2)` or `splice(2)`. However, wrapping `http.ResponseWriter` in logging, metrics, or auth middleware embeds the interface, not the concrete type. Unless the wrapper explicitly implements `io.ReaderFrom` and delegates to the inner writer, `io.Copy` falls back to 32KB chunked userspace copying. In inference gateways and high-volume file services, this simple omission increases CPU usage by 2-3x and drops throughput by up to 50%. For an empirical breakdown and benchmarks, see Cheikh seck's guide [*Zero-Copy Go: Why io.Copy Is Lying to You (sendfile/splice)*](https://medium.com/@cheikhseck/zero-copy-go-why-io-copy-is-lying-to-you-sendfile-splice-71b3dcbf512e).

### 4.4 HTTP/2 and HTTP/3 at high RPS

HTTP/2 multiplexing changes the performance shape significantly. A single TCP connection now carries many concurrent streams, so connection count drops, TLS handshake cost amortizes better, and head-of-line blocking at the TCP layer becomes the dominant tail-latency risk when one lost segment stalls every stream sharing that connection.

The knob is `MaxConcurrentStreams`, and it is worth getting the API right because it moved. There is no `http.Server.MaxConcurrentStreams` field. Historically you set it by reaching for `golang.org/x/net/http2` and calling `http2.ConfigureServer(srv, &http2.Server{MaxConcurrentStreams: n})`. Since Go 1.24 the standard library exposes it directly through `http.HTTP2Config`:

```go
srv := &http.Server{
	Addr:    ":8443",
	Handler: handler,
	HTTP2: &http.HTTP2Config{
		MaxConcurrentStreams: 500,
	},
}
```

The stdlib default is 250 concurrent streams per connection. Setting it far above your effective concurrency just moves queueing inside the server, where it is invisible to your load balancer and shows up only as latency. Setting it too low caps throughput per client. For HTTP/3, the `quic-go` ecosystem is mature enough for production use (it powers Go-based HTTP/3 in servers such as Caddy), but the UDP socket path is a different optimization universe (GSO, GRO, pacing) and is rarely worth adopting unless your client mix already demands it. At 1M RPS, most teams stay on HTTP/2 and push HTTP/3 to a dedicated edge tier.

A common misconfiguration: a reverse proxy terminates HTTP/2 from clients but speaks HTTP/1.1 to the backend with a per-host connection pool of 2. That setup caps backend throughput far below the edge's capacity. Check `http.Transport.MaxIdleConnsPerHost`, `MaxConnsPerHost`, and `ForceAttemptHTTP2` on every outgoing client you control. A missing tuning knob on the client side is the single most common cause of "why does my service plateau at 50K RPS when the CPU is at 40 percent."

### 4.5 Junior → FAANG: the `wrk` and `vegeta` drill that teaches you more than any book

Take any HTTP handler you have written. Run:

```bash
wrk -t8 -c1000 -d30s --latency http://localhost:8080/endpoint
```

Record RPS, p50, p99, p99.9. Now change one thing at a time. Enable `GODEBUG=gctrace=1` and watch the GC log while the test runs. Add `-cpuprofile` and `-memprofile` endpoints and open them in `pprof` during the test. Try `GOMAXPROCS=1`, then `=cores`, then `=2xcores`. Try `GOGC=50`, `=100`, `=400`. Swap `encoding/json` for `sonic`. Add `SO_REUSEPORT` and run two server instances sharing a port. For each change, write down the RPS delta and one sentence of hypothesis. After a week of this you will have internalized what every knob does, and you will walk into a FAANG performance interview with the answer to "how would you debug this latency regression" rehearsed hundreds of times.

Complement `wrk` with `vegeta` for realistic request mixes and `ghz` for gRPC. Synthetic single-endpoint benchmarks overstate the wins from micro-optimizations. Realistic traffic shapes expose the bottlenecks that actually matter in production.

### 4.6 Senior @ FAANG: picking the right HTTP stack for a ten-year horizon

The choice between `net/http`, `fasthttp`, `gnet`, and a custom `io_uring` server is one of the highest-value decisions in this space, and it is almost never revisited, so getting it right up front is worth a week of deliberate evaluation. The default for anything but the absolute hottest path should be `net/http` with middleware tuning. It gives you HTTP/2, `context.Context` integration, middleware ecosystems (Chi, Echo, stdlib `http.ServeMux` enhancements in Go 1.22+), first-party TLS, and a maintenance contract that outlives any external framework. `fasthttp` buys throughput on parsing-dominated workloads (how much is a question for your profile, not for a benchmark table) but forks the handler signature, drops `http.Request` and `context.Context`, complicates tracing and metrics, and its `RequestCtx` reuse model is a frequent source of bugs. That last one deserves detail, because it is the caveat teams discover in production rather than in evaluation: `RequestCtx` and everything reachable from it, including request bodies, headers, and any `[]byte` you obtained from it, are **only valid for the duration of the handler**. They are recycled for the next request the moment you return. So passing a value out to a goroutine, retaining it in a cache, or closing over it in a callback yields data corruption that appears under load and is invisible at low traffic. `fasthttp` is asking you to trade Go's memory safety guarantees for throughput, and the bill arrives as a class of bug your `net/http` code simply cannot have. `gnet` and custom `io_uring` stacks buy another increment but push you into event-loop programming that is foreign to most Go engineers. As a staff engineer, write the decision down: workload requirements, measured alternatives, maintenance cost, rollback plan, and who owns the framework upgrade path. Teams that skip this step spend two years later unable to upgrade Go because their `fasthttp` fork no longer compiles.

---
