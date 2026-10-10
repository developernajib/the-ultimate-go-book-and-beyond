// test/integration_test.go
package test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"gocache/client"
	"gocache/internal/server"
)

func setupTestServer(t *testing.T) (*server.Server, *client.Client) {
	srv := server.NewServer(":16379", 100*1024*1024)
	if err := srv.Start(); err != nil {
		t.Fatalf("Failed to start server: %v", err)
	}

	time.Sleep(100 * time.Millisecond) // Wait for server to start

	c := client.NewClient("localhost:16379", 10)

	t.Cleanup(func() {
		c.Close()
		srv.Stop()
	})

	return srv, c
}

func TestBasicOperations(t *testing.T) {
	_, c := setupTestServer(t)

	// Test SET
	err := c.Set("key1", []byte("value1"), nil)
	if err != nil {
		t.Fatalf("SET failed: %v", err)
	}

	// Test GET
	val, err := c.Get("key1")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}

	if string(val) != "value1" {
		t.Errorf("Expected 'value1', got '%s'", string(val))
	}

	// Test DEL
	deleted, err := c.Del("key1")
	if err != nil {
		t.Fatalf("DEL failed: %v", err)
	}

	if deleted != 1 {
		t.Errorf("Expected 1 deleted key, got %d", deleted)
	}

	// Test GET non-existent
	val, err = c.Get("key1")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}

	if val != nil {
		t.Errorf("Expected nil, got %v", val)
	}
}

func TestTTL(t *testing.T) {
	_, c := setupTestServer(t)

	ttl := 2 * time.Second
	err := c.Set("key_ttl", []byte("value"), &ttl)
	if err != nil {
		t.Fatalf("SET with TTL failed: %v", err)
	}

	// Check TTL
	remaining, err := c.TTL("key_ttl")
	if err != nil {
		t.Fatalf("TTL failed: %v", err)
	}

	if remaining < 1 || remaining > 2 {
		t.Errorf("Expected TTL between 1-2, got %d", remaining)
	}

	// Wait for expiration
	time.Sleep(3 * time.Second)

	val, err := c.Get("key_ttl")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}

	if val != nil {
		t.Errorf("Expected key to be expired, but got: %v", val)
	}
}

func TestLRUEviction(t *testing.T) {
	srv := server.NewServer(":16380", 1024) // 1KB max memory
	if err := srv.Start(); err != nil {
		t.Fatalf("Failed to start server: %v", err)
	}
	defer srv.Stop()

	time.Sleep(100 * time.Millisecond)

	c := client.NewClient("localhost:16380", 10)
	defer c.Close()

	// Fill beyond capacity
	for i := range 20 {
		key := fmt.Sprintf("key%d", i)
		value := make([]byte, 100) // 100 bytes each
		err := c.Set(key, value, nil)
		if err != nil {
			t.Fatalf("SET failed: %v", err)
		}
	}

	// First keys should be evicted
	val, err := c.Get("key0")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}

	if val != nil {
		t.Errorf("Expected key0 to be evicted")
	}

	// Recent keys should exist
	val, err = c.Get("key19")
	if err != nil {
		t.Fatalf("GET failed: %v", err)
	}

	if val == nil {
		t.Errorf("Expected key19 to exist")
	}
}

func TestConcurrency(t *testing.T) {
	_, c := setupTestServer(t)

	var wg sync.WaitGroup
	concurrency := 100

	for i := range concurrency {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			key := fmt.Sprintf("key%d", id)
			value := fmt.Appendf(nil, "value%d", id)

			// SET
			if err := c.Set(key, value, nil); err != nil {
				t.Errorf("SET failed: %v", err)
				return
			}

			// GET
			val, err := c.Get(key)
			if err != nil {
				t.Errorf("GET failed: %v", err)
				return
			}

			if string(val) != string(value) {
				t.Errorf("Expected %s, got %s", string(value), string(val))
			}
		}(i)
	}

	wg.Wait()
}
