// test/integration/gateway_test.go
package integration

import (
    "io"
    "net/http"
    "net/http/httptest"
    "net/url"
    "strconv"
    "testing"
    "time"

    "github.com/example/api-gateway/internal/gateway"
    "github.com/example/api-gateway/internal/observability"
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

func getPort(rawURL string) int {
    u, err := url.Parse(rawURL)
    if err != nil {
        return 0
    }
    port, err := strconv.Atoi(u.Port())
    if err != nil {
        return 0
    }
    return port
}
