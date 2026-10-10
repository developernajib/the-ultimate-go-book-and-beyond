## 55.8 Load Testing: Don't Ship Without It

The rewritten e-commerce system tested with 1,000 users when Black Friday would bring 85,000. Load testing reveals your capacity ceiling before production traffic finds it for you. The runner below opens WebSocket connections with a configurable ramp-up period, sends messages at a specified rate per client, and collects latency percentiles. A failure rate above 1% causes the test to exit with a non-zero status code, making it suitable as a CI gate.

```go
// backend/internal/loadtest/runner.go
package loadtest

import (
    "context"
    "fmt"
    "log/slog"
    "sort"
    "strings"
    "sync"
    "sync/atomic"
    "time"

    "github.com/gorilla/websocket"
)

// Config defines load test parameters
type Config struct {
    TargetURL         string
    ConcurrentClients int
    Duration          time.Duration
    RampUpTime        time.Duration
    MessagesPerSecond int
}

// Result contains load test results
type Result struct {
    TotalConnections    int64
    SuccessfulConns     int64
    FailedConnections   int64
    MessagesSent        int64
    MessagesReceived    int64
    Errors              int64
    AvgLatencyMs        float64
    P50LatencyMs        float64
    P95LatencyMs        float64
    P99LatencyMs        float64
    MaxConcurrentConns  int64
    Duration            time.Duration
}

// Runner executes load tests
type Runner struct {
    config  Config
    logger  *slog.Logger
    results atomic.Value // stores *Result
    mu      sync.Mutex
    latencies []time.Duration
}

func NewRunner(config Config, logger *slog.Logger) *Runner {
    return &Runner{
        config:    config,
        logger:    logger,
        latencies: make([]time.Duration, 0, 10000),
    }
}

// Run executes the load test
func (r *Runner) Run(ctx context.Context) (*Result, error) {
    result := &Result{}
    var wg sync.WaitGroup
    var activeConns int64

    // Calculate ramp-up delay between each client
    clientDelay := r.config.RampUpTime / time.Duration(r.config.ConcurrentClients)

    r.logger.Info("starting load test",
        "clients", r.config.ConcurrentClients,
        "duration", r.config.Duration,
        "ramp_up", r.config.RampUpTime,
    )

    startTime := time.Now()
    testCtx, cancel := context.WithTimeout(ctx, r.config.Duration+r.config.RampUpTime)
    defer cancel()

    // Launch clients with ramp-up
    for i := 0; i < r.config.ConcurrentClients; i++ {
        wg.Add(1)
        go func(clientID int) {
            defer wg.Done()
            r.runClient(testCtx, clientID, result, &activeConns)
        }(i)

        // Update max concurrent connections
        current := atomic.LoadInt64(&activeConns)
        if current > atomic.LoadInt64(&result.MaxConcurrentConns) {
            atomic.StoreInt64(&result.MaxConcurrentConns, current)
        }

        // Ramp-up delay
        select {
        case <-testCtx.Done():
            break
        case <-time.After(clientDelay):
        }
    }

    wg.Wait()
    result.Duration = time.Since(startTime)

    // Calculate latency percentiles
    r.calculatePercentiles(result)

    return result, nil
}

func (r *Runner) runClient(ctx context.Context, id int, result *Result, activeConns *int64) {
    atomic.AddInt64(&result.TotalConnections, 1)

    // Connect
    conn, _, err := websocket.DefaultDialer.DialContext(ctx, r.config.TargetURL, nil)
    if err != nil {
        atomic.AddInt64(&result.FailedConnections, 1)
        return
    }
    defer conn.Close()

    atomic.AddInt64(&result.SuccessfulConns, 1)
    atomic.AddInt64(activeConns, 1)
    defer atomic.AddInt64(activeConns, -1)

    // Subscribe to a channel
    subscribeMsg := map[string]any{
        "type":      "subscribe",
        "channel":   fmt.Sprintf("metrics:client_%d", id%10),
        "timestamp": time.Now().Format(time.RFC3339),
    }
    if err := conn.WriteJSON(subscribeMsg); err != nil {
        atomic.AddInt64(&result.Errors, 1)
        return
    }

    // Start receiver goroutine
    receiveDone := make(chan struct{})
    go func() {
        defer close(receiveDone)
        for {
            _, _, err := conn.ReadMessage()
            if err != nil {
                return
            }
            atomic.AddInt64(&result.MessagesReceived, 1)
        }
    }()

    // Send messages at specified rate
    ticker := time.NewTicker(time.Second / time.Duration(r.config.MessagesPerSecond))
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-receiveDone:
            return
        case <-ticker.C:
            start := time.Now()
            pingMsg := map[string]any{
                "type":      "ping",
                "timestamp": time.Now().Format(time.RFC3339),
            }
            if err := conn.WriteJSON(pingMsg); err != nil {
                atomic.AddInt64(&result.Errors, 1)
                continue
            }
            atomic.AddInt64(&result.MessagesSent, 1)

            // Record latency (simplified - measures write time)
            latency := time.Since(start)
            r.recordLatency(latency)
        }
    }
}

func (r *Runner) recordLatency(d time.Duration) {
    r.mu.Lock()
    r.latencies = append(r.latencies, d)
    r.mu.Unlock()
}

func (r *Runner) calculatePercentiles(result *Result) {
    r.mu.Lock()
    defer r.mu.Unlock()

    if len(r.latencies) == 0 {
        return
    }

    // Sort latencies
    sorted := make([]time.Duration, len(r.latencies))
    copy(sorted, r.latencies)
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i] < sorted[j]
    })

    // Calculate percentiles
    n := len(sorted)
    result.P50LatencyMs = float64(sorted[n*50/100].Microseconds()) / 1000
    result.P95LatencyMs = float64(sorted[n*95/100].Microseconds()) / 1000
    result.P99LatencyMs = float64(sorted[n*99/100].Microseconds()) / 1000

    // Calculate average
    var total time.Duration
    for _, l := range sorted {
        total += l
    }
    result.AvgLatencyMs = float64(total.Microseconds()/int64(n)) / 1000
}

// PrintReport prints a formatted load test report
func (r *Runner) PrintReport(result *Result) {
    fmt.Println("\n" + strings.Repeat("=", 60))
    fmt.Println("                    LOAD TEST REPORT")
    fmt.Println(strings.Repeat("=", 60))
    fmt.Printf("Duration:               %v\n", result.Duration)
    fmt.Printf("Max Concurrent Conns:   %d\n", result.MaxConcurrentConns)
    fmt.Println(strings.Repeat("-", 60))
    fmt.Println("CONNECTIONS")
    fmt.Printf("  Total:                %d\n", result.TotalConnections)
    fmt.Printf("  Successful:           %d\n", result.SuccessfulConns)
    fmt.Printf("  Failed:               %d\n", result.FailedConnections)
    fmt.Println(strings.Repeat("-", 60))
    fmt.Println("MESSAGES")
    fmt.Printf("  Sent:                 %d\n", result.MessagesSent)
    fmt.Printf("  Received:             %d\n", result.MessagesReceived)
    fmt.Printf("  Errors:               %d\n", result.Errors)
    fmt.Println(strings.Repeat("-", 60))
    fmt.Println("LATENCY")
    fmt.Printf("  Average:              %.2f ms\n", result.AvgLatencyMs)
    fmt.Printf("  P50:                  %.2f ms\n", result.P50LatencyMs)
    fmt.Printf("  P95:                  %.2f ms\n", result.P95LatencyMs)
    fmt.Printf("  P99:                  %.2f ms\n", result.P99LatencyMs)
    fmt.Println(strings.Repeat("=", 60))
}
```

### Load Test Command

Running the load test before any production deployment confirms that the system actually meets its SLA under the projected peak load, not just under the optimistic synthetic conditions used during development. The `k6` command below targets the ingestion and WebSocket subscription endpoints simultaneously to simulate realistic mixed traffic, and the thresholds block turns the test into a pass/fail CI gate.

```go
// backend/cmd/loadtest/main.go
package main

import (
    "context"
    "flag"
    "log/slog"
    "os"
    "time"

    "dashboard/internal/loadtest"
)

func main() {
    var (
        url         = flag.String("url", "ws://localhost:8081/ws", "WebSocket URL")
        clients     = flag.Int("clients", 1000, "Number of concurrent clients")
        duration    = flag.Duration("duration", 5*time.Minute, "Test duration")
        rampUp      = flag.Duration("ramp-up", 30*time.Second, "Ramp-up time")
        msgPerSec   = flag.Int("msg-rate", 1, "Messages per second per client")
    )
    flag.Parse()

    logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    config := loadtest.Config{
        TargetURL:         *url,
        ConcurrentClients: *clients,
        Duration:          *duration,
        RampUpTime:        *rampUp,
        MessagesPerSecond: *msgPerSec,
    }

    runner := loadtest.NewRunner(config, logger)
    result, err := runner.Run(context.Background())
    if err != nil {
        logger.Error("load test failed", "error", err)
        os.Exit(1)
    }

    runner.PrintReport(result)

    // Exit with error if too many failures
    failureRate := float64(result.FailedConnections) / float64(result.TotalConnections)
    if failureRate > 0.01 { // More than 1% failures
        logger.Error("load test failed: too many connection failures",
            "failure_rate", failureRate,
        )
        os.Exit(1)
    }
}
```

---

### Junior -> FAANG: Load Testing Fundamentals That Interviewers Test

Load testing is one of the most undertested skills for early-career engineers, and one of the most reliably probed at FAANG. Three concepts come up constantly: the difference between load testing and stress testing, the correct way to interpret percentile latency, and how to set meaningful thresholds.

Load testing measures behavior at expected peak load. Stress testing pushes beyond peak to find the breaking point. The runner here does load testing with a configurable concurrent client count. A stress test would ramp the client count until the failure rate crosses a threshold, revealing the capacity ceiling.

For percentile latency: P99 latency of 50ms means 99% of requests complete within 50ms, and 1% take longer. That 1% is the tail, and the tail is what users experience during traffic spikes. An average latency of 5ms with a P99 of 2000ms is a bad system for users even though the average looks fine. Always report P50, P95, and P99 together.

For thresholds: the 1% failure rate gate in this runner is a reasonable starting point. At FAANG, thresholds are derived from SLOs. If the service has an SLO of 99.9% availability and 200ms P99 latency, the load test thresholds are: error rate below 0.1% and P99 below 200ms at peak load. If the load test passes these thresholds at 2x expected peak, you have a 2x safety margin. Knowing how to express this in a design interview is more important than knowing the specific tool.

First-job habit: run the load test before you open the pull request, not after. If you find a regression in load test results after your change, you want to investigate before code review, not during the incident that follows deployment.

### Senior @ FAANG: Load Testing as Organizational Infrastructure

The load test runner here is a good starting point for a single service. At FAANG, load testing is a platform, not a script.

**Baseline storage and regression detection:** A load test that runs once and prints a report provides a snapshot. A load test platform stores results in a time-series database (InfluxDB, TimescaleDB, or even Prometheus) and alerts when P99 latency regresses by more than a configured percentage compared to the last 10 runs. This catches gradual regressions (a slow dependency that gets slightly worse each week) that a single snapshot would miss. A staff engineer defines the regression policy: what percentage change triggers a block, how many consecutive regressions before a PR is automatically blocked, and who is responsible for reviewing and resetting the baseline after an intentional architecture change.

**Realistic traffic shape vs constant-rate load:** The runner here uses a constant message rate per client. Real traffic is bursty. FAANG load testing platforms use traffic replay (capturing production traffic patterns and replaying them at N times scale) or statistical traffic models (Poisson-distributed arrivals with measured inter-arrival times). The difference between constant-rate and realistic traffic can be a factor of 2-3x in P99 latency because constant-rate tests hide queueing theory effects (multiple simultaneous arrivals at a single-server queue cause disproportionate tail latency).

**Canary vs full load test:** Not every deployment needs a full load test at peak capacity. A canary strategy runs the new version with 1-5% of production traffic and compares latency and error rate to the baseline using statistical tests (Mann-Whitney U or KS-test, not just mean comparison). If the canary passes, the deployment proceeds. Full load tests run weekly against a staging environment to catch regressions that canary traffic volume would not reveal. A staff engineer designs this two-level testing strategy, not just the tool for one level.

**k6 vs custom runner for FAANG:** The custom Go runner in this chapter is useful for learning but does not replace k6 or Gatling in production. k6 provides built-in HTML reports, InfluxDB/Prometheus integration, distributed execution across multiple injectors (for tests above ~10k virtual users), and a large ecosystem of extensions. The organizational decision between k6, Gatling, and Locust is an ADR, not a preference. It depends on team language expertise, integration with existing CI tooling, cost (k6 Cloud vs self-hosted), and whether distributed execution is needed. A staff engineer makes this decision once for the organization and provides a standard project template so that teams do not each reinvent their own load testing setup.
