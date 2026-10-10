## Part 7: Cluster Mode

### Cluster Coordinator

The cluster coordinator ties together the hash ring and the client library to create a unified interface for working with multiple cache nodes. When you call `Set` or `Get` on the cluster, it uses the consistent hash ring to determine which node owns that key, then delegates the operation to that node's client. The coordinator also runs a background health checker that periodically pings each node. If a node becomes unresponsive, it is automatically removed from the hash ring so that its keys are redistributed to healthy nodes. When the node recovers, it is added back to the ring.

```go
// internal/cluster/cluster.go
package cluster

import (
    "context"
    "fmt"
    "sync"
    "time"

    "gocache/client"
)

type Node struct {
    ID      string
    Addr    string
    Role    string // "master" or "replica"
    Healthy bool
    Client  *client.Client
}

type Cluster struct {
    mu       sync.RWMutex
    nodes    map[string]*Node
    hashRing *HashRing
    ctx      context.Context
    cancel   context.CancelFunc
}

func NewCluster() *Cluster {
    ctx, cancel := context.WithCancel(context.Background())

    c := &Cluster{
        nodes:    make(map[string]*Node),
        hashRing: NewHashRing(150),
        ctx:      ctx,
        cancel:   cancel,
    }

    // Start health checker
    go c.healthChecker()

    return c
}

func (c *Cluster) AddNode(id, addr string) error {
    c.mu.Lock()
    defer c.mu.Unlock()

    client := client.NewClient(addr, 10)

    node := &Node{
        ID:      id,
        Addr:    addr,
        Role:    "master",
        Healthy: true,
        Client:  client,
    }

    c.nodes[id] = node
    c.hashRing.AddNode(id)

    return nil
}

func (c *Cluster) RemoveNode(id string) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if node, exists := c.nodes[id]; exists {
        node.Client.Close()
        delete(c.nodes, id)
        c.hashRing.RemoveNode(id)
    }
}

func (c *Cluster) GetNode(key string) (*Node, error) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    nodeID, exists := c.hashRing.GetNode(key)
    if !exists {
        return nil, fmt.Errorf("no nodes available")
    }

    node, exists := c.nodes[nodeID]
    if !exists || !node.Healthy {
        return nil, fmt.Errorf("node not available")
    }

    return node, nil
}

func (c *Cluster) Get(key string) ([]byte, error) {
    node, err := c.GetNode(key)
    if err != nil {
        return nil, err
    }

    return node.Client.Get(key)
}

func (c *Cluster) Set(key string, value []byte, ttl *time.Duration) error {
    node, err := c.GetNode(key)
    if err != nil {
        return err
    }

    return node.Client.Set(key, value, ttl)
}

func (c *Cluster) Del(key string) error {
    node, err := c.GetNode(key)
    if err != nil {
        return err
    }

    _, err = node.Client.Del(key)
    return err
}

func (c *Cluster) healthChecker() {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-c.ctx.Done():
            return
        case <-ticker.C:
            c.checkHealth()
        }
    }
}

func (c *Cluster) checkHealth() {
    c.mu.Lock()
    defer c.mu.Unlock()

    for id, node := range c.nodes {
        // Try to ping the node
        _, err := node.Client.Get("__health_check__")

        wasHealthy := node.Healthy
        node.Healthy = (err == nil)

        if wasHealthy && !node.Healthy {
            fmt.Printf("Node %s is now unhealthy\n", id)
            c.hashRing.RemoveNode(id)
        } else if !wasHealthy && node.Healthy {
            fmt.Printf("Node %s is now healthy\n", id)
            c.hashRing.AddNode(id)
        }
    }
}

func (c *Cluster) Stop() {
    c.cancel()

    c.mu.Lock()
    defer c.mu.Unlock()

    for _, node := range c.nodes {
        node.Client.Close()
    }
}
```

---

### Junior → FAANG: Cluster Coordinator as the Distributed System Brain

The cluster coordinator is the component that makes GoCache a distributed system rather than a collection of independent single-node caches. It combines two capabilities: key routing (consistent hashing to determine which node owns a key) and health monitoring (removing failed nodes from the ring).

For interviews, explain the node removal scenario: a node fails health check, is removed from the hash ring, and its portion of the key space is remapped to adjacent nodes. Clients continue operating without errors (they receive cache misses for the remapped keys until they are repopulated). This is the availability-over-consistency tradeoff at work: the cluster prefers to serve cache misses (and fall back to the source of truth) rather than block requests waiting for the failed node to recover.

Node rebalancing on recovery (adding a recovered node back to the ring) requires the application to gradually shift keys back. If you add the node back immediately, there is a brief period where the cluster has two nodes "owning" the same key range (the recovered node with stale data and the current node with fresh data). The mitigation is to warm the recovered node before re-adding it to the ring.

### Senior @ FAANG: Cluster Management as an Operational Discipline

At senior level, cluster management is an operational discipline, not just a code problem. Automated node removal (when health checks fail) and re-addition (when health checks pass) must be governed by tunable thresholds: how many consecutive health check failures before removal, how long must a node be healthy before re-addition? Aggressive settings reduce false positives but increase recovery time. Conservative settings reduce false negatives but may transiently remove healthy nodes.

Topology change propagation (ensuring all cluster coordinators agree on the current set of live nodes) is the hardest cluster management problem. If two coordinators disagree on cluster membership, they may route the same key to different nodes, causing inconsistent reads. The solution is a strongly consistent configuration store (etcd, ZooKeeper, or Consul) that all coordinators read from. The ADR for cluster membership management must choose between a strongly consistent store (correct but adds a dependency) and a gossip protocol (eventually consistent, no single point of failure, but allows brief disagreement).

Multi-tenancy at the cluster level (multiple applications sharing the same GoCache cluster) requires key namespacing (prefixing all keys with a tenant identifier), per-tenant memory limits, and per-tenant rate limiting. Without these, one high-traffic tenant can evict other tenants' keys and consume all available memory. Building multi-tenancy into the cluster coordinator from the start is significantly easier than retrofitting it.

---
