## Part 6: Client Library

### Go Client with Connection Pooling

A well-designed client library makes it easy for application developers to interact with GoCache without worrying about low-level protocol details. This client wraps the RESP protocol behind simple methods like `Get`, `Set`, and `Del` that accept normal Go types. The connection pool is a key performance feature: instead of opening a new TCP connection for every request (which is slow), the pool maintains a set of reusable connections. When a method needs a connection, it borrows one from the pool, sends the command, reads the response, and returns the connection for the next caller to use.

```go
// client/client.go
package client

import (
    "fmt"
    "net"
    "sync"
    "time"

    "gocache/internal/protocol"
)

type Client struct {
    pool *ConnectionPool
}

type ConnectionPool struct {
    addr     string
    maxConns int
    mu       sync.Mutex
    conns    chan net.Conn
    active   int
}

func NewClient(addr string, poolSize int) *Client {
    return &Client{
        pool: &ConnectionPool{
            addr:     addr,
            maxConns: poolSize,
            conns:    make(chan net.Conn, poolSize),
        },
    }
}

func (c *Client) Get(key string) ([]byte, error) {
    conn, err := c.pool.GetConn()
    if err != nil {
        return nil, err
    }
    defer c.pool.PutConn(conn)

    writer := protocol.NewWriter(conn)
    reader := protocol.NewReader(conn)

    // Send GET command
    cmd := &protocol.Value{
        Type: protocol.Array,
        Array: []protocol.Value{
            {Type: protocol.BulkString, Bulk: []byte("GET")},
            {Type: protocol.BulkString, Bulk: []byte(key)},
        },
    }

    if err := writer.WriteValue(cmd); err != nil {
        return nil, err
    }

    // Read response
    resp, err := reader.ReadValue()
    if err != nil {
        return nil, err
    }

    if resp.Type == protocol.BulkString {
        return resp.Bulk, nil
    }

    return nil, fmt.Errorf("unexpected response type")
}

func (c *Client) Set(key string, value []byte, ttl *time.Duration) error {
    conn, err := c.pool.GetConn()
    if err != nil {
        return err
    }
    defer c.pool.PutConn(conn)

    writer := protocol.NewWriter(conn)
    reader := protocol.NewReader(conn)

    // Build SET command
    args := []protocol.Value{
        {Type: protocol.BulkString, Bulk: []byte("SET")},
        {Type: protocol.BulkString, Bulk: []byte(key)},
        {Type: protocol.BulkString, Bulk: value},
    }

    if ttl != nil {
        args = append(args,
            protocol.Value{Type: protocol.BulkString, Bulk: []byte("EX")},
            protocol.Value{Type: protocol.Integer, Num: int64(ttl.Seconds())},
        )
    }

    cmd := &protocol.Value{
        Type:  protocol.Array,
        Array: args,
    }

    if err := writer.WriteValue(cmd); err != nil {
        return err
    }

    // Read response
    resp, err := reader.ReadValue()
    if err != nil {
        return err
    }

    if resp.Type == protocol.SimpleString && resp.Str == "OK" {
        return nil
    }

    return fmt.Errorf("unexpected response")
}

func (c *Client) Del(keys ...string) (int64, error) {
    conn, err := c.pool.GetConn()
    if err != nil {
        return 0, err
    }
    defer c.pool.PutConn(conn)

    writer := protocol.NewWriter(conn)
    reader := protocol.NewReader(conn)

    args := make([]protocol.Value, len(keys)+1)
    args[0] = protocol.Value{Type: protocol.BulkString, Bulk: []byte("DEL")}

    for i, key := range keys {
        args[i+1] = protocol.Value{Type: protocol.BulkString, Bulk: []byte(key)}
    }

    cmd := &protocol.Value{
        Type:  protocol.Array,
        Array: args,
    }

    if err := writer.WriteValue(cmd); err != nil {
        return 0, err
    }

    resp, err := reader.ReadValue()
    if err != nil {
        return 0, err
    }

    if resp.Type == protocol.Integer {
        return resp.Num, nil
    }

    return 0, fmt.Errorf("unexpected response")
}

func (c *Client) TTL(key string) (int64, error) {
    conn, err := c.pool.GetConn()
    if err != nil {
        return 0, err
    }
    defer c.pool.PutConn(conn)

    writer := protocol.NewWriter(conn)
    reader := protocol.NewReader(conn)

    cmd := &protocol.Value{
        Type: protocol.Array,
        Array: []protocol.Value{
            {Type: protocol.BulkString, Bulk: []byte("TTL")},
            {Type: protocol.BulkString, Bulk: []byte(key)},
        },
    }

    if err := writer.WriteValue(cmd); err != nil {
        return 0, err
    }

    resp, err := reader.ReadValue()
    if err != nil {
        return 0, err
    }

    if resp.Type == protocol.Integer {
        return resp.Num, nil
    }

    return 0, fmt.Errorf("unexpected response")
}

func (c *Client) Close() error {
    c.pool.mu.Lock()
    defer c.pool.mu.Unlock()

    close(c.pool.conns)
    for conn := range c.pool.conns {
        conn.Close()
    }

    return nil
}

// Connection Pool Methods

func (p *ConnectionPool) GetConn() (net.Conn, error) {
    select {
    case conn := <-p.conns:
        return conn, nil
    default:
        p.mu.Lock()
        if p.active < p.maxConns {
            p.active++
            p.mu.Unlock()
            return net.Dial("tcp", p.addr)
        }
        p.mu.Unlock()

        // Wait for available connection
        return <-p.conns, nil
    }
}

func (p *ConnectionPool) PutConn(conn net.Conn) {
    select {
    case p.conns <- conn:
    default:
        conn.Close()
        p.mu.Lock()
        p.active--
        p.mu.Unlock()
    }
}
```

---

### Junior → FAANG: Client Libraries as Developer Experience

A good client library hides protocol complexity behind a clean API. Application developers should be able to use `cache.Get(ctx, "key")` and `cache.Set(ctx, "key", value, ttl)` without knowing anything about RESP or TCP. The client library is the abstraction layer that makes the cache usable.

Connection pooling is the most important performance feature of a client library. Without pooling, each request opens a new TCP connection, performs the TLS handshake (if applicable), and closes the connection. At 10k requests per second, connection setup overhead dominates latency. With pooling, connections are reused across requests, reducing overhead to near zero.

For interviews, describe the connection pool lifecycle: checkout a connection, send the command, read the response, return the connection to the pool. Handle the case where the server closes the connection (detect on next use, remove from pool, open a new connection transparently).

### Senior @ FAANG: Client Library as a Platform Artifact

At senior level, a client library is a platform artifact that multiple teams depend on. Breaking changes to the client library affect all teams simultaneously. The client library must be versioned, documented, and maintained with the same rigor as a public API.

Circuit breakers in the client library protect the application from a failing cache server. When the cache server is unhealthy, requests fail fast rather than accumulating in the connection pool queue. The circuit breaker opens (fails fast) when the error rate exceeds a threshold, gives the server time to recover, then closes (resumes sending requests) after a probe succeeds. This pattern prevents cascading failures where a slow cache causes application thread pool exhaustion.

Observability in the client library (recording connection pool utilization, per-operation latency, error rates by error type) gives application teams visibility into cache behavior without instrumentation in their own code. The platform team that owns the client library includes this observability by default. Application teams benefit from it automatically. This is the right ownership model for shared infrastructure.

---
