## 63.3 Distributed Cache Architecture

### Cache Cluster

A distributed cache cluster uses consistent hashing to partition keys across multiple cache nodes, so each node is responsible for a predictable subset of the keyspace. The `CacheCluster` manages a consistent hash ring and a map of node addresses to individual cache node clients, routing each operation to the correct node based on the key's hash position on the ring. When a node is added or removed, only the keys that hash to the affected range need to be rebalanced, minimizing cache invalidation during topology changes.

```go
// cluster/cluster.go
package cluster

import (
    "context"
    "errors"
    "sync"
    "time"

    "yourproject/cache"
    "yourproject/consistent"
)

var (
    ErrNoAvailableNodes  = errors.New("no available nodes")
    ErrKeyNotFound       = errors.New("key not found")
    ErrWriteQuorumNotMet = errors.New("write quorum not met")
)

// ClusterConfig holds distributed cache cluster configuration
type ClusterConfig struct {
    ReplicationFactor int
    LocalCacheConfig  cache.Config
}

// CacheCluster manages a distributed cache cluster
type CacheCluster struct {
    mu          sync.RWMutex
    nodes       map[string]*CacheNode
    hashRing    *consistent.HashRing
    replication int
    localCache  *cache.Cache
}

// CacheNode represents a cache node
type CacheNode struct {
    ID       string
    Address  string
    Client   CacheClient
    Healthy  bool
    LastPing time.Time
}

// CacheClient interface for cache operations
type CacheClient interface {
    Get(ctx context.Context, key string) ([]byte, error)
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
    Delete(ctx context.Context, key string) error
    Ping(ctx context.Context) error
}

// NewCacheCluster creates a new cache cluster
func NewCacheCluster(config ClusterConfig) *CacheCluster {
    return &CacheCluster{
        nodes:       make(map[string]*CacheNode),
        hashRing:    consistent.NewHashRing(150), // 150 virtual nodes
        replication: config.ReplicationFactor,
        localCache:  cache.NewCache(config.LocalCacheConfig),
    }
}

// AddNode adds a node to the cluster
func (c *CacheCluster) AddNode(node *CacheNode) {
    c.mu.Lock()
    defer c.mu.Unlock()

    c.nodes[node.ID] = node
    c.hashRing.AddNode(node.ID)
}

// RemoveNode removes a node from the cluster
func (c *CacheCluster) RemoveNode(nodeID string) {
    c.mu.Lock()
    defer c.mu.Unlock()

    delete(c.nodes, nodeID)
    c.hashRing.RemoveNode(nodeID)
}

// Get retrieves a value from the cluster
func (c *CacheCluster) Get(ctx context.Context, key string) ([]byte, error) {
    // Check local cache first
    if value, ok := c.localCache.Get(key); ok {
        return value, nil
    }

    // Get responsible nodes
    nodes := c.getNodesForKey(key)
    if len(nodes) == 0 {
        return nil, ErrNoAvailableNodes
    }

    // Try primary node first
    for _, node := range nodes {
        value, err := node.Client.Get(ctx, key)
        if err == nil {
            // Cache locally
            c.localCache.Set(key, value, time.Minute)
            return value, nil
        }
    }

    return nil, ErrKeyNotFound
}

// Set stores a value in the cluster
func (c *CacheCluster) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    nodes := c.getNodesForKey(key)
    if len(nodes) == 0 {
        return ErrNoAvailableNodes
    }

    // Write to all replica nodes
    var wg sync.WaitGroup
    errCh := make(chan error, len(nodes))

    for _, node := range nodes {
        wg.Add(1)
        go func(n *CacheNode) {
            defer wg.Done()
            if err := n.Client.Set(ctx, key, value, ttl); err != nil {
                errCh <- err
            }
        }(node)
    }

    wg.Wait()
    close(errCh)

    // Check for write quorum
    errorCount := 0
    for range errCh {
        errorCount++
    }

    quorum := (len(nodes) / 2) + 1
    if len(nodes)-errorCount < quorum {
        return ErrWriteQuorumNotMet
    }

    // Update local cache
    c.localCache.Set(key, value, ttl)

    return nil
}

// Delete removes a key from the cluster
func (c *CacheCluster) Delete(ctx context.Context, key string) error {
    nodes := c.getNodesForKey(key)

    var wg sync.WaitGroup
    for _, node := range nodes {
        wg.Add(1)
        go func(n *CacheNode) {
            defer wg.Done()
            n.Client.Delete(ctx, key)
        }(node)
    }

    wg.Wait()

    // Delete from local cache
    c.localCache.Delete(key)

    return nil
}

func (c *CacheCluster) getNodesForKey(key string) []*CacheNode {
    c.mu.RLock()
    defer c.mu.RUnlock()

    nodeIDs := c.hashRing.GetNodes(key, c.replication)
    nodes := make([]*CacheNode, 0, len(nodeIDs))

    for _, id := range nodeIDs {
        if node, ok := c.nodes[id]; ok && node.Healthy {
            nodes = append(nodes, node)
        }
    }

    return nodes
}
```

### Cache Protocol

A custom binary protocol is necessary when a cache must serve millions of requests per second and text-based formats like HTTP add unacceptable parsing overhead. This protocol uses a fixed-length header with a 1-byte command code, a 2-byte key length, a 4-byte value length, and an 8-byte TTL, encoding fields with `encoding/binary` in big-endian order so the wire format is deterministic across architectures. The `bufio.Writer` and `bufio.Reader` wrappers batch small writes into larger syscalls and buffer reads ahead, which is critical because cache values are often small and issuing one syscall per byte would saturate the kernel.

```go
// protocol/protocol.go
package protocol

import (
    "bufio"
    "encoding/binary"
    "fmt"
    "io"
    "time"
)

// Command types
const (
    CmdGet    byte = 0x01
    CmdSet    byte = 0x02
    CmdDelete byte = 0x03
    CmdPing   byte = 0x04
    CmdStats  byte = 0x05
)

// Response codes
const (
    RespOK       byte = 0x00
    RespNotFound byte = 0x01
    RespError    byte = 0x02
)

// Request represents a cache request
type Request struct {
    Command byte
    Key     string
    Value   []byte
    TTL     time.Duration
}

// Response represents a cache response
type Response struct {
    Code  byte
    Value []byte
    Error string
}

// Encoder encodes requests/responses
type Encoder struct {
    w *bufio.Writer
}

// NewEncoder creates a new encoder
func NewEncoder(w io.Writer) *Encoder {
    return &Encoder{w: bufio.NewWriter(w)}
}

// EncodeRequest encodes a request
func (e *Encoder) EncodeRequest(req *Request) error {
    // Command (1 byte)
    if err := e.w.WriteByte(req.Command); err != nil {
        return err
    }

    // Key length (2 bytes) + key
    keyLen := uint16(len(req.Key))
    if err := binary.Write(e.w, binary.BigEndian, keyLen); err != nil {
        return err
    }
    if _, err := e.w.WriteString(req.Key); err != nil {
        return err
    }

    // For SET: value length (4 bytes) + value + TTL (8 bytes)
    if req.Command == CmdSet {
        valueLen := uint32(len(req.Value))
        if err := binary.Write(e.w, binary.BigEndian, valueLen); err != nil {
            return err
        }
        if _, err := e.w.Write(req.Value); err != nil {
            return err
        }
        if err := binary.Write(e.w, binary.BigEndian, int64(req.TTL)); err != nil {
            return err
        }
    }

    return e.w.Flush()
}

// EncodeResponse encodes a response
func (e *Encoder) EncodeResponse(resp *Response) error {
    // Code (1 byte)
    if err := e.w.WriteByte(resp.Code); err != nil {
        return err
    }

    // Value length (4 bytes) + value (or error). The length must be
    // written even when the value is empty (a SET or DELETE ack):
    // the decoder unconditionally reads 4 length bytes for RespOK,
    // and skipping them here would desynchronize the stream.
    if resp.Code == RespOK {
        valueLen := uint32(len(resp.Value))
        if err := binary.Write(e.w, binary.BigEndian, valueLen); err != nil {
            return err
        }
        if valueLen > 0 {
            if _, err := e.w.Write(resp.Value); err != nil {
                return err
            }
        }
    } else if resp.Code == RespError {
        errLen := uint32(len(resp.Error))
        if err := binary.Write(e.w, binary.BigEndian, errLen); err != nil {
            return err
        }
        if _, err := e.w.WriteString(resp.Error); err != nil {
            return err
        }
    }

    return e.w.Flush()
}

// Decoder decodes requests/responses
type Decoder struct {
    r *bufio.Reader
}

// NewDecoder creates a new decoder
func NewDecoder(r io.Reader) *Decoder {
    return &Decoder{r: bufio.NewReader(r)}
}

// DecodeRequest decodes a request
func (d *Decoder) DecodeRequest() (*Request, error) {
    req := &Request{}

    // Command
    cmd, err := d.r.ReadByte()
    if err != nil {
        return nil, err
    }
    req.Command = cmd

    // Key
    var keyLen uint16
    if err := binary.Read(d.r, binary.BigEndian, &keyLen); err != nil {
        return nil, err
    }
    keyBuf := make([]byte, keyLen)
    if _, err := io.ReadFull(d.r, keyBuf); err != nil {
        return nil, err
    }
    req.Key = string(keyBuf)

    // Value and TTL for SET
    if req.Command == CmdSet {
        var valueLen uint32
        if err := binary.Read(d.r, binary.BigEndian, &valueLen); err != nil {
            return nil, err
        }
        // Never allocate based on an unvalidated wire length: a
        // malicious 4GB length would OOM the server on one request.
        if valueLen > 64<<20 {
            return nil, fmt.Errorf("value length %d exceeds limit", valueLen)
        }
        req.Value = make([]byte, valueLen)
        if _, err := io.ReadFull(d.r, req.Value); err != nil {
            return nil, err
        }
        var ttl int64
        if err := binary.Read(d.r, binary.BigEndian, &ttl); err != nil {
            return nil, err
        }
        req.TTL = time.Duration(ttl)
    }

    return req, nil
}

// DecodeResponse decodes a response
func (d *Decoder) DecodeResponse() (*Response, error) {
    resp := &Response{}

    // Code
    code, err := d.r.ReadByte()
    if err != nil {
        return nil, err
    }
    resp.Code = code

    // Value or Error
    if resp.Code == RespOK || resp.Code == RespError {
        var dataLen uint32
        if err := binary.Read(d.r, binary.BigEndian, &dataLen); err != nil {
            return nil, err
        }
        if dataLen > 0 {
            data := make([]byte, dataLen)
            if _, err := io.ReadFull(d.r, data); err != nil {
                return nil, err
            }
            if resp.Code == RespOK {
                resp.Value = data
            } else {
                resp.Error = string(data)
            }
        }
    }

    return resp, nil
}
```

### Cache Server

The cache server runs each accepted TCP connection in its own goroutine, allowing thousands of clients to operate concurrently without blocking each other. A 30-second read deadline on every iteration of the connection loop prevents idle connections from leaking goroutines indefinitely, if a client stops sending requests, the connection is closed and the goroutine exits cleanly. The `quit` channel combined with `sync.WaitGroup` in `Stop()` ensures in-flight requests finish processing before the server shuts down, avoiding abrupt mid-response disconnections under graceful termination.

```go
// server/server.go
package server

import (
    "context"
    "net"
    "sync"
    "time"

    "yourproject/cache"
    "yourproject/protocol"
)

// Server handles cache requests
type Server struct {
    cache    *cache.Cache
    listener net.Listener
    wg       sync.WaitGroup
    quit     chan struct{}
}

// NewServer creates a new cache server
func NewServer(c *cache.Cache) *Server {
    return &Server{
        cache: c,
        quit:  make(chan struct{}),
    }
}

// Start starts the cache server
func (s *Server) Start(addr string) error {
    listener, err := net.Listen("tcp", addr)
    if err != nil {
        return err
    }
    s.listener = listener

    go s.acceptLoop()

    return nil
}

func (s *Server) acceptLoop() {
    for {
        conn, err := s.listener.Accept()
        if err != nil {
            select {
            case <-s.quit:
                return
            default:
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

    decoder := protocol.NewDecoder(conn)
    encoder := protocol.NewEncoder(conn)

    for {
        // Set read deadline
        conn.SetReadDeadline(time.Now().Add(30 * time.Second))

        req, err := decoder.DecodeRequest()
        if err != nil {
            return
        }

        resp := s.handleRequest(req)

        if err := encoder.EncodeResponse(resp); err != nil {
            return
        }
    }
}

func (s *Server) handleRequest(req *protocol.Request) *protocol.Response {
    switch req.Command {
    case protocol.CmdGet:
        value, ok := s.cache.Get(req.Key)
        if !ok {
            return &protocol.Response{Code: protocol.RespNotFound}
        }
        return &protocol.Response{Code: protocol.RespOK, Value: value}

    case protocol.CmdSet:
        err := s.cache.Set(req.Key, req.Value, req.TTL)
        if err != nil {
            return &protocol.Response{Code: protocol.RespError, Error: err.Error()}
        }
        return &protocol.Response{Code: protocol.RespOK}

    case protocol.CmdDelete:
        s.cache.Delete(req.Key)
        return &protocol.Response{Code: protocol.RespOK}

    case protocol.CmdPing:
        return &protocol.Response{Code: protocol.RespOK}

    case protocol.CmdStats:
        stats := s.cache.Stats()
        // Serialize stats
        return &protocol.Response{Code: protocol.RespOK}

    default:
        return &protocol.Response{Code: protocol.RespError, Error: "unknown command"}
    }
}

// Stop gracefully stops the server
func (s *Server) Stop() {
    close(s.quit)
    s.listener.Close()
    s.wg.Wait()
}
```

### Junior -> FAANG: Consistent Hashing as the Prerequisite Algorithm

Consistent hashing is the algorithm that makes adding or removing a node safe. Before consistent hashing, distributed systems used `hash(key) % N` to route keys to nodes. When N changes (a node is added or removed), every key's target node changes, invalidating the entire cache. Consistent hashing places both keys and nodes on a circular hash ring, so only the keys between the removed node and its predecessor need to be remapped. Know the exact statement: "adding or removing a node remaps only 1/N of keys on average."

The 150 virtual nodes per physical node in `NewHashRing(150)` is a tuning parameter. Fewer virtual nodes means more uneven key distribution (some nodes get more keys than others). More virtual nodes means more even distribution but also more ring positions to scan per lookup (O(log(N * virtual_nodes)) binary search). 150 is a common production value for Redis Cluster-like workloads. Know that real Redis Cluster uses 16,384 hash slots, which is a different mechanism (pre-sharded slots) but solves the same distribution problem.

The write quorum check (`len(nodes)-errorCount < quorum`) is the minimum correctness requirement for a replicated cache write. If you write to 3 replicas and 2 fail, you have a quorum of 1 out of 3, which is below the majority quorum of 2. The write must fail or the caller will believe data is safely stored when it is not. This is the same quorum math used in Raft and Paxos.

The local cache layer (`c.localCache.Set(key, value, time.Minute)` in `Get`) is the L1 cache in a multi-tier design. Understand the trade-off: a one-minute local TTL means this process can serve a key for up to one minute after it has been updated in the cluster. This is a one-minute staleness window that is acceptable for most non-critical data.

### Senior @ FAANG: Cluster Architecture for Production Workloads

**The custom binary protocol is the right choice only in specific contexts**

The binary cache protocol in this section is appropriate for a self-built cache daemon. If you are building on top of Redis, you use the RESP3 protocol and the official Go client. Building a custom protocol means you own the security, compatibility, and performance of that protocol forever. A principal-level candidate asks: "Why are we building a custom cache daemon rather than using Redis?" If the answer is "memory efficiency" or "connection management at extreme scale" (as it was for Twitter's Twemcache), the custom daemon is justified. If the answer is "we wanted to learn," a managed Redis cluster is the correct production choice.

**The cache server's `handleConnection` has a connection leak risk**

The `handleConnection` goroutine sets a 30-second read deadline on every loop iteration. If a client sends requests continuously without gaps, the deadline is reset on every iteration and the connection never times out. This is correct for healthy clients. But a client that sends malformed data that the decoder partially reads, then stalls, will hold the goroutine open for 30 seconds per stall. The production mitigation is to set a deadline on the connection itself (`conn.SetDeadline(time.Now().Add(30 * time.Second))`) rather than per-read, so the entire connection is bounded by a 30-second wall clock limit regardless of partial reads.

**Cluster topology change handling is the hardest operational problem**

The `AddNode` and `RemoveNode` operations update the hash ring and immediately affect key routing. In-flight requests that were routed to the old topology may now miss the cache (the key moved to a different node). The production mitigation is a short "dual-read" window during topology changes: for a configurable period after adding or removing a node, read from both the old and new node for any key, and take whichever responds first with a hit. This window allows the key distribution to stabilize without serving unnecessary cache misses.

**The replication factor as an operational decision**

The `replication int` field in `CacheCluster` is typically 2 or 3 in production. Replication factor of 1 (no redundancy) means a single node failure makes all keys on that node unavailable until the node recovers or is replaced. Replication factor of 2 tolerates a single node failure. Replication factor of 3 tolerates two simultaneous node failures and is the minimum for running Raft or Paxos safely. The operational cost of higher replication factors is more write traffic (every write goes to R nodes) and more memory (each key is stored R times). For cache workloads, replication factor of 2 is the most common production value, balancing redundancy against cost.

---
