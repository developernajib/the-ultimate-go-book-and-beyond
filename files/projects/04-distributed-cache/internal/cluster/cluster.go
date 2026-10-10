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

	cl := client.NewClient(addr, 10)

	node := &Node{
		ID:      id,
		Addr:    addr,
		Role:    "master",
		Healthy: true,
		Client:  cl,
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
