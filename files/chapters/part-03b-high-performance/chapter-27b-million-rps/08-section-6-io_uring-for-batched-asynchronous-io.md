## Section 6: io_uring for Batched Asynchronous I/O

### 6.1 io_uring Architecture

**First, correct the name.** io_uring is routinely called "kernel bypass," and it is not kernel bypass. Every operation you submit is still executed by the kernel, using the kernel's own file, socket, and block layers, subject to the kernel's permission checks. Nothing is bypassed. What io_uring removes is the requirement of **one syscall per operation**, by replacing it with shared-memory ring buffers that let you batch many operations into a single `io_uring_enter()` call, and to overlap submission with completion.

True kernel bypass is a different technique with a different bargain: **DPDK** and **AF_XDP** hand a NIC queue directly to a userspace process, so packets never traverse the kernel network stack at all. That buys more, and it costs you the kernel's TCP/IP stack, its tooling (`tcpdump`, `iptables`, `ss`), and its security model, all of which you must now reimplement or do without. Conflating the two leads teams to expect bypass-class numbers from io_uring and to be baffled when they do not arrive.

With that settled: io_uring (Linux 5.1+, with the high-throughput features stabilizing in 5.15+ and 6.x) gives you a submission queue and a completion queue shared between user space and kernel. You write submission entries into the ring, tell the kernel about them (one syscall for the whole batch, or with `SQPOLL` a kernel thread polls the ring and you make no syscall at all in the steady state), and later harvest completions from the other ring.

The win is therefore **amortization**, not elimination. A syscall costs a mode transition (made more expensive by Spectre/Meltdown mitigations, which is why numbers from before 2018 are useless here), so batching 64 operations into one `io_uring_enter()` divides that fixed cost by 64. Whether that matters to you is entirely a question of what fraction of your CPU currently goes to syscalls, which is a thing you can read off a profile rather than estimate from a book. If `syscall` time is a small share of your profile, dividing it by 64 changes nothing you can measure.

> **Senior track (2026 reality check)**: io_uring has no stdlib support in Go as of 1.27, and `net/http` uses `epoll` via the runtime netpoller. Third-party bindings exist (`github.com/iceber/iouring-go`, `github.com/godzie44/go-uring`, `github.com/hodgesds/iouring-go`) but none are considered frozen-API production-grade the way `net/http` is. The two realistic paths are (1) call `iouring-go` directly for a specific hot path (log flushing, batched disk writes, fanout reads) while letting `net/http` handle network I/O, or (2) adopt an event-loop framework such as `panjf2000/gnet` v2, which does not use io_uring but does cut syscall and goroutine-per-connection overhead by driving `epoll` on Linux (`kqueue` on BSD/Darwin) directly. Several CVEs in 2023 to 2024 led some cloud providers (Google, DigitalOcean) to disable io_uring inside untrusted workloads, so verify your kernel and seccomp policy before designing around it.

```
┌────────────────────────────────────────────────────────────────┐
│                     io_uring Architecture                      │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  User Space                │  Kernel Space                     │
│  ───────────               │  ────────────                     │
│                            │                                   │
│  ┌──────────────────┐      │  ┌────────────────────────────┐   │
│  │  Submission Queue│ ──►  │  │  io_uring Kernel Driver    │   │
│  │  Ring (SQR)      │      │  │  - Async I/O               │   │
│  │  [SQE][SQE][SQE] │      │  │  - Fixed buffers           │   │
│  └──────────────────┘      │  │  - Registered files        │   │
│                            │  └────────────────────────────┘   │
│  ┌──────────────────┐      │                                   │
│  │  Completion Queue│ ◄──  │  vs epoll, honestly:              │
│  │  Ring (CQR)      │      │  - 1 syscall per BATCH, not op    │
│  │  [CQE][CQE][CQE] │      │  - SQPOLL: 0 syscalls, burns core │
│  └──────────────────┘      │  - Registered buffers cut copies  │
│                            │  - STILL the kernel doing the I/O │
│  Rings live in memory      │  - NOT kernel bypass (see DPDK,   │
│  shared with the kernel    │    AF_XDP for that)               │
└────────────────────────────────────────────────────────────────┘
```

### 6.2 Event-Loop HTTP Server via gnet

gnet is a high-performance Go networking framework that drives `epoll` on Linux (or `kqueue` on BSD/Darwin) directly in an event loop, handling I/O with fewer goroutines and syscalls than the standard `net/http` package and enabling higher throughput at the same CPU budget. It is not an io_uring stack, but its event-loop model is the most common production alternative to `net/http` when connection-handling overhead dominates. The server below registers read and write event handlers with gnet's event loop, processes HTTP requests without per-connection goroutines, and demonstrates the throughput difference in the embedded benchmark results.

```go
package iouring

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/panjf2000/gnet/v2"
)

// HTTPServer implements a high-performance HTTP server using gnet,
// which drives epoll on Linux (kqueue on BSD/Darwin) via an event loop.
type HTTPServer struct {
	gnet.BuiltinEventEngine

	addr      string
	multicore bool
	eng       gnet.Engine

	// Request router (from Section 4.2)
	router RequestRouter

	// Stats
	connected atomic.Int64
	requests  atomic.Uint64
}

// RequestRouter dispatches HTTP requests to handlers.
type RequestRouter interface {
	Route(method, path string) (Handler, bool)
}

// Handler processes a request and writes the response.
type Handler func(ctx *RequestContext) error

// OnBoot is called when the server starts.
func (s *HTTPServer) OnBoot(eng gnet.Engine) gnet.Action {
	s.eng = eng
	log.Printf("gnet HTTP server listening on %s (multicore=%v)", s.addr, s.multicore)
	return gnet.None
}

// OnOpen is called when a new connection is accepted.
func (s *HTTPServer) OnOpen(c gnet.Conn) ([]byte, gnet.Action) {
	s.connected.Add(1)
	// Attach per-connection state.
	c.SetContext(&connContext{})
	return nil, gnet.None
}

// OnClose is called when a connection is closed.
func (s *HTTPServer) OnClose(c gnet.Conn, err error) gnet.Action {
	s.connected.Add(-1)
	return gnet.None
}

// OnTraffic is called when data arrives on a connection.
// This is the hot path - keep it allocation-free.
func (s *HTTPServer) OnTraffic(c gnet.Conn) gnet.Action {
	// Read all available data.
	buf, _ := c.Next(-1)
	if len(buf) == 0 {
		return gnet.None
	}

	ctx := c.Context().(*connContext)

	// Parse HTTP request incrementally.
	consumed, complete := ctx.parser.Feed(buf)
	c.Discard(consumed)

	if !complete {
		return gnet.None // Wait for more data.
	}

	s.requests.Add(1)

	// Route to handler.
	handler, ok := s.router.Route(ctx.parser.Method, ctx.parser.Path)
	if !ok {
		c.AsyncWrite(notFoundResponse, nil)
		return gnet.None
	}

	// Process request.
	reqCtx := AcquireCtx()
	reqCtx.Method = ctx.parser.Method
	reqCtx.Path = ctx.parser.Path
	copy(reqCtx.Body[:], ctx.parser.Body)
	reqCtx.BodyLen = len(ctx.parser.Body)

	if err := handler(reqCtx); err != nil {
		c.AsyncWrite(internalErrorResponse, nil)
		ReleaseCtx(reqCtx)
		return gnet.None
	}

	// Write response.
	resp := buildResponse(reqCtx)
	c.AsyncWrite(resp, func(c gnet.Conn, err error) error {
		ReleaseCtx(reqCtx)
		return err
	})

	ctx.parser.Reset()
	return gnet.None
}

// OnTick is called periodically for maintenance tasks.
func (s *HTTPServer) OnTick() (delay time.Duration, action gnet.Action) {
	return 5 * time.Second, gnet.None
}

// connContext holds per-connection state.
type connContext struct {
	parser HTTPParser
}

var (
	notFoundResponse      = []byte("HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found")
	internalErrorResponse = []byte("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 21\r\n\r\nInternal Server Error")
)

// buildResponse constructs an HTTP response from the request context.
func buildResponse(ctx *RequestContext) []byte {
	// In production: use pooled byte slices.
	status := "200 OK"
	if ctx.StatusCode > 0 {
		status = fmt.Sprintf("%d %s", ctx.StatusCode, http.StatusText(ctx.StatusCode))
	}
	body := ctx.Response[:ctx.ResponseLen]
	header := fmt.Sprintf("HTTP/1.1 %s\r\nContent-Length: %d\r\nContent-Type: application/json\r\n\r\n",
		status, len(body))
	resp := make([]byte, len(header)+len(body))
	copy(resp, header)
	copy(resp[len(header):], body)
	return resp
}

// HTTPParser is a minimal zero-copy HTTP/1.1 request parser.
type HTTPParser struct {
	Method  string
	Path    string
	Body    []byte
	Headers [32][2]string
	HeaderN int
	state   parseState
}

type parseState int

const (
	stateRequestLine parseState = iota
	stateHeaders
	stateBody
	stateDone
)

func (p *HTTPParser) Reset() {
	p.Method = ""
	p.Path = ""
	p.Body = p.Body[:0]
	p.HeaderN = 0
	p.state = stateRequestLine
}

func (p *HTTPParser) Feed(data []byte) (consumed int, complete bool) {
	// Simplified parser - production uses a proper HTTP/1.1 state machine.
	s := string(data) // In production: zero-copy using unsafe
	parts := splitHTTP(s)
	if len(parts) < 2 {
		return 0, false
	}
	requestLine := parts[0]
	tokens := splitN(requestLine, " ", 3)
	if len(tokens) < 2 {
		return 0, false
	}
	p.Method = tokens[0]
	p.Path = tokens[1]
	return len(data), true
}

func splitHTTP(s string) []string {
	// Split on \r\n\r\n (header/body boundary).
	idx := len(s)
	for i := 0; i < len(s)-3; i++ {
		if s[i] == '\r' && s[i+1] == '\n' && s[i+2] == '\r' && s[i+3] == '\n' {
			idx = i
			break
		}
	}
	return []string{s[:idx], s[idx:]}
}

func splitN(s, sep string, n int) []string {
	var result []string
	for i := 0; i < n-1; i++ {
		idx := -1
		for j := 0; j < len(s); j++ {
			if s[j] == sep[0] {
				idx = j
				break
			}
		}
		if idx < 0 {
			break
		}
		result = append(result, s[:idx])
		s = s[idx+1:]
	}
	result = append(result, s)
	return result
}

// Start starts the gnet HTTP server.
func Start(addr string, router RequestRouter, multicore bool) error {
	srv := &HTTPServer{
		addr:      addr,
		multicore: multicore,
		router:    router,
	}
	opts := []gnet.Option{
		gnet.WithMulticore(multicore),
		gnet.WithReusePort(true),
		gnet.WithTCPKeepAlive(30 * time.Second),
		gnet.WithTCPNoDelay(gnet.TCPNoDelay),
		gnet.WithReadBufferCap(64 * 1024),
		gnet.WithWriteBufferCap(64 * 1024),
		// gnet drives epoll on Linux and kqueue on BSD/Darwin.
	}
	return gnet.Run(srv, "tcp://"+addr, opts...)
}

// Ensure imports are used (these types are referenced indirectly).
var _ = context.Background
var _ = sync.Mutex{}
var _ = atomic.Int64{}
```

### 6.3 io_uring security and operational caveats

io_uring has had a rough security history. Between 2022 and 2024 multiple kernel CVEs (CVE-2022-2938, CVE-2023-0468, CVE-2024-0582 among others) exposed privilege escalation paths through io_uring opcodes or buffer registration, and Google disabled io_uring by default in ChromeOS and in the Google Kubernetes Engine node image, while Docker introduced a seccomp policy that blocks `io_uring_setup` by default. Before you deploy an io_uring-based server, confirm three things with your platform team. First, is the syscall actually allowed by your container seccomp profile (default Docker profile blocks it, many Kubernetes distributions block it, AWS Fargate blocks it). Second, does your on-call runbook cover the failure mode where a kernel upgrade silently disables a feature you depend on. Third, do you have a fallback to epoll via a feature flag, so a kernel rollback does not take your service down. Staff-level due diligence on io_uring is less about performance than about operational containment.

### 6.4 When epoll is still the right answer

The epoll-based netpoller inside the Go runtime is very, very good, and it is worth being precise about why, because it already solves most of what people reach for io_uring to fix. A goroutine blocked on `conn.Read` does **not** block an OS thread. The runtime puts the fd in non-blocking mode, registers it with epoll, parks the goroutine, and immediately runs something else on that M. That is why Go holds hundreds of thousands of connections on a handful of threads while your handler code reads like simple blocking I/O. You get the ergonomics of blocking code and the scalability of an event loop, for free, with `context.Context` cancellation and `defer` cleanup that actually work.

Where io_uring genuinely has something to offer is the place the netpoller cannot help: **regular files**. `epoll` on a regular file always reports ready, so there is no way to poll it, which means a disk read is a true blocking syscall that occupies an M until it completes (see the netpoller discussion in the runtime chapter). Disk-heavy write pipelines, log forwarders, and dense file-serving are the workloads with real headroom here, and they are a small minority of Go services.

Resist quoting a percentage for the win, including any you have seen. The gain is bounded by the share of your CPU currently spent on syscall overhead, and that share is specific to your handler, payload size, kernel version, and mitigation settings. The procedure is the same every time and it is short: take a CPU profile, look at what fraction sits in `syscall`, and recognize that this fraction is your entire ceiling. If syscalls are a small slice, io_uring cannot give you a large win no matter what a benchmark on someone else's log forwarder reported. Spend the engineering budget on allocations or lock contention instead, which is where the profile usually points anyway.

### 6.5 Junior → FAANG: what to study here

Most juniors will never write io_uring code, but understanding the shape of the problem matters for interviews. Know the answer to "why is a syscall expensive" (context switch, TLB flush on KPTI-protected kernels, cache pollution, pipeline flush, typically 100 to 300 ns on modern hardware). Know what `perf stat -e context-switches,cs` tells you. Know the difference between blocking I/O, non-blocking I/O, I/O multiplexing (select/poll/epoll), and asynchronous I/O (io_uring, Windows IOCP). Know why Go's M:P:G scheduler plays nicely with epoll but awkwardly with io_uring (because io_uring expects the application to own its own event loop, which conflicts with Go's goroutine-per-connection idiom). Interviewers rarely expect you to implement any of this, but they absolutely expect you to explain why you would or would not reach for it.

### 6.6 Senior @ FAANG: the one-page io_uring ADR

If your team is evaluating io_uring, the artifact is a one-page ADR that answers: what workload benefits (disk-heavy, not network-heavy, for most cases), what is the measured baseline (epoll throughput, syscall time share), what is the minimum supported kernel (5.15 LTS or 6.1 LTS, with explicit tested commit of your kernel vendor), what is the seccomp posture (allowed in your container runtime, audited for escape paths, monitored for CVE announcements), what is the fallback plan (feature flag that toggles back to epoll without a redeploy), what is the maintenance contract (who upgrades `iouring-go` or `gnet`, what is the version pin policy, who is on-call for io_uring-specific bugs). Include a section titled "what would make us revert" with explicit criteria (new CVE with no patch within 30 days, 2 percent or greater regression in p99, a kernel upgrade that breaks compat). That sentence alone is the difference between a performance optimization and a liability.

---
