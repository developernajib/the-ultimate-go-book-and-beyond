## Part 10: Testing

### Integration Tests

Integration tests verify that the entire system works correctly end-to-end, from the client library through the RESP protocol to the server and back. Unlike unit tests that test individual functions in isolation, these tests start a real GoCache server on a test port, connect a real client, and execute actual cache operations. The tests cover basic CRUD operations, TTL expiration behavior, LRU eviction under memory pressure, and concurrent access from multiple goroutines. Each test uses `t.Cleanup` to ensure the server and client are properly shut down after the test finishes.

```go
// test/integration_test.go
package test

import (
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
    for i := 0; i < 20; i++ {
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

    for i := 0; i < concurrency; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()

            key := fmt.Sprintf("key%d", id)
            value := []byte(fmt.Sprintf("value%d", id))

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
```

---

### Junior → FAANG: Integration Tests for a Protocol Server

Testing a TCP/RESP server requires starting a real server instance (not a mock), connecting a real client, sending actual commands, and verifying the responses. This integration test pattern is more realistic than mocking because it exercises the parser, the command handler, the LRU store, and the network path simultaneously.

The `t.Cleanup` pattern (registering cleanup functions that run after the test regardless of pass/fail) is the correct Go idiom for test resource cleanup. It ensures the test server is shut down even when a test assertion fails, preventing port conflicts in subsequent test runs.

Concurrent access tests (multiple goroutines simultaneously reading and writing the same keys) are the highest-value tests for a cache implementation. Run them with `-race` to detect data races. A cache that passes concurrent access tests with the race detector enabled has no data races by construction.

### Senior @ FAANG: Test Strategy for a Distributed Protocol Server

At senior level, the test strategy for GoCache must cover correctness properties that do not appear in happy-path tests: eviction order (verify that the LRU order is maintained correctly under concurrent access), TTL accuracy (verify that keys expire within 10ms of their configured TTL, not after a full background scan interval), and replication consistency (verify that after a write to the master, the replica reflects the new value within the expected lag window).

Fault injection testing (stopping a replica mid-replication, sending malformed RESP, closing connections mid-command) verifies the error handling paths. A server that panics or produces a corrupted response on a malformed command is a security vulnerability (attackers can crash the cache by sending bad data). Every error path should be exercised by a test.

Chaos testing for the cluster mode (randomly removing nodes and verifying that the cluster continues serving requests with cache misses on the affected key range) is the highest-confidence test for cluster resilience. This test requires a real multi-node cluster (Docker or network namespaces), not a single-process mock cluster.

---
