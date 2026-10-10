## 102I.1 TCP Internals and Go's netpoll

### 1.1 How Go Multiplexes I/O Without Blocking OS Threads

Go's network I/O uses a non-blocking socket model internally while presenting a blocking API to goroutines. When a `net.Conn.Read()` would block, the goroutine is parked and the OS thread is returned to the thread pool.

```go
package tcpinternals

import (
	"fmt"
	"net"
	"syscall"
	"unsafe"
)

// TCPInfo mirrors the kernel's tcp_info struct - available on Linux.
// Reveals congestion window, RTT, retransmit counters.
type TCPInfo struct {
	State          uint8
	CaState        uint8
	Retransmits    uint8
	Probes         uint8
	Backoff         uint8
	Options        uint8
	Pad            [2]uint8
	Rto            uint32
	Ato            uint32
	SndMss         uint32
	RcvMss         uint32
	Unacked        uint32
	Sacked         uint32
	Lost           uint32
	Retrans        uint32
	Fackets        uint32
	LastDataSent   uint32
	LastAckSent    uint32
	LastDataRecv   uint32
	LastAckRecv    uint32
	Pmtu           uint32
	RcvSsthresh    uint32
	Rtt            uint32 // microseconds
	Rttvar         uint32
	SndSsthresh    uint32
	SndCwnd        uint32
	Advmss         uint32
	Reordering     uint32
	RcvRtt         uint32
	RcvSpace       uint32
	TotalRetrans   uint32
}

// GetTCPInfo retrieves TCP-level diagnostics from a live connection.
// Only works on Linux - returns nil on other platforms.
func GetTCPInfo(conn net.Conn) (*TCPInfo, error) {
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		return nil, fmt.Errorf("not a TCP connection")
	}

	rawConn, err := tcpConn.SyscallConn()
	if err != nil {
		return nil, err
	}

	info := &TCPInfo{}
	var sysErr error

	err = rawConn.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(*info))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			uintptr(syscall.IPPROTO_TCP),
			uintptr(syscall.TCP_INFO),
			uintptr(unsafe.Pointer(info)),
			uintptr(unsafe.Pointer(&size)),
			0,
		)
		if errno != 0 {
			sysErr = errno
		}
	})

	if err != nil {
		return nil, err
	}
	if sysErr != nil {
		return nil, sysErr
	}

	return info, nil
}

// DiagnoseTCP prints RTT, congestion window, and retransmit rate.
func DiagnoseTCP(conn net.Conn) {
	info, err := GetTCPInfo(conn)
	if err != nil {
		fmt.Printf("TCPInfo unavailable: %v\n", err)
		return
	}
	fmt.Printf("RTT: %dµs (±%dµs), cwnd: %d, retrans: %d, state: %d\n",
		info.Rtt, info.Rttvar, info.SndCwnd, info.TotalRetrans, info.State)
}
```

### 1.2 Socket Options for High-Performance TCP

TCP socket options have a significant impact on throughput and latency and must be tuned for the workload, bulk data transfer benefits from large buffers and Nagle's algorithm enabled, while interactive RPC traffic needs `TCP_NODELAY` and `TCP_QUICKACK` to avoid artificial 40ms ACK delays. The `TCPSocketConfig` below captures the key tunable options and `ApplyConfig` applies them through `SyscallConn.Control` so the settings take effect immediately on a live connection.

```go
package tcpinternals

import (
	"net"
	"syscall"
	"time"
)

// TCPSocketConfig holds tunable socket parameters.
type TCPSocketConfig struct {
	NoDelay         bool          // TCP_NODELAY: disable Nagle's algorithm
	KeepAlive       bool          // SO_KEEPALIVE
	KeepAliveIdle   time.Duration // TCP_KEEPIDLE: time before first keepalive probe
	KeepAliveIntvl  time.Duration // TCP_KEEPINTVL: interval between probes
	KeepAliveCount  int           // TCP_KEEPCNT: number of probes
	RecvBufSize     int           // SO_RCVBUF: receive buffer bytes
	SendBufSize     int           // SO_SNDBUF: send buffer bytes
	Linger          int           // SO_LINGER: seconds (-1 = disabled)
	DeferAccept     bool          // TCP_DEFER_ACCEPT: wait for data before accept
	QuickAck        bool          // TCP_QUICKACK: disable delayed ACKs
}

// DefaultHighThroughputConfig is suited for bulk data transfer.
func DefaultHighThroughputConfig() TCPSocketConfig {
	return TCPSocketConfig{
		NoDelay:        false, // Nagle ON for batching small writes
		KeepAlive:      true,
		KeepAliveIdle:  60 * time.Second,
		KeepAliveIntvl: 10 * time.Second,
		KeepAliveCount: 3,
		RecvBufSize:    1 << 20, // 1 MiB
		SendBufSize:    1 << 20,
		Linger:         -1,
	}
}

// DefaultLowLatencyConfig is suited for RPC/interactive traffic.
func DefaultLowLatencyConfig() TCPSocketConfig {
	return TCPSocketConfig{
		NoDelay:        true,  // Nagle OFF - send immediately
		QuickAck:       true,  // no delayed ACKs
		KeepAlive:      true,
		KeepAliveIdle:  30 * time.Second,
		KeepAliveIntvl: 5 * time.Second,
		KeepAliveCount: 3,
		RecvBufSize:    256 << 10, // 256 KiB
		SendBufSize:    256 << 10,
		Linger:         0, // RST on close
	}
}

// ApplyConfig applies socket options to a TCPConn.
func ApplyConfig(conn *net.TCPConn, cfg TCPSocketConfig) error {
	if err := conn.SetNoDelay(cfg.NoDelay); err != nil {
		return err
	}
	if cfg.KeepAlive {
		if err := conn.SetKeepAlive(true); err != nil {
			return err
		}
		if err := conn.SetKeepAlivePeriod(cfg.KeepAliveIdle); err != nil {
			return err
		}
	}
	if cfg.RecvBufSize > 0 {
		if err := conn.SetReadBuffer(cfg.RecvBufSize); err != nil {
			return err
		}
	}
	if cfg.SendBufSize > 0 {
		if err := conn.SetWriteBuffer(cfg.SendBufSize); err != nil {
			return err
		}
	}
	if cfg.Linger >= 0 {
		if err := conn.SetLinger(cfg.Linger); err != nil {
			return err
		}
	}

	rawConn, err := conn.SyscallConn()
	if err != nil {
		return err
	}

	return rawConn.Control(func(fd uintptr) {
		if cfg.QuickAck {
			syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_QUICKACK, 1)
		}
		if cfg.DeferAccept {
			syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, syscall.TCP_DEFER_ACCEPT, 1)
		}
	})
}

// TunedListener creates a TCP listener with SO_REUSEPORT and custom options.
func TunedListener(addr string, cfg TCPSocketConfig) (net.Listener, error) {
	lc := net.ListenConfig{
		Control: func(network, address string, c syscall.RawConn) error {
			return c.Control(func(fd uintptr) {
				syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
				// SO_REUSEPORT allows multiple listeners on same port (Linux 3.9+)
				syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, 0xF, 1) // SO_REUSEPORT
				if cfg.RecvBufSize > 0 {
					syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, cfg.RecvBufSize)
				}
				if cfg.SendBufSize > 0 {
					syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, cfg.SendBufSize)
				}
			})
		},
	}
	return lc.Listen(nil, "tcp", addr)
}
```

### 1.3 TCP Handshake and Connection State Machine

Tracking connection lifecycle states enables health monitoring, idle connection eviction, and byte-level throughput accounting per connection. The `TrackedConn` wrapper intercepts `Read`, `Write`, and `Close` calls to update atomic state and byte counters without requiring a mutex on the hot path. The accompanying `ConnectionPool` manages a bounded set of reusable TCP connections and probes idle connections with a zero-byte read before returning them to callers.

```go
package tcpinternals

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ConnState tracks connection lifecycle.
type ConnState int32

const (
	StateNew      ConnState = iota
	StateActive
	StateIdle
	StateHijacked
	StateClosed
)

func (s ConnState) String() string {
	switch s {
	case StateNew:
		return "NEW"
	case StateActive:
		return "ACTIVE"
	case StateIdle:
		return "IDLE"
	case StateHijacked:
		return "HIJACKED"
	case StateClosed:
		return "CLOSED"
	default:
		return "UNKNOWN"
	}
}

// TrackedConn wraps net.Conn with state tracking and metrics.
type TrackedConn struct {
	net.Conn
	id        uint64
	state     atomic.Int32
	createdAt time.Time
	lastActive atomic.Int64 // UnixNano
	bytesRead  atomic.Int64
	bytesWritten atomic.Int64
	mu        sync.Mutex
}

var connIDCounter atomic.Uint64

// NewTrackedConn creates a connection wrapper.
func NewTrackedConn(conn net.Conn) *TrackedConn {
	tc := &TrackedConn{
		Conn:      conn,
		id:        connIDCounter.Add(1),
		createdAt: time.Now(),
	}
	tc.state.Store(int32(StateNew))
	tc.lastActive.Store(time.Now().UnixNano())
	return tc
}

func (tc *TrackedConn) Read(b []byte) (int, error) {
	tc.state.Store(int32(StateActive))
	tc.lastActive.Store(time.Now().UnixNano())
	n, err := tc.Conn.Read(b)
	tc.bytesRead.Add(int64(n))
	return n, err
}

func (tc *TrackedConn) Write(b []byte) (int, error) {
	tc.state.Store(int32(StateActive))
	tc.lastActive.Store(time.Now().UnixNano())
	n, err := tc.Conn.Write(b)
	tc.bytesWritten.Add(int64(n))
	return n, err
}

func (tc *TrackedConn) Close() error {
	tc.state.Store(int32(StateClosed))
	return tc.Conn.Close()
}

func (tc *TrackedConn) Idle() {
	tc.state.Store(int32(StateIdle))
}

func (tc *TrackedConn) Stats() map[string]any {
	lastNano := tc.lastActive.Load()
	return map[string]any{
		"id":           tc.id,
		"state":        ConnState(tc.state.Load()).String(),
		"uptime_ms":    time.Since(tc.createdAt).Milliseconds(),
		"idle_ms":      time.Since(time.Unix(0, lastNano)).Milliseconds(),
		"bytes_read":   tc.bytesRead.Load(),
		"bytes_written": tc.bytesWritten.Load(),
	}
}

// ConnectionPool manages a pool of reusable TCP connections.
type ConnectionPool struct {
	addr       string
	cfg        TCPSocketConfig
	idle       chan *TrackedConn
	total      atomic.Int32
	maxSize    int
	dialTimeout time.Duration
	mu         sync.Mutex
}

// NewConnectionPool creates a pool with max size and dial timeout.
func NewConnectionPool(addr string, maxSize int, cfg TCPSocketConfig) *ConnectionPool {
	return &ConnectionPool{
		addr:        addr,
		cfg:         cfg,
		idle:        make(chan *TrackedConn, maxSize),
		maxSize:     maxSize,
		dialTimeout: 5 * time.Second,
	}
}

// Get retrieves an idle connection or dials a new one.
func (p *ConnectionPool) Get(ctx context.Context) (*TrackedConn, error) {
	// Try idle pool first
	select {
	case tc := <-p.idle:
		if p.isAlive(tc) {
			tc.state.Store(int32(StateActive))
			return tc, nil
		}
		tc.Close()
		p.total.Add(-1)
	default:
	}

	// Check pool capacity
	if int(p.total.Load()) >= p.maxSize {
		// Wait for idle connection
		select {
		case tc := <-p.idle:
			if p.isAlive(tc) {
				tc.state.Store(int32(StateActive))
				return tc, nil
			}
			tc.Close()
			p.total.Add(-1)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	// Dial new connection
	dialer := net.Dialer{Timeout: p.dialTimeout}
	rawConn, err := dialer.DialContext(ctx, "tcp", p.addr)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", p.addr, err)
	}

	tcpConn := rawConn.(*net.TCPConn)
	if err := ApplyConfig(tcpConn, p.cfg); err != nil {
		rawConn.Close()
		return nil, err
	}

	p.total.Add(1)
	return NewTrackedConn(rawConn), nil
}

// Put returns a connection to the idle pool.
func (p *ConnectionPool) Put(tc *TrackedConn) {
	if !p.isAlive(tc) {
		tc.Close()
		p.total.Add(-1)
		return
	}
	tc.Idle()
	select {
	case p.idle <- tc:
	default:
		tc.Close()
		p.total.Add(-1)
	}
}

func (p *ConnectionPool) isAlive(tc *TrackedConn) bool {
	if ConnState(tc.state.Load()) == StateClosed {
		return false
	}
	// Zero-byte read with no deadline detects closed connection
	tc.Conn.SetReadDeadline(time.Now().Add(time.Millisecond))
	defer tc.Conn.SetReadDeadline(time.Time{})
	buf := make([]byte, 1)
	_, err := tc.Conn.Read(buf)
	if err != nil {
		netErr, ok := err.(net.Error)
		return ok && netErr.Timeout()
	}
	return true
}

func (p *ConnectionPool) Stats() map[string]any {
	return map[string]any{
		"total": p.total.Load(),
		"idle":  len(p.idle),
		"addr":  p.addr,
	}
}
```

### Junior → FAANG: TCP Socket Options You Will Actually Use

The socket options in this section are not academic. They appear in real production tuning. `TCP_NODELAY` disables Nagle's algorithm, which batches small writes into larger packets. For interactive protocols (WebSocket, telnet, game servers) where you want each write to transmit immediately, `TCP_NODELAY` is almost always correct. For bulk data transfer, Nagle's algorithm helps. The first question when tuning a latency-sensitive TCP service: is `TCP_NODELAY` set?

`SO_KEEPALIVE` sends periodic TCP keep-alive probes to detect broken connections. Without it, a connection where the peer process has crashed (without sending a TCP FIN) will remain in the `ESTABLISHED` state indefinitely, holding a goroutine and a file descriptor. Set `SO_KEEPALIVE` on any connection that is expected to be idle for more than a few minutes.

Interview entry point: name two TCP socket options that matter for a WebSocket server and explain why. `TCP_NODELAY` (for low-latency frame delivery) and `SO_KEEPALIVE` (to detect broken connections and clean up goroutines) is a solid answer.

### Senior @ FAANG: TCP Tuning as a System-Level Engineering Concern

At FAANG scale, TCP tuning is a platform concern that affects all services simultaneously. Linux TCP default values (send buffer size, receive buffer size, `net.core.somaxconn`, `tcp_tw_reuse`) are chosen for general workloads. A production fleet running high-throughput gRPC services or large WebSocket deployments needs tuned values, and those values must be set at the OS level (sysctl) rather than per-process.

The correct approach: establish a baseline with default TCP settings, run a load test to characterize the bottleneck (is it connection establishment rate, throughput, or tail latency?), apply targeted sysctl changes, and re-run the load test to validate improvement. Changes are then applied to the server image or container base image via platform infrastructure (not service code), so every service gets the benefit automatically.

`SO_REUSEPORT` deserves particular attention at scale. It allows multiple processes (or multiple listener goroutines) to bind to the same port, with the kernel distributing incoming connections across them. This eliminates the single-goroutine bottleneck on the accept loop for very high connection rates. At 100K+ connections per second, the single-goroutine accept loop can become the bottleneck before any application code runs. Enabling `SO_REUSEPORT` and running multiple accept goroutines scales accept throughput linearly with the number of goroutines.

---
