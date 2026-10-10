## 23.3 Network Chaos

Network failures are among the most common and most dangerous problems in distributed systems. A network partition can cause two halves of your cluster to believe the other half is down, leading to split-brain scenarios and data inconsistency. Simulating network chaos in Go means building custom dialers and connection wrappers that can block hosts, add latency, or drop datagrams on demand. These tools let you verify that your timeouts, retries, and circuit breakers behave correctly when the network becomes unreliable.

### Simulating Network Partitions

The `NetworkChaos` struct acts as a programmable dialer: it maintains a map of blocked hosts and per-host latency values that a test can modify at runtime, guarded by an `RWMutex` because the dialer is called from every goroutine that opens a connection.

The important detail is what a blocked host does. A real partition does not refuse your connection, it swallows it, and the caller only escapes when its own deadline fires. So the blocked branch waits on `ctx.Done()` rather than on a hardcoded timer. That distinction is the whole point of the exercise: if the dialer imposed its own 30-second wait, a caller with a 2-second deadline would still be stuck in the dialer long after it had given up, and you would be testing the injector's timeout instead of your own. Waiting on the context means the caller's timeout is the thing under test, which is what you actually wanted to know.

```go
package chaos

import (
    "context"
    "fmt"
    "net"
    "sync"
    "time"
)

type NetworkChaos struct {
    mu            sync.RWMutex
    blockedHosts  map[string]bool
    latencyByHost map[string]time.Duration
}

func NewNetworkChaos() *NetworkChaos {
    return &NetworkChaos{
        blockedHosts:  make(map[string]bool),
        latencyByHost: make(map[string]time.Duration),
    }
}

func (n *NetworkChaos) BlockHost(host string) {
    n.mu.Lock()
    defer n.mu.Unlock()
    n.blockedHosts[host] = true
}

func (n *NetworkChaos) UnblockHost(host string) {
    n.mu.Lock()
    defer n.mu.Unlock()
    delete(n.blockedHosts, host)
}

func (n *NetworkChaos) AddLatency(host string, latency time.Duration) {
    n.mu.Lock()
    defer n.mu.Unlock()
    n.latencyByHost[host] = latency
}

// Reset is the abort switch: it heals every partition at once. Defer it in
// any test that blocks a host, so a failing assertion cannot leave the
// dialer partitioned for the rest of the run.
func (n *NetworkChaos) Reset() {
    n.mu.Lock()
    defer n.mu.Unlock()
    clear(n.blockedHosts)
    clear(n.latencyByHost)
}

func (n *NetworkChaos) rules(host string) (blocked bool, latency time.Duration) {
    n.mu.RLock()
    defer n.mu.RUnlock()
    return n.blockedHosts[host], n.latencyByHost[host]
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
    t := time.NewTimer(d)
    defer t.Stop()
    select {
    case <-t.C:
        return true
    case <-ctx.Done():
        return false
    }
}

// Dialer returns a DialContext function suitable for http.Transport or
// grpc.WithContextDialer. base supplies the real dialing behaviour.
func (n *NetworkChaos) Dialer(base *net.Dialer) func(ctx context.Context, network, addr string) (net.Conn, error) {
    if base == nil {
        base = &net.Dialer{Timeout: 30 * time.Second}
    }

    return func(ctx context.Context, network, addr string) (net.Conn, error) {
        host, _, err := net.SplitHostPort(addr)
        if err != nil {
            host = addr
        }

        blocked, latency := n.rules(host)

        if blocked {
            // A partition is silence, not a refusal. Hang until the caller's
            // own deadline or cancellation ends the wait, exactly as a
            // blackholed SYN would.
            <-ctx.Done()
            return nil, &net.OpError{
                Op:  "dial",
                Net: network,
                Err: fmt.Errorf("chaos: host %s partitioned: %w", host, ctx.Err()),
            }
        }

        if latency > 0 && !sleepCtx(ctx, latency) {
            return nil, &net.OpError{Op: "dial", Net: network, Err: ctx.Err()}
        }

        return base.DialContext(ctx, network, addr)
    }
}
```

A test proves the contract holds. Block a host, give the caller a 100 millisecond deadline, and the dial comes back in roughly 100 milliseconds rather than 30 seconds:

```go
func TestBlockedDialerHonoursCallerDeadline(t *testing.T) {
    nc := NewNetworkChaos()
    defer nc.Reset()
    nc.BlockHost("db.internal")
    dial := nc.Dialer(nil)

    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    start := time.Now()
    _, err := dial(ctx, "tcp", "db.internal:5432")

    if err == nil {
        t.Fatal("want a dial error against a partitioned host")
    }
    if elapsed := time.Since(start); elapsed > time.Second {
        t.Fatalf("dialer ignored the caller's deadline, blocked for %v", elapsed)
    }
}
```

### Packet Loss Simulation

Here is where most hand-rolled chaos libraries quietly go wrong, so it is worth being precise about what packet loss is and where it can be simulated at all.

TCP does not expose packet loss to the application. That is the entire promise of the protocol. When a segment is dropped, TCP retransmits it, and your `Read` sees the same bytes it would have seen anyway, just later. Loss on a TCP connection surfaces to a Go program as *latency*, as a stall, or in the limit as a reset. It never surfaces as missing bytes. So a wrapper that randomly throws away bytes returned by `net.Conn.Read` is not simulating anything a real network can do to you. It is worse than that. The read has already pulled those bytes off the socket, so discarding them destroys data that TCP guaranteed was delivered, and every later read is reading from a stream that has silently lost a chunk out of its middle. If such a wrapper also reports `io.EOF` for the dropped read, it tells the caller the peer closed cleanly and then hands it more data on the next call, which violates the `io.Reader` contract in a way that will send you hunting for a bug in your own protocol code that does not exist.

Datagram loss is real, and it lives on `net.PacketConn`, where the unit of transfer is a whole message that either arrives intact or does not arrive at all. That is the interface to wrap:

```go
package chaos

import (
    "math/rand/v2"
    "net"
)

// LossyPacketConn drops whole datagrams. This is a faithful model: UDP either
// delivers a datagram intact or loses it entirely, and the sender is never told.
type LossyPacketConn struct {
    net.PacketConn
    readLossRate  float64
    writeLossRate float64
}

func NewLossyPacketConn(pc net.PacketConn, readLoss, writeLoss float64) *LossyPacketConn {
    return &LossyPacketConn{
        PacketConn:    pc,
        readLossRate:  readLoss,
        writeLossRate: writeLoss,
    }
}

func (c *LossyPacketConn) ReadFrom(b []byte) (int, net.Addr, error) {
    for {
        n, addr, err := c.PacketConn.ReadFrom(b)
        if err != nil {
            return n, addr, err
        }
        if rand.Float64() < c.readLossRate {
            // Drop it and keep waiting. A lost datagram is not an EOF and it
            // is not a short read, it is an arrival that never happens.
            continue
        }
        return n, addr, nil
    }
}

func (c *LossyPacketConn) WriteTo(b []byte, addr net.Addr) (int, error) {
    if rand.Float64() < c.writeLossRate {
        // Report success. The sender of a lost datagram never learns it was lost.
        return len(b), nil
    }
    return c.PacketConn.WriteTo(b, addr)
}
```

Point this at a real UDP socket with a 50 percent write loss rate, send 400 datagrams, and roughly half arrive. Every one that does arrive is byte-for-byte intact. That is the property you want from a loss simulator, and it is the property the TCP byte-dropping version cannot have.

For TCP, model what TCP actually does. Inject a stall to represent retransmission delay, or close the connection abruptly to represent a reset, and let the application's read see the error the kernel would really have given it:

```go
package chaos

import (
    "errors"
    "net"
    "sync"
    "time"
)

// errReset is what a reset connection reports on Read.
var errReset = errors.New("chaos: connection reset by peer")

// FlakyConn models the two things loss can actually do to a TCP connection:
// stall it, or kill it. It never invents missing bytes.
type FlakyConn struct {
    net.Conn
    mu         sync.Mutex
    resetAfter time.Time
    stall      time.Duration
}

func (c *FlakyConn) tripped() bool {
    c.mu.Lock()
    defer c.mu.Unlock()
    return !c.resetAfter.IsZero() && time.Now().After(c.resetAfter)
}

func (c *FlakyConn) Read(b []byte) (int, error) {
    if c.tripped() {
        c.Conn.Close()
        return 0, errReset
    }
    if c.stall > 0 {
        time.Sleep(c.stall)
    }
    return c.Conn.Read(b)
}
```

### Staff Lens: toxiproxy and Pumba

For production-grade network chaos, use `toxiproxy` (a TCP proxy from Shopify that you drive over an HTTP API) or `pumba` (container-level, driving `tc netem` and Docker actions). Chaos Mesh and Litmus offer the same primitives as Kubernetes custom resources. Hand-rolled chaos is for teaching, and for unit tests where you want a partition without a container runtime. Battle-tested tools are for operation.

The reason to prefer them is not just polish. Every one of them injects at a layer where the failure it names is a failure the network can genuinely produce, `tc netem` at the queueing discipline, toxiproxy at the TCP stream. That discipline is what keeps you from building the byte-dropping `net.Conn` above and spending a week debugging a protocol bug that only your test harness can create.

---
