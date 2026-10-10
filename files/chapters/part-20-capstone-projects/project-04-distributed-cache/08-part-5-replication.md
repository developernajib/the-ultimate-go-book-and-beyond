## Part 5: Replication

### Replication Manager

Replication gives your cache high availability by copying data from a master node to one or more replica nodes. If the master goes down, a replica can take over and continue serving requests without data loss. The replication manager handles both sides of this relationship: on the master side, it maintains connections to all replicas and forwards every write command asynchronously. On the replica side, it connects to its master, receives replicated commands, and applies them to its local store. A heartbeat mechanism (regular PING/PONG exchanges) detects when a replica becomes unreachable so it can be removed from the replication set.

```go
// internal/replication/replicator.go
package replication

import (
    "bufio"
    "fmt"
    "net"
    "sync"
    "time"

    "gocache/internal/protocol"
)

type ReplicationRole string

const (
    RoleMaster  ReplicationRole = "master"
    RoleReplica ReplicationRole = "replica"
)

type Replicator struct {
    role     ReplicationRole
    mu       sync.RWMutex
    replicas map[string]net.Conn
    master   *masterConn
}

type masterConn struct {
    conn   net.Conn
    writer *protocol.Writer
}

func NewReplicator(role ReplicationRole) *Replicator {
    return &Replicator{
        role:     role,
        replicas: make(map[string]net.Conn),
    }
}

func (r *Replicator) ConnectToMaster(masterAddr string) error {
    conn, err := net.Dial("tcp", masterAddr)
    if err != nil {
        return fmt.Errorf("failed to connect to master: %w", err)
    }

    r.mu.Lock()
    r.master = &masterConn{
        conn:   conn,
        writer: protocol.NewWriter(conn),
    }
    r.mu.Unlock()

    // Send REPLCONF to master
    if err := r.sendReplConf(); err != nil {
        return err
    }

    // Start replication
    go r.receiveReplication()

    return nil
}

func (r *Replicator) sendReplConf() error {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if r.master == nil {
        return fmt.Errorf("not connected to master")
    }

    // Send REPLCONF listening-port
    cmd := &protocol.Value{
        Type: protocol.Array,
        Array: []protocol.Value{
            {Type: protocol.BulkString, Bulk: []byte("REPLCONF")},
            {Type: protocol.BulkString, Bulk: []byte("listening-port")},
            {Type: protocol.BulkString, Bulk: []byte("6380")},
        },
    }

    return r.master.writer.WriteValue(cmd)
}

func (r *Replicator) receiveReplication() {
    r.mu.RLock()
    conn := r.master.conn
    r.mu.RUnlock()

    reader := protocol.NewReader(conn)

    for {
        value, err := reader.ReadValue()
        if err != nil {
            fmt.Printf("Replication error: %v\n", err)
            return
        }

        // Process replicated command
        r.processReplicatedCommand(value)
    }
}

func (r *Replicator) processReplicatedCommand(value *protocol.Value) {
    // Apply command to local store
    // This would integrate with the store
    fmt.Printf("Received replicated command: %+v\n", value)
}

func (r *Replicator) AddReplica(replicaID string, conn net.Conn) {
    r.mu.Lock()
    defer r.mu.Unlock()

    r.replicas[replicaID] = conn

    // Start heartbeat
    go r.sendHeartbeat(replicaID, conn)
}

func (r *Replicator) RemoveReplica(replicaID string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if conn, exists := r.replicas[replicaID]; exists {
        conn.Close()
        delete(r.replicas, replicaID)
    }
}

func (r *Replicator) ReplicateCommand(cmd *protocol.Value) error {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if r.role != RoleMaster {
        return nil // Only masters replicate
    }

    // Send to all replicas asynchronously
    for replicaID, conn := range r.replicas {
        go func(id string, c net.Conn) {
            writer := protocol.NewWriter(c)
            if err := writer.WriteValue(cmd); err != nil {
                fmt.Printf("Failed to replicate to %s: %v\n", id, err)
            }
        }(replicaID, conn)
    }

    return nil
}

func (r *Replicator) sendHeartbeat(replicaID string, conn net.Conn) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    writer := protocol.NewWriter(conn)
    reader := bufio.NewReader(conn)

    for range ticker.C {
        // Send PING
        ping := &protocol.Value{
            Type: protocol.Array,
            Array: []protocol.Value{
                {Type: protocol.BulkString, Bulk: []byte("PING")},
            },
        }

        if err := writer.WriteValue(ping); err != nil {
            r.RemoveReplica(replicaID)
            return
        }

        // Wait for PONG (with timeout)
        conn.SetReadDeadline(time.Now().Add(2 * time.Second))
        _, err := reader.ReadByte()
        if err != nil {
            r.RemoveReplica(replicaID)
            return
        }
    }
}

func (r *Replicator) GetReplicaCount() int {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return len(r.replicas)
}
```

---

### Junior → FAANG: Replication as an Availability-Consistency Tradeoff

Replication (copying writes from master to replicas) gives you redundancy: if the master fails, a replica can take over. But replication introduces a consistency window: writes are applied to the master first, then forwarded to replicas asynchronously. During the replication lag window, replicas may return stale data.

For interviews, state your replication strategy clearly: synchronous replication (master waits for at least one replica to acknowledge before returning success to the client) provides stronger durability at the cost of higher write latency. Asynchronous replication (master returns success immediately, replicas apply writes later) provides lower write latency at the cost of potential data loss on master failure.

Heartbeat monitoring (PING/PONG between master and replicas) is the failure detection mechanism. If a replica does not respond to a heartbeat within the configured timeout, the master removes it from the active replica set. This prevents the master from endlessly retrying writes to a dead replica.

### Senior @ FAANG: Replication as a Durability SLA

At senior level, replication is a durability SLA: "if the master fails, how much data can I lose?" With asynchronous replication, the answer is "up to the replication lag at the time of failure." The typical replication lag for a same-datacenter replica is under 10ms. For a cross-datacenter replica, it may be hundreds of milliseconds.

The replication factor (number of replicas) is a durability multiplier. With one replica, a single node failure causes no data loss (replication lag aside). With zero replicas, any single node failure loses all data on that node. At FAANG, most cache tiers run with at least one replica in a different availability zone.

Replica promotion during master failure (the failover process) must be atomic from the client's perspective. Clients should experience a brief unavailability (the failover duration, typically 1-30 seconds) but not silent data corruption (routing to a replica that is behind the master). The sentinel/coordinator's role is to ensure that only one replica is promoted, that the promoted replica is the most up-to-date, and that the new master's address is communicated to all clients before requests are resumed.

---
