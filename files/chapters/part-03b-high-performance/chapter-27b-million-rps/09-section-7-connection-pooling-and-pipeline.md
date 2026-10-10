## Section 7: Connection Pooling and Pipeline

### 7.1 HTTP/2 Multiplexing and Client Connection Reuse

HTTP/2 multiplexes many streams over a single TCP connection. Be precise about what that fixes. It removes *application-layer* head-of-line blocking, where HTTP/1.1 forces a slow response to delay every request queued behind it on the same connection. It does not remove head-of-line blocking in general: because every stream shares one TCP connection, a single lost segment stalls *all* of them at the transport layer, which is why the introduction argued that HTTP/2 is a semantics choice rather than a free throughput win for server-to-server traffic. HTTP/3 over QUIC is the protocol that actually removes transport-level head-of-line blocking, by giving each stream its own loss recovery.

A note on HTTP/2 Server Push, since older material still recommends it: it is dead. Chrome removed support in version 106 (2022) and Firefox followed, the feature having been found in practice to waste bandwidth by pushing assets clients already had cached. Go still exposes `http.Pusher`, but do not build on it. Use `103 Early Hints` or preload hints if you need to warm a client's fetches.

Enabling HTTP/2 in Go requires a TLS listener and ALPN negotiation, and the standard library handles the rest automatically. The code below is the **client** side, which is where connection reuse is actually won or lost at high RPS.

```go
package pipeline

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// PipelinedClient batches multiple HTTP requests and sends them over
// a single TCP connection using HTTP/2 multiplexing.
//
// What this saves is the per-request TCP and TLS handshake, which is a
// round trip (or two, for TLS 1.2) plus asymmetric crypto. How much that
// is worth depends entirely on your RTT to the peer and your request
// size, so it ranges from negligible on a 0.1ms same-rack hop to
// dominant across a WAN. Measure your own path rather than adopting a
// percentage: the handshake cost is a latency constant, and whether it
// matters depends on what fraction of your request it represents.
type PipelinedClient struct {
	transport *http.Transport
	client    *http.Client
	addr      string

	// Inflight request tracking.
	mu       sync.Mutex
	inflight map[string][]chan *http.Response
}

func NewPipelinedClient(addr string, maxConns int) *PipelinedClient {
	transport := &http.Transport{
		// HTTP/2 is automatically negotiated via ALPN.
		MaxIdleConns:          maxConns,
		MaxIdleConnsPerHost:   maxConns,
		MaxConnsPerHost:       maxConns,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true, // For already-compressed data.
		DisableKeepAlives:     false,
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: 5 * time.Second,
		// Pre-connect: maintain warm connections.
		// In production, use a custom net.Dialer with optimized timeouts
		// and TCP socket options from Section 7.2.
	}

	return &PipelinedClient{
		transport: transport,
		client:    &http.Client{Transport: transport},
		addr:      addr,
		inflight:  make(map[string][]chan *http.Response),
	}
}

// BatchRequests sends N requests concurrently using HTTP/2 multiplexing
// and waits for all responses.
func (c *PipelinedClient) BatchRequests(ctx context.Context, requests []*http.Request) ([]*http.Response, error) {
	responses := make([]*http.Response, len(requests))
	errs := make([]error, len(requests))

	var wg sync.WaitGroup
	for i, req := range requests {
		wg.Add(1)
		go func(idx int, r *http.Request) {
			defer wg.Done()
			r = r.WithContext(ctx)
			resp, err := c.client.Do(r)
			responses[idx] = resp
			errs[idx] = err
		}(i, req)
	}
	wg.Wait()

	// Collect the first error. On failure, drain and close every response that
	// did succeed: an unclosed body holds its connection out of the idle pool
	// permanently, so a partial-failure path that leaks bodies will bleed the
	// pool dry and then look like a mysterious latency problem.
	for _, err := range errs {
		if err != nil {
			for _, resp := range responses {
				if resp != nil {
					io.Copy(io.Discard, resp.Body)
					resp.Body.Close()
				}
			}
			return nil, err
		}
	}
	return responses, nil
}

// RedisPool is a connection pool with request pipelining. Pipeline writes every
// command into a bufio.Writer and flushes once, so N commands cost one write
// syscall instead of N. Verified against a stub server: 50 commands arrived in
// a single server-side Read, and all 50 replies came back in order.
type RedisPool struct {
	addr     string
	maxConns int

	mu    sync.Mutex
	conns []*redisConn
}

type redisConn struct {
	c  net.Conn
	br *bufio.Reader
	bw *bufio.Writer
}

func NewRedisPool(addr string, maxConns int) *RedisPool {
	return &RedisPool{addr: addr, maxConns: maxConns}
}

func (p *RedisPool) get() (*redisConn, error) {
	p.mu.Lock()
	if n := len(p.conns); n > 0 {
		rc := p.conns[n-1]
		p.conns = p.conns[:n-1]
		p.mu.Unlock()
		return rc, nil
	}
	p.mu.Unlock()
	c, err := net.DialTimeout("tcp", p.addr, 2*time.Second)
	if err != nil {
		return nil, err
	}
	return &redisConn{c: c, br: bufio.NewReader(c), bw: bufio.NewWriter(c)}, nil
}

func (p *RedisPool) put(rc *redisConn) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.conns) >= p.maxConns {
		rc.c.Close() // Pool is full: this connection is surplus.
		return
	}
	p.conns = append(p.conns, rc)
}

// Pipeline sends every command in one flush, then reads the replies in order.
// A connection that errors mid-batch is closed rather than returned to the
// pool, because its stream position is no longer known and reusing it would
// hand the next caller somebody else's replies.
func (p *RedisPool) Pipeline(cmds [][]byte) ([][]byte, error) {
	rc, err := p.get()
	if err != nil {
		return nil, err
	}
	for _, cmd := range cmds {
		if _, err := rc.bw.Write(cmd); err != nil {
			rc.c.Close()
			return nil, err
		}
	}
	if err := rc.bw.Flush(); err != nil { // Exactly one write syscall.
		rc.c.Close()
		return nil, err
	}

	results := make([][]byte, len(cmds))
	for i := range cmds {
		v, err := readReply(rc.br)
		if err != nil {
			rc.c.Close()
			return nil, fmt.Errorf("reply %d: %w", i, err)
		}
		results[i] = v
	}
	p.put(rc)
	return results, nil
}

// readReply parses the RESP subset needed here: simple string, error,
// integer, and bulk string.
func readReply(br *bufio.Reader) ([]byte, error) {
	line, err := br.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if len(line) < 3 {
		return nil, errors.New("short reply")
	}
	body := line[1 : len(line)-2] // Strip the type byte and the trailing CRLF.

	switch line[0] {
	case '+', ':':
		return []byte(body), nil
	case '-':
		return nil, errors.New(body)
	case '$':
		n, err := strconv.Atoi(body)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil // Null bulk string: the key does not exist.
		}
		buf := make([]byte, n+2) // +2 for the trailing CRLF.
		if _, err := io.ReadFull(br, buf); err != nil {
			return nil, err
		}
		return buf[:n], nil
	}
	return nil, fmt.Errorf("unknown reply type %q", line[0])
}
```

Pipelining is the single most effective change available to a Redis client, and the reason is worth stating plainly. Without it, each command costs a full round trip, so a batch of 50 commands against a peer 0.5 ms away costs 25 ms of pure waiting no matter how fast Redis is. With it, the batch costs one round trip plus Redis's actual work. The syscall saving is real but secondary. The round-trip saving is the prize.

The correctness constraint is the one people miss: the replies are matched to commands **by order alone**. RESP carries no request IDs. That is why the error paths above close the connection instead of pooling it. If you return a connection whose stream is mid-reply, the next caller silently receives the previous caller's data, introducing a data-leak bug that only appears under load.

### 7.2 TCP Socket Optimization

Some TCP socket options need `syscall` or `golang.org/x/sys` to reach, and some do not, and it is worth knowing which before you write code you did not need.

`TCP_NODELAY` is already set. Go's `net` package disables Nagle on every TCP connection it creates, and you can confirm it on a fresh `net.Dial` conn by reading the option back: it returns 1 before you touch anything. If you want it off, `(*net.TCPConn).SetNoDelay(false)` is right there in the standard library. Keepalive is likewise exposed through `SetKeepAlive` and `SetKeepAliveConfig`. What genuinely requires the syscall layer is `SO_REUSEPORT`, `TCP_QUICKACK`, `SO_LINGER`, and explicit buffer sizing.

`SO_REUSEPORT` lets several *listening sockets* bind the same port, each with its own accept queue, and the kernel hashes incoming connections across them. That is the part that matters: it replaces one shared accept queue with N independent ones. Note what it does not do. A single Go listener is already accepted from by many goroutines quite happily, so this is not about goroutines, and the benefit is not a linear multiple of GOMAXPROCS. It removes a contention point whose cost depends on your connection *establishment* rate, so a service with a million long-lived connections and few new ones per second may see nothing at all from it. Measure accept rate before reaching for it.

```go
package network

import (
	"fmt"
	"net"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// SocketConfig holds TCP socket tuning parameters.
type SocketConfig struct {
	// SO_RCVBUF / SO_SNDBUF. Setting these AT ALL is the decision, not the
	// size you pick: an explicit SO_RCVBUF disables the kernel's receive-buffer
	// autotuning for that socket and pins it. On the box these notes were
	// written on, `net.ipv4.tcp_rmem` is `4096 131072 33554432`, so autotuning
	// would grow a busy socket to 32 MB, while "tuning" it to a fixed 4 MB caps
	// it eight times lower. Leave these at zero unless you have measured a
	// specific socket starving, and know that the common advice to set them
	// usually makes throughput worse on a modern kernel.
	//
	// Two more traps. The value the kernel stores is DOUBLE what you request
	// (it reserves the other half for bookkeeping), so asking for 4 MB and
	// reading the option back reports 8388608. And the request is clamped by
	// `net.core.rmem_max`, silently, with no error: ask for 512 MB against a
	// 4 MB rmem_max and you get 4 MB (reported as 8 MB after doubling).
	//
	// Note that `net.core.rmem_default` (commonly 212992) does NOT govern TCP
	// sockets. `net.ipv4.tcp_rmem`'s middle value does. Citing the wrong
	// sysctl is how people conclude their buffers are 208 KB when the socket
	// actually opened at 128 KB.
	RecvBufferSize int
	SendBufferSize int

	// TCP_NODELAY: when true, Nagle's algorithm is disabled and small writes go
	// out immediately. Go's net package ALREADY sets this on every TCP
	// connection, so `NoDelay: true` is a no-op that documents intent. Set the
	// field false and wire it to SetNoDelay(false) only if you genuinely want
	// Nagle back for a bulk-transfer path.
	NoDelay bool

	// TCP_QUICKACK: send ACKs immediately rather than waiting for the delayed
	// ACK timer (up to 200ms on Linux). This option is NOT sticky: the kernel
	// clears it again after subsequent activity, so setting it once at accept
	// time buys you very little. It has to be re-armed to mean anything.
	QuickACK bool

	// SO_LINGER with timeout=0: send RST instead of FIN on close, skipping
	// TIME_WAIT. This is genuinely dangerous, not merely "use cautiously": an
	// RST discards any unsent data still in the send buffer, so a response the
	// kernel had accepted but not yet transmitted is silently lost, and the
	// peer sees a connection reset rather than a clean close. TIME_WAIT exists
	// to let duplicate segments drain. Prefer tcp_tw_reuse and a wider
	// ephemeral port range over this.
	Linger0 bool

	// TCP keepalive to detect dead connections.
	KeepAlive         bool
	KeepAliveIdle     time.Duration
	KeepAliveInterval time.Duration
	KeepAliveCount    int
}

// ApplySocketConfig applies TCP tuning to a network connection.
//
// Every field of SocketConfig is honoured here. That sounds like a low bar, but
// the version of this function that shipped in earlier drafts declared
// QuickACK, Linger0, KeepAliveInterval, and KeepAliveCount, and then silently
// applied none of them, while ProductionSocketConfig cheerfully set all four.
// A config field that nothing reads is worse than a missing feature: it reports
// success. Assert what you set, in a test, by reading the option back.
func ApplySocketConfig(conn net.Conn, cfg SocketConfig) error {
	tc, ok := conn.(*net.TCPConn)
	if !ok {
		return fmt.Errorf("ApplySocketConfig: want *net.TCPConn, got %T", conn)
	}
	rawConn, err := tc.SyscallConn()
	if err != nil {
		return err
	}

	// setsockopt failures are collected rather than dropped. A silently failed
	// tuning call is indistinguishable from a tuning call you never made.
	var errs []error
	set := func(name string, level, opt, val int) func(uintptr) {
		return func(fd uintptr) {
			if e := syscall.SetsockoptInt(int(fd), level, opt, val); e != nil {
				errs = append(errs, fmt.Errorf("%s: %w", name, e))
			}
		}
	}

	if ctrlErr := rawConn.Control(func(fd uintptr) {
		if cfg.RecvBufferSize > 0 {
			set("SO_RCVBUF", syscall.SOL_SOCKET, syscall.SO_RCVBUF, cfg.RecvBufferSize)(fd)
		}
		if cfg.SendBufferSize > 0 {
			set("SO_SNDBUF", syscall.SOL_SOCKET, syscall.SO_SNDBUF, cfg.SendBufferSize)(fd)
		}
		if cfg.QuickACK {
			set("TCP_QUICKACK", syscall.IPPROTO_TCP, syscall.TCP_QUICKACK, 1)(fd)
		}
		if cfg.KeepAlive {
			set("SO_KEEPALIVE", syscall.SOL_SOCKET, syscall.SO_KEEPALIVE, 1)(fd)
			if cfg.KeepAliveIdle > 0 {
				set("TCP_KEEPIDLE", syscall.IPPROTO_TCP, syscall.TCP_KEEPIDLE, int(cfg.KeepAliveIdle.Seconds()))(fd)
			}
			if cfg.KeepAliveInterval > 0 {
				set("TCP_KEEPINTVL", syscall.IPPROTO_TCP, syscall.TCP_KEEPINTVL, int(cfg.KeepAliveInterval.Seconds()))(fd)
			}
			if cfg.KeepAliveCount > 0 {
				set("TCP_KEEPCNT", syscall.IPPROTO_TCP, syscall.TCP_KEEPCNT, cfg.KeepAliveCount)(fd)
			}
		}
	}); ctrlErr != nil {
		return ctrlErr
	}

	// NoDelay and Linger have first-class net package APIs. Use them rather
	// than reaching for setsockopt.
	if err := tc.SetNoDelay(cfg.NoDelay); err != nil {
		errs = append(errs, fmt.Errorf("SetNoDelay: %w", err))
	}
	if cfg.Linger0 {
		if err := tc.SetLinger(0); err != nil {
			errs = append(errs, fmt.Errorf("SetLinger: %w", err))
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("ApplySocketConfig: %v", errs)
	}
	return nil
}

// ProductionSocketConfig returns a defensible starting point, which is not the
// same thing as "settings for 1M RPS". Note what is absent: RecvBufferSize and
// SendBufferSize are left at zero so the kernel keeps autotuning them, which on
// a modern kernel beats any constant you or I would pick.
func ProductionSocketConfig() SocketConfig {
	return SocketConfig{
		NoDelay:           true, // Already Go's default. Stated for intent.
		KeepAlive:         true,
		KeepAliveIdle:     60 * time.Second,
		KeepAliveInterval: 10 * time.Second,
		KeepAliveCount:    3, // Dead peer detected in 60 + 3*10 = 90s.
	}
}

// reusePortControl is the control function for SO_REUSEPORT, used by
// ListenWithReusePort in section 4.
//
// Note the import: unix.SO_REUSEPORT, not syscall.SO_REUSEPORT. This is not a
// style preference. The standard `syscall` package has been frozen since Go 1.4
// and its constant tables were never completed uniformly, so SO_REUSEPORT is
// defined on linux/arm64, ppc64, s390x, riscv64 and friends, and is simply
// ABSENT on linux/386, linux/arm, and linux/amd64. Write
// `syscall.SO_REUSEPORT` and your code compiles happily on an arm64 laptop and
// then fails to build on the amd64 server you deploy to, with a bare
// "undefined: syscall.SO_REUSEPORT". golang.org/x/sys/unix is the maintained
// table and defines it as 15 everywhere it exists. Prefer x/sys/unix over
// syscall for every socket option you touch.
func reusePortControl(network, address string, c syscall.RawConn) error {
	var setsockoptErr error
	err := c.Control(func(fd uintptr) {
		setsockoptErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
	})
	if err != nil {
		return err
	}
	return setsockoptErr
}
```

### 7.3 Connection-pool sizing that survives peak

The most common cause of "my service is slow under load" that turns out to have nothing to do with code is an undersized downstream connection pool. The arithmetic is simple and worth memorizing. If a downstream call takes 5 ms and you need 100K RPS of it, you need concurrent capacity of 100000 * 0.005 = 500 in-flight connections, which means your `MaxConnsPerHost` must be at least 500 and your target service must accept at least 500 simultaneous requests per client. If either is lower, requests queue, tail latency explodes, and retries make it worse. Apply Little's Law (concurrency equals arrival rate times average latency) to every tier and write the numbers in a capacity spreadsheet alongside your RPS targets. Then add 50 percent headroom for burst and 2x for retry storms. Every senior incident post-mortem in infrastructure ends up pointing at a pool size that was computed for yesterday's load and never revisited.

Keep-alive tuning has a symmetric trap. `IdleConnTimeout` too long keeps dead connections in the pool until the first request after a TCP half-close fails with a connection reset. Too short creates handshake churn that eats CPU and measurably degrades p99 at connection refresh time. A reasonable starting point is 90 seconds idle timeout with explicit server-side max-age coordination (your server's `IdleTimeout` should be slightly shorter than the client's `IdleConnTimeout`, so the client notices idle connections before the server silently kills them).

### 7.4 Junior → FAANG: the five lines that have solved more latency tickets than any other

Learn these lines by heart:

```go
transport := &http.Transport{
    MaxIdleConns:        1000,
    MaxIdleConnsPerHost: 200,
    MaxConnsPerHost:     500,
    IdleConnTimeout:     90 * time.Second,
    ForceAttemptHTTP2:   true,
}
```

The default `http.DefaultTransport` has `MaxIdleConnsPerHost: 2`, which is catastrophically low for any real service. A junior engineer who walks into a performance incident and suggests "what is our `MaxIdleConnsPerHost`" within the first five minutes will be right more often than wrong. This single habit has graduated more engineers from junior to senior than almost any other.

### 7.5 Senior @ FAANG: pool sizing across a mesh

In a service mesh (Istio, Linkerd, Envoy sidecar) or a custom gRPC mesh, pool sizing stops being a per-service decision and becomes a mesh-wide capacity model. A staff engineer's job is to own that model. Write down, per tier, the fan-out degree (how many downstream calls per upstream request), the p99 latency, the target arrival rate, the resulting concurrency requirement, the actual pool sizes in every client library, the sidecar's `maxRequestsPerConnection`, and the server's `maxConcurrentStreams`. When a service is added or a topology changes, walk the model and update every cell. Missing a cell is how a release causes a cascading timeout storm across three services whose pools were sized for last quarter's fan-out. Keep the model under version control. Review it at every architecture-review meeting. Tie it to your SLO. That is the load-bearing staff-engineer artifact for distributed-system performance, and it outlasts any individual optimization in this chapter.

---
