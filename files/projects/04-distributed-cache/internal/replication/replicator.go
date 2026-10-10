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
