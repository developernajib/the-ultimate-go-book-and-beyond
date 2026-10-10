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
	closed   bool
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
	if c.pool.closed {
		c.pool.mu.Unlock()
		return nil
	}
	c.pool.closed = true
	close(c.pool.conns)
	for conn := range c.pool.conns {
		if conn != nil {
			conn.Close()
		}
	}
	c.pool.mu.Unlock()

	return nil
}

// Connection Pool Methods

func (p *ConnectionPool) GetConn() (net.Conn, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, fmt.Errorf("connection pool is closed")
	}
	p.mu.Unlock()

	select {
	case conn, ok := <-p.conns:
		if !ok || conn == nil {
			return nil, fmt.Errorf("connection pool is closed")
		}
		return conn, nil
	default:
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, fmt.Errorf("connection pool is closed")
		}
		if p.active < p.maxConns {
			p.active++
			p.mu.Unlock()
			conn, err := net.Dial("tcp", p.addr)
			if err != nil {
				p.mu.Lock()
				p.active--
				p.mu.Unlock()
				return nil, err
			}
			return conn, nil
		}
		p.mu.Unlock()

		// Wait for available connection
		conn, ok := <-p.conns
		if !ok || conn == nil {
			return nil, fmt.Errorf("connection pool is closed")
		}
		return conn, nil
	}
}

func (p *ConnectionPool) PutConn(conn net.Conn) {
	if conn == nil {
		p.mu.Lock()
		p.active--
		p.mu.Unlock()
		return
	}

	p.mu.Lock()
	if p.closed {
		p.active--
		p.mu.Unlock()
		conn.Close()
		return
	}

	select {
	case p.conns <- conn:
		p.mu.Unlock()
	default:
		p.active--
		p.mu.Unlock()
		conn.Close()
	}
}
