## Part 4: TCP Server and Command Handler

### Server Implementation

The TCP server is what makes GoCache accessible to clients over the network. It listens on a configurable port, accepts incoming TCP connections, and spawns a dedicated goroutine for each client. Each connection gets its own RESP reader and writer pair, and the server reads commands in a loop until the client disconnects or an error occurs. The command handler uses a simple `switch` statement to dispatch recognized commands like GET, SET, DEL, and EXPIRE to the appropriate handler functions. A `context.Context` is used to coordinate graceful shutdown so that in-progress requests can complete before the server exits.

```go
// internal/server/server.go
package server

import (
    "context"
    "fmt"
    "io"
    "net"
    "strings"
    "sync"
    "time"

    "gocache/internal/protocol"
    "gocache/internal/store"
)

type Server struct {
    addr     string
    store    *store.Store
    listener net.Listener
    wg       sync.WaitGroup
    ctx      context.Context
    cancel   context.CancelFunc
}

func NewServer(addr string, maxMemory int64) *Server {
    ctx, cancel := context.WithCancel(context.Background())

    return &Server{
        addr:   addr,
        store:  store.NewStore(maxMemory),
        ctx:    ctx,
        cancel: cancel,
    }
}

func (s *Server) Start() error {
    listener, err := net.Listen("tcp", s.addr)
    if err != nil {
        return fmt.Errorf("failed to start server: %w", err)
    }

    s.listener = listener
    fmt.Printf("Server listening on %s\n", s.addr)

    s.wg.Add(1)
    go s.acceptConnections()

    return nil
}

func (s *Server) acceptConnections() {
    defer s.wg.Done()

    for {
        conn, err := s.listener.Accept()
        if err != nil {
            select {
            case <-s.ctx.Done():
                return
            default:
                fmt.Printf("Accept error: %v\n", err)
                continue
            }
        }

        s.wg.Add(1)
        go s.handleConnection(conn)
    }
}

func (s *Server) handleConnection(conn net.Conn) {
    defer s.wg.Done()
    defer conn.Close()

    reader := protocol.NewReader(conn)
    writer := protocol.NewWriter(conn)

    for {
        select {
        case <-s.ctx.Done():
            return
        default:
        }

        // Set read deadline
        conn.SetReadDeadline(time.Now().Add(30 * time.Second))

        value, err := reader.ReadValue()
        if err != nil {
            if err != io.EOF {
                writer.WriteError(fmt.Sprintf("ERR protocol error: %v", err))
            }
            return
        }

        // Reset read deadline
        conn.SetReadDeadline(time.Time{})

        if value.Type != protocol.Array {
            writer.WriteError("ERR expected array")
            continue
        }

        if err := s.handleCommand(value.Array, writer); err != nil {
            writer.WriteError(fmt.Sprintf("ERR %v", err))
        }
    }
}

func (s *Server) handleCommand(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) == 0 {
        return fmt.Errorf("empty command")
    }

    command := strings.ToUpper(string(args[0].Bulk))

    switch command {
    case "PING":
        return s.handlePing(args, writer)
    case "GET":
        return s.handleGet(args, writer)
    case "SET":
        return s.handleSet(args, writer)
    case "DEL":
        return s.handleDel(args, writer)
    case "TTL":
        return s.handleTTL(args, writer)
    case "EXPIRE":
        return s.handleExpire(args, writer)
    case "KEYS":
        return s.handleKeys(args, writer)
    case "DBSIZE":
        return s.handleDBSize(args, writer)
    case "INFO":
        return s.handleInfo(args, writer)
    case "FLUSHALL":
        return s.handleFlushAll(args, writer)
    default:
        return fmt.Errorf("unknown command '%s'", command)
    }
}

func (s *Server) handlePing(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) > 2 {
        return fmt.Errorf("wrong number of arguments for 'ping' command")
    }

    if len(args) == 2 {
        return writer.WriteBulkString(args[1].Bulk)
    }

    return writer.WriteSimpleString("PONG")
}

func (s *Server) handleGet(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) != 2 {
        return fmt.Errorf("wrong number of arguments for 'get' command")
    }

    key := string(args[1].Bulk)
    value, exists := s.store.Get(key)

    if !exists {
        return writer.WriteNull()
    }

    return writer.WriteBulkString(value)
}

func (s *Server) handleSet(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) < 3 {
        return fmt.Errorf("wrong number of arguments for 'set' command")
    }

    key := string(args[1].Bulk)
    value := args[2].Bulk

    var ttl *time.Duration

    // Parse optional TTL (SET key value EX seconds)
    for i := 3; i < len(args); i++ {
        option := strings.ToUpper(string(args[i].Bulk))
        if option == "EX" && i+1 < len(args) {
            seconds := args[i+1].Num
            duration := time.Duration(seconds) * time.Second
            ttl = &duration
            i++
        }
    }

    s.store.Set(key, value, ttl)
    return writer.WriteOK()
}

func (s *Server) handleDel(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) < 2 {
        return fmt.Errorf("wrong number of arguments for 'del' command")
    }

    deleted := 0
    for i := 1; i < len(args); i++ {
        key := string(args[i].Bulk)
        if s.store.Delete(key) {
            deleted++
        }
    }

    return writer.WriteInteger(int64(deleted))
}

func (s *Server) handleTTL(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) != 2 {
        return fmt.Errorf("wrong number of arguments for 'ttl' command")
    }

    key := string(args[1].Bulk)
    ttl, exists := s.store.TTL(key)

    if !exists {
        return writer.WriteInteger(-2)
    }

    return writer.WriteInteger(ttl)
}

func (s *Server) handleExpire(args []protocol.Value, writer *protocol.Writer) error {
    if len(args) != 3 {
        return fmt.Errorf("wrong number of arguments for 'expire' command")
    }

    key := string(args[1].Bulk)
    seconds := args[2].Num

    success := s.store.Expire(key, time.Duration(seconds)*time.Second)

    if success {
        return writer.WriteInteger(1)
    }
    return writer.WriteInteger(0)
}

func (s *Server) handleKeys(args []protocol.Value, writer *protocol.Writer) error {
    keys := s.store.Keys()

    values := make([]protocol.Value, len(keys))
    for i, key := range keys {
        values[i] = protocol.Value{
            Type: protocol.BulkString,
            Bulk: []byte(key),
        }
    }

    return writer.WriteArray(values)
}

func (s *Server) handleDBSize(args []protocol.Value, writer *protocol.Writer) error {
    stats := s.store.GetStats()
    return writer.WriteInteger(stats.Keys)
}

func (s *Server) handleInfo(args []protocol.Value, writer *protocol.Writer) error {
    stats := s.store.GetStats()

    info := fmt.Sprintf(
        "# Stats\r\n"+
            "keys:%d\r\n"+
            "hits:%d\r\n"+
            "misses:%d\r\n"+
            "evictions:%d\r\n"+
            "memory_bytes:%d\r\n",
        stats.Keys,
        stats.Hits,
        stats.Misses,
        stats.Evictions,
        s.store.Size(),
    )

    return writer.WriteBulkString([]byte(info))
}

func (s *Server) handleFlushAll(args []protocol.Value, writer *protocol.Writer) error {
    s.store = store.NewStore(s.store.Size())
    return writer.WriteOK()
}

func (s *Server) Stop() error {
    s.cancel()

    if s.listener != nil {
        s.listener.Close()
    }

    s.wg.Wait()
    return nil
}
```

---

### Junior → FAANG: TCP Server as a Go Concurrency Exercise

The "one goroutine per connection" model is Go's idiomatic approach to concurrent TCP server design. Each accepted connection spawns a goroutine that reads commands in a loop until the connection closes. This model is efficient because goroutines are cheap (2KB initial stack) and Go's scheduler handles thousands of them without OS thread overhead.

Graceful shutdown (using `context.Context` to signal goroutines to stop) is a correctness requirement. Without it, your server process exits while goroutines are mid-command, potentially corrupting in-flight writes. The pattern is: cancel the root context on SIGTERM, every goroutine checks `ctx.Done()` at its next loop iteration, all goroutines complete their current command and exit.

The command dispatcher (`switch` on command name) is a common pattern for protocol implementation. Know its limitation: it does not scale to hundreds of commands without performance degradation. A map from command name to handler function is an alternative that has O(1) dispatch time regardless of the number of commands.

### Senior @ FAANG: TCP Server as a Resource Management Boundary

At senior level, the TCP server is responsible for connection lifecycle management. Every accepted connection consumes a file descriptor. A server that accepts connections without limit will exhaust the process's file descriptor limit (typically 1024 by default, configurable up to millions on Linux) under sustained load. Connection backpressure (accepting connections at a controlled rate, returning EAGAIN when at capacity) is required for production stability.

Read and write deadlines (`conn.SetReadDeadline`, `conn.SetWriteDeadline`) are the mechanisms for preventing goroutine leaks from idle connections. A client that connects but never sends a command would hold a goroutine indefinitely without read deadlines. The typical read deadline for a cache server is 60-300 seconds, long enough for legitimate idle connections but short enough to detect zombie connections.

TCP keepalive (`conn.(*net.TCPConn).SetKeepAlive(true)`) is the OS-level mechanism for detecting dead connections. Without keepalive, a connection to a dead peer (power failure, network partition) appears live indefinitely. Keepalive probes detect this condition and trigger the read deadline, allowing the goroutine to exit cleanly. Both keepalive and application-level heartbeats are best practice for long-lived TCP connections.

---
