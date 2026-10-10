# GoCache - Distributed In-Memory Cache

A Redis-compatible distributed cache built from scratch in Go. Implements the RESP protocol, LRU eviction with TTL, consistent hashing for key routing, master-replica replication, and a Prometheus metrics endpoint - all with zero external runtime dependencies.

---

## Prerequisites

| Tool | Version |
|------|---------|
| Go | 1.27+   |
| make | any     |
| Docker + Docker Compose | 20.10+ (optional, for multi-node setup) |

---

## Architecture Overview

```
client/          Go client library with connection pooling
cmd/gocache/     Binary entrypoint (flags: -addr, -maxmemory)
internal/
  protocol/      RESP protocol parser and writer
  store/         In-memory KV store with LRU eviction + TTL
  cluster/       Consistent hash ring (virtual nodes)
  replication/   Master-replica replication over TCP
  server/        TCP server, command dispatcher
  metrics/       Prometheus metrics exposition
benchmark/       Throughput and latency benchmarks
test/            Integration tests
```

---

## Step-by-Step Build Guide

### Step 1 - RESP Protocol Parser

**What:** Implement the Redis Serialization Protocol (RESP) so the server can speak to any Redis client.

**Files:** `internal/protocol/resp.go`, `internal/protocol/writer.go`

**What it does:**
- Parses all five RESP types: `+` simple string, `-` error, `:` integer, `$` bulk string, `*` array
- The `Reader` wraps a `bufio.Reader` and decodes each wire message into a typed `Value` struct
- The `Writer` serializes `Value` back to wire format

**Test it:**
```go
// Encode a command
val := &protocol.Value{
    Type:  protocol.Array,
    Array: []protocol.Value{
        {Type: protocol.BulkString, Bulk: []byte("PING")},
    },
}
// Then decode the server's response
```

---

### Step 2 - In-Memory Store with LRU Eviction and TTL

**What:** Build the core storage engine with O(1) get/set, LRU eviction under memory pressure, and lazy + active TTL expiry.

**Files:** `internal/store/store.go`

**What it does:**
- `map[string]*entry` for O(1) lookup; `container/list` for LRU ordering
- `Set` checks `maxMemory` and evicts least-recently-used entries before inserting
- `Get` performs lazy TTL check on access
- Background goroutine sweeps up to 100 expired keys every 100 ms
- `Stats` tracks hits, misses, evictions, and key count

**Test it:**
```bash
go test ./internal/store/...
```

---

### Step 3 - Consistent Hash Ring

**What:** Implement consistent hashing so keys route deterministically to nodes, and adding/removing a node only remaps a proportional slice of keys.

**Files:** `internal/cluster/hashring.go`

**What it does:**
- Each physical node gets `virtualNodes` (default 150) slots on the ring using CRC32 hashes of `"nodeID:i"`
- `GetNode(key)` binary-searches the sorted ring and wraps around
- `GetNodes(key, n)` returns `n` unique nodes for replication factor > 1
- `AddNode` / `RemoveNode` rebuild the sorted slice atomically under a write lock

**Test it:**
```go
ring := cluster.NewHashRing(150)
ring.AddNode("node1:6379")
ring.AddNode("node2:6379")
node, _ := ring.GetNode("some-key")
```

---

### Step 4 - TCP Server

**What:** Wire the protocol parser and store together into a TCP server that handles concurrent connections.

**Files:** `internal/server/server.go`

**What it does:**
- Listens on a configurable address (default `:6379`)
- Each connection gets its own goroutine; `sync.WaitGroup` tracks them for graceful shutdown
- 30-second read deadline per connection prevents goroutine leaks from idle clients
- Command dispatcher handles: `PING`, `GET`, `SET` (with `EX`), `DEL`, `TTL`, `EXPIRE`, `KEYS`, `DBSIZE`, `INFO`, `FLUSHALL`

**Run it:**
```bash
go run ./cmd/gocache -addr :6379 -maxmemory 536870912
# Then connect with redis-cli
redis-cli -p 6379 PING
```

---

### Step 5 - Replication (Master → Replica)

**What:** Allow replica nodes to receive a live stream of write commands from the master.

**Files:** `internal/replication/replicator.go`

**What it does:**
- `Replicator` is role-aware (`master` or `replica`)
- Replica connects to master with `REPLCONF`, then streams incoming commands
- Master fans out each mutating command to all replica connections asynchronously
- Heartbeat goroutine pings each replica every second and removes dead ones

**Test it:**
```bash
# Terminal 1 - master
go run ./cmd/gocache -addr :6379

# Terminal 2 - replica (use REPLCONF in redis-cli, or the Go client)
redis-cli -p 6379 REPLCONF listening-port 6380
```

---

### Step 6 - Client Library

**What:** Provide a Go client with connection pooling so application code doesn't deal with raw RESP.

**Files:** `client/client.go`

**What it does:**
- `ConnectionPool` holds up to `maxConns` TCP connections; `GetConn` picks an idle one or dials a new one; `PutConn` returns it to the pool
- High-level methods: `Get`, `Set`, `Del`, `TTL`

**Use it:**
```go
c := client.NewClient(":6379", 10) // 10-connection pool
c.Set("hello", []byte("world"), nil)
val, _ := c.Get("hello")
```

---

### Step 7 - Cluster Coordination

**What:** Combine the hash ring with the client to build a cluster-aware client that routes keys across nodes.

**Files:** `internal/cluster/cluster.go`

**What it does:**
- Maintains a `HashRing` and a map of per-node `client.Client` instances
- `Get` / `Set` / `Del` resolve the target node via the ring and delegate

---

### Step 8 - Metrics

**What:** Expose a Prometheus `/metrics` endpoint for operational visibility.

**Files:** `internal/metrics/metrics.go`

**What it does:**
- Registers counters for cache hits, misses, and evictions
- Registers a gauge for current key count and memory usage
- Call `metrics.RecordHit()` / `RecordMiss()` / `RecordEviction()` from the store

**Scrape it:**
```bash
curl http://localhost:2112/metrics | grep gocache
```

---

## Running the Server

```bash
# Build
make build

# Run with defaults (port 6379, 1 GB RAM)
make run

# Run with custom flags
./bin/gocache -addr :6380 -maxmemory 268435456

# Run tests
make test

# Run benchmarks
make bench
```

### Environment Variables

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

| Variable       | Default     | Description                        |
|----------------|-------------|------------------------------------|
| `CACHE_ADDR`   | `:6379`     | TCP listen address                 |
| `MAX_MEMORY`   | `1073741824`| Max memory in bytes (1 GB default) |
| `METRICS_ADDR` | `:2112`     | Prometheus metrics listen address  |
| `LOG_LEVEL`    | `info`      | Logging verbosity                  |

---

## CLI / Protocol Reference

The server speaks RESP, so every Redis client works out of the box.

| Command                      | Description                                  |
|------------------------------|----------------------------------------------|
| `PING [message]`             | Returns PONG or echoes message               |
| `SET key value [EX seconds]` | Store a value with optional TTL              |
| `GET key`                    | Retrieve a value (nil if missing/expired)    |
| `DEL key [key ...]`          | Delete one or more keys, returns count       |
| `TTL key`                    | Seconds until expiry (-1 = no TTL, -2 = gone)|
| `EXPIRE key seconds`         | Set a TTL on an existing key                 |
| `KEYS`                       | List all live keys                           |
| `DBSIZE`                     | Return key count                             |
| `INFO`                       | Return hit/miss/eviction/memory stats        |
| `FLUSHALL`                   | Delete all keys                              |

### Multi-Node (Docker)

```bash
make docker-up    # starts 3-node cluster (ports 6379, 6380, 6381)
make docker-down
```

Connect to any node with `redis-cli -p 637x`.
