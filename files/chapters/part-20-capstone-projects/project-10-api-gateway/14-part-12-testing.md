## Part 12: Testing

Testing an API gateway requires multiple levels of verification. Unit tests check individual components like the trie router, plugin chain, and load balancer algorithms in isolation. Integration tests spin up a real gateway instance and send HTTP requests through it to verify that routing, plugin execution, and proxying work correctly end-to-end. We also include benchmark tests to measure the performance overhead of routing and plugin processing, since even small latencies add up when the gateway handles thousands of requests per second.

### Unit Tests
The unit tests exercise the trie router, plugin chain, and load balancer algorithms in isolation. Each test constructs the component under test with known inputs and asserts the expected outputs.

```go
// internal/router/trie_test.go
package router

import (
    "testing"
)

func TestTrie(t *testing.T) {
    trie := NewTrie()

    // Test routes
    routes := map[string]*Route{
        "/api/users":        {ID: "route1"},
        "/api/users/:id":    {ID: "route2"},
        "/api/posts/*":      {ID: "route3"},
        "/api/v1/products":  {ID: "route4"},
    }

    // Insert routes
    for path, route := range routes {
        trie.Insert(path, route)
    }

    // Test exact match
    route, params := trie.Search("/api/users")
    if route == nil || route.ID != "route1" {
        t.Errorf("Expected route1, got %v", route)
    }

    // Test parameter match
    route, params = trie.Search("/api/users/123")
    if route == nil || route.ID != "route2" {
        t.Errorf("Expected route2, got %v", route)
    }
    if params["id"] != "123" {
        t.Errorf("Expected param id=123, got %v", params)
    }

    // Test wildcard match
    route, params = trie.Search("/api/posts/anything/here")
    if route == nil || route.ID != "route3" {
        t.Errorf("Expected route3, got %v", route)
    }

    // Test no match
    route, params = trie.Search("/api/nonexistent")
    if route != nil {
        t.Errorf("Expected no match, got %v", route)
    }

    // Test delete
    deleted := trie.Delete("/api/users/:id")
    if !deleted {
        t.Error("Expected successful deletion")
    }

    route, params = trie.Search("/api/users/123")
    if route != nil {
        t.Error("Expected no match after deletion")
    }
}
```

```go
// internal/upstream/loadbalancer_test.go
package upstream

import (
    "context"
    "testing"
)

func TestRoundRobinBalancer(t *testing.T) {
    targets := []*Target{
        {ID: "t1", Host: "host1", Port: 8080, Weight: 100},
        {ID: "t2", Host: "host2", Port: 8080, Weight: 100},
        {ID: "t3", Host: "host3", Port: 8080, Weight: 100},
    }

    // Wrap targets with health status
    for _, target := range targets {
        target.Metadata = map[string]string{"healthy": "true"}
    }

    lb := NewRoundRobinBalancer()
    ctx := context.Background()

    // Test round-robin distribution
    selected := make(map[string]int)
    for i := 0; i < 9; i++ {
        target, err := lb.Select(ctx, targets)
        if err != nil {
            t.Fatal(err)
        }
        selected[target.ID]++
    }

    // Each target should be selected 3 times
    for id, count := range selected {
        if count != 3 {
            t.Errorf("Target %s selected %d times, expected 3", id, count)
        }
    }
}

func TestWeightedRandomBalancer(t *testing.T) {
    targets := []*Target{
        {ID: "t1", Host: "host1", Port: 8080, Weight: 50},
        {ID: "t2", Host: "host2", Port: 8080, Weight: 30},
        {ID: "t3", Host: "host3", Port: 8080, Weight: 20},
    }

    for _, target := range targets {
        target.Metadata = map[string]string{"healthy": "true"}
    }

    lb := NewWeightedRandomBalancer()
    ctx := context.Background()

    // Test weighted distribution
    selected := make(map[string]int)
    iterations := 10000

    for i := 0; i < iterations; i++ {
        target, err := lb.Select(ctx, targets)
        if err != nil {
            t.Fatal(err)
        }
        selected[target.ID]++
    }

    // Check approximate distribution
    t1Percent := float64(selected["t1"]) / float64(iterations)
    t2Percent := float64(selected["t2"]) / float64(iterations)
    t3Percent := float64(selected["t3"]) / float64(iterations)

    if t1Percent < 0.45 || t1Percent > 0.55 {
        t.Errorf("t1 selected %.2f%%, expected ~50%%", t1Percent*100)
    }
    if t2Percent < 0.25 || t2Percent > 0.35 {
        t.Errorf("t2 selected %.2f%%, expected ~30%%", t2Percent*100)
    }
    if t3Percent < 0.15 || t3Percent > 0.25 {
        t.Errorf("t3 selected %.2f%%, expected ~20%%", t3Percent*100)
    }
}
```

```go
// internal/plugin/chain_test.go
package plugin

import (
    "context"
    "net/http"
    "net/http/httptest"
    "testing"
)

type mockPlugin struct {
    name     string
    priority int
    called   *bool
}

func (p *mockPlugin) Name() string {
    return p.name
}

func (p *mockPlugin) Priority() int {
    return p.priority
}

func (p *mockPlugin) Init(config map[string]any) error {
    return nil
}

func (p *mockPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    *p.called = true
    return req, nil
}

func (p *mockPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func TestPluginChain(t *testing.T) {
    called1, called2, called3 := false, false, false

    plugins := []Plugin{
        &mockPlugin{name: "plugin2", priority: 200, called: &called2},
        &mockPlugin{name: "plugin1", priority: 100, called: &called1},
        &mockPlugin{name: "plugin3", priority: 300, called: &called3},
    }

    chain := NewChain(plugins)

    req := httptest.NewRequest("GET", "http://example.com", nil)
    ctx := context.Background()

    _, result := chain.ProcessRequest(ctx, req)
    if result.Error != nil {
        t.Fatal(result.Error)
    }

    // All plugins should be called
    if !called1 || !called2 || !called3 {
        t.Error("Not all plugins were called")
    }

    // Verify order by priority
    chainPlugins := chain.Plugins()
    if len(chainPlugins) != 3 {
        t.Fatalf("Expected 3 plugins, got %d", len(chainPlugins))
    }

    if chainPlugins[0].Priority() != 100 {
        t.Error("Plugins not sorted by priority")
    }
}
```

### Integration Tests

The integration tests start a real gateway instance, configure routes and plugins, send HTTP requests through the gateway, and verify that responses are proxied and transformed correctly.

```go
// test/integration/gateway_test.go
package integration

import (
    "io"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/yourusername/gatewaygo/internal/gateway"
    "github.com/yourusername/gatewaygo/internal/observability"
)

func TestGatewayProxying(t *testing.T) {
    // Create backend server
    backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("backend response"))
    }))
    defer backend.Close()

    // Create gateway config
    config := &gateway.Config{
        Server: gateway.ServerConfig{
            Host:         "localhost",
            Port:         8080,
            ReadTimeout:  30 * time.Second,
            WriteTimeout: 30 * time.Second,
        },
        Routes: []gateway.Route{
            {
                ID:         "test-route",
                Paths:      []string{"/test"},
                Methods:    []string{"GET"},
                UpstreamID: "test-upstream",
                Enabled:    true,
            },
        },
        Upstreams: []gateway.Upstream{
            {
                ID:              "test-upstream",
                LoadBalanceType: gateway.LoadBalanceRoundRobin,
                Targets: []gateway.Target{
                    {
                        ID:   "target1",
                        Host: "localhost",
                        Port: getPort(backend.URL),
                    },
                },
            },
        },
        Logging: gateway.LoggingConfig{
            Level:  "info",
            Format: "json",
            Output: "stdout",
        },
    }

    logger, _ := observability.NewLogger("info", "json", "stdout")
    server, err := gateway.NewServer(config, logger)
    if err != nil {
        t.Fatal(err)
    }

    // Create test request
    req := httptest.NewRequest("GET", "/test", nil)
    rr := httptest.NewRecorder()

    // Serve request
    server.ServeHTTP(rr, req)

    // Check response
    if rr.Code != http.StatusOK {
        t.Errorf("Expected status 200, got %d", rr.Code)
    }

    body, _ := io.ReadAll(rr.Body)
    if string(body) != "backend response" {
        t.Errorf("Expected 'backend response', got '%s'", string(body))
    }
}

func getPort(url string) int {
    // Extract port from URL
    return 8080 // Simplified for example
}
```
