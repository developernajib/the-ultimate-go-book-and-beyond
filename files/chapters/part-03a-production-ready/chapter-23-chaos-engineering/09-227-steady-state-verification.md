## 23.7 Steady State Verification

Before you can tell whether a chaos experiment caused harm, you need a precise definition of what "healthy" looks like. This is called the steady-state hypothesis: a set of quantitative metrics that describe normal system behavior, such as error rate below 1%, p99 latency below 500ms, and throughput above 1,000 requests per second. You check these metrics before the experiment to confirm the system is healthy, poll them during the experiment so a breach can abort it, and verify them after cleanup to confirm recovery.

This code is the abort condition from 23.5. That makes it the most safety-critical code in the chapter, and it deserves a level of paranoia that ordinary metrics code does not. Every failure mode below is one where the checker reports "healthy" while the system is not, and each one silently disarms the abort switch for every experiment that depends on it.

### Metrics-Based Verification

Each check issues a PromQL query against the Prometheus HTTP API and compares the returned scalar against a caller-supplied threshold. Using `histogram_quantile` for p99 latency matters because averages mask tail behavior: a service with an average latency of 100ms may still have a p99 of 2 seconds, which is what users actually experience at scale. Separating the error-rate, latency, and throughput checks into distinct methods lets an experiment declare exactly which SLI it is monitoring, rather than failing against an opaque composite score.

Four details in this implementation are not stylistic preferences. They are the difference between a working abort condition and a decorative one.

**Encode the query.** The obvious `fmt.Sprintf("%s/api/v1/query?query=%s", url, query)` looks harmless and is not. Real PromQL contains spaces, and a raw space in a request target produces a malformed HTTP request line. The server parses the text up to the first space as the URI and the rest as garbage, and answers `400 Bad Request` without ever routing the request. Point the naive version at a test server and the server records no query at all, while the client reports a JSON decode error because it is trying to unmarshal the string `400 Bad Request`. The check does not merely misbehave, it can never succeed. Use `url.Values.Encode`.

**Reject NaN explicitly.** This is the one that matters most. `histogram_quantile` over a window containing zero observations returns `NaN`. Prometheus sends it as the string `"NaN"`, and both `fmt.Sscanf("%f")` and `strconv.ParseFloat` parse it happily into a genuine NaN float, with no error. Then `NaN > threshold` evaluates to **false**, because every comparison against NaN is false. So the check returns `nil` and reports the steady state as healthy. Read that failure mode again in context: the histogram has no observations because the service has stopped serving traffic entirely, which is the single worst outcome a chaos experiment can produce, and the abort condition responds by saying everything is fine and letting the fault run to full duration. A silently discarded `Sscanf` error compounds it, since an empty or unparseable value leaves the result at the zero value, which also compares as healthy.

**Do not let a healthy service fail the probe.** `sum(rate(http_requests_total{status=~"5.."}[5m]))` over a service with zero 5xx does not return zero. The selector matches no series, `sum` over no series returns an empty vector, and dividing an empty vector by anything returns an empty vector. The code sees an empty `Result`, reports "no data from prometheus", and the framework treats that as steady state lost. A perfectly healthy service with no errors at all fails its own error-rate check, so every experiment is skipped or aborted and nobody learns anything. `or vector(0)` supplies the zero that the absence of errors means.

**Fail closed on everything else.** Check the HTTP status, check the `status` field in the response body (Prometheus reports query errors as `{"status":"error"}` alongside a 4xx, and the naive code turns a parse error into the misleading "no data from prometheus"), and bounds-check the sample array before indexing `Value[1]`, which panics on a malformed sample. A panic inside the abort condition takes down the process that was supposed to be ending the experiment.

```go
package chaos

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "io"
    "math"
    "net/http"
    "net/url"
    "strconv"
    "time"
)

type SteadyStateChecker struct {
    prometheusURL string
    httpClient    *http.Client

    // Window is the rate window. Keep it short. A [5m] window smooths the
    // signal over five minutes, so a 60-second experiment can destroy the
    // service and the probe will barely twitch before the run is over.
    // It must still span several scrape intervals, so 1m against a 15s
    // scrape is a reasonable floor.
    Window string
}

func NewSteadyStateChecker(prometheusURL string) *SteadyStateChecker {
    return &SteadyStateChecker{
        prometheusURL: prometheusURL,
        httpClient:    &http.Client{Timeout: 10 * time.Second},
        Window:        "1m",
    }
}

type promResponse struct {
    Status    string `json:"status"`
    ErrorType string `json:"errorType"`
    Error     string `json:"error"`
    Data      struct {
        ResultType string `json:"resultType"`
        Result     []struct {
            Value []json.RawMessage `json:"value"`
        } `json:"result"`
    } `json:"data"`
}

var ErrNoData = errors.New("chaos: prometheus returned no data")

func (s *SteadyStateChecker) query(ctx context.Context, q string) (float64, error) {
    // Encode. PromQL contains spaces, and a raw space in the request target
    // produces a request line the server rejects before routing it.
    u := s.prometheusURL + "/api/v1/query?" + url.Values{"query": {q}}.Encode()

    req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
    if err != nil {
        return 0, fmt.Errorf("chaos: building prometheus request: %w", err)
    }

    resp, err := s.httpClient.Do(req)
    if err != nil {
        return 0, fmt.Errorf("chaos: querying prometheus: %w", err)
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
    if err != nil {
        return 0, fmt.Errorf("chaos: reading prometheus response: %w", err)
    }

    var pr promResponse
    if err := json.Unmarshal(body, &pr); err != nil {
        return 0, fmt.Errorf("chaos: prometheus returned HTTP %d with unparseable body %q: %w",
            resp.StatusCode, truncate(body), err)
    }
    if pr.Status != "success" {
        // Prometheus reports query errors in the body. Surface the real
        // reason instead of flattening it into "no data".
        return 0, fmt.Errorf("chaos: prometheus rejected query (HTTP %d, %s): %s",
            resp.StatusCode, pr.ErrorType, pr.Error)
    }
    if resp.StatusCode != http.StatusOK {
        return 0, fmt.Errorf("chaos: prometheus HTTP %d", resp.StatusCode)
    }
    if len(pr.Data.Result) == 0 {
        return 0, fmt.Errorf("%w for query %q", ErrNoData, q)
    }

    v := pr.Data.Result[0].Value
    if len(v) < 2 {
        return 0, fmt.Errorf("chaos: malformed prometheus sample %v", v)
    }

    var valueStr string
    if err := json.Unmarshal(v[1], &valueStr); err != nil {
        return 0, fmt.Errorf("chaos: prometheus sample value was not a string: %s", v[1])
    }

    value, err := strconv.ParseFloat(valueStr, 64)
    if err != nil {
        return 0, fmt.Errorf("chaos: cannot parse prometheus value %q: %w", valueStr, err)
    }

    // NaN parses without error and then loses every comparison, so an
    // unchecked NaN reads as "under threshold" and reports a dead service
    // as healthy. Refuse it.
    if math.IsNaN(value) {
        return 0, fmt.Errorf(
            "chaos: query %q returned NaN, which usually means no observations in the "+
                "window: treat this as steady state LOST, not as healthy", q)
    }
    if math.IsInf(value, 0) {
        return 0, fmt.Errorf("chaos: query %q returned %v", q, value)
    }

    return value, nil
}

func truncate(b []byte) string {
    if len(b) > 120 {
        return string(b[:120]) + "..."
    }
    return string(b)
}

func (s *SteadyStateChecker) CheckErrorRate(ctx context.Context, threshold float64) error {
    // `or vector(0)` supplies the zero that "no 5xx series exist" means.
    // Without it a service with no errors returns an empty vector and fails
    // its own health check.
    q := fmt.Sprintf(
        `(sum(rate(http_requests_total{status=~"5.."}[%s])) or vector(0)) `+
            `/ sum(rate(http_requests_total[%s]))`,
        s.Window, s.Window)

    value, err := s.query(ctx, q)
    if err != nil {
        return err
    }
    if value > threshold {
        return fmt.Errorf("error rate %.2f%% exceeds threshold %.2f%%", value*100, threshold*100)
    }
    return nil
}

func (s *SteadyStateChecker) CheckLatencyP99(ctx context.Context, threshold time.Duration) error {
    q := fmt.Sprintf(
        `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[%s])) by (le))`,
        s.Window)

    value, err := s.query(ctx, q)
    if err != nil {
        return err
    }
    got := time.Duration(value * float64(time.Second))
    if got > threshold {
        return fmt.Errorf("p99 latency %v exceeds threshold %v",
            got.Round(time.Millisecond), threshold)
    }
    return nil
}

// CheckThroughput catches the failure the other two miss. If the service is
// serving nothing at all, its error rate is vacuously fine and its latency
// histogram is empty. Only a traffic floor notices that the lights are off.
func (s *SteadyStateChecker) CheckThroughput(ctx context.Context, min float64) error {
    q := fmt.Sprintf(`sum(rate(http_requests_total[%s])) or vector(0)`, s.Window)

    value, err := s.query(ctx, q)
    if err != nil {
        return err
    }
    if value < min {
        return fmt.Errorf("throughput %.1f req/s below floor %.1f req/s", value, min)
    }
    return nil
}

// Hypothesis composes the three SLIs into the func the ChaosRunner polls.
// errors.Join reports every breach rather than only the first, which is what
// you want in the log line that explains why a run aborted.
func (s *SteadyStateChecker) Hypothesis(
    errorRate float64, p99 time.Duration, minRPS float64,
) func(context.Context) error {
    return func(ctx context.Context) error {
        return errors.Join(
            s.CheckThroughput(ctx, minRPS),
            s.CheckErrorRate(ctx, errorRate),
            s.CheckLatencyP99(ctx, p99),
        )
    }
}
```

Wire it into an experiment as the `SteadyState` field and the framework does the rest:

```go
checker := chaos.NewSteadyStateChecker("http://prometheus:9090")

exp := chaos.Experiment{
    Name:          "cache-eviction",
    Hypothesis:    "Under 1% 5xx, p99 under 500ms, at least 800 req/s served",
    Duration:      5 * time.Minute,
    ProbeInterval: 10 * time.Second,
    SteadyState:   checker.Hypothesis(0.01, 500*time.Millisecond, 800),
    // ... Inject, Verify, Cleanup
}
```

### Testing the Abort Condition

Point the checker at an `httptest.Server` that returns canned Prometheus payloads. The tests are cheap and they cover exactly the cases that turn the abort switch off:

```go
func TestNaNIsSteadyStateLost(t *testing.T) {
    c := checkerReturning(t, `"NaN"`) // No observations in the window.
    if err := c.CheckLatencyP99(context.Background(), 500*time.Millisecond); err == nil {
        t.Fatal("NaN reported as healthy: the abort condition can never fire")
    }
}

func TestZeroErrorsIsHealthy(t *testing.T) {
    c := checkerReturning(t, `"0"`)
    if err := c.CheckErrorRate(context.Background(), 0.01); err != nil {
        t.Fatalf("a service with zero 5xx must pass its own check, got: %v", err)
    }
}
```

Add one that asserts the server actually received the query string with its spaces and braces intact, one that feeds back a `{"status":"error"}` body and asserts the real Prometheus message survives into the returned error, and one that returns a two-element-short sample and asserts an error rather than a panic.

### Staff Lens: Steady State Must Be Pre-Defined

The hypothesis must exist before the experiment. "See what happens" is not a chaos experiment. It is playing with fire. Define expected behavior as metrics and thresholds first, then inject faults, then verify.

The corollary is that the hypothesis must be *falsifiable*, and code decides that, not intent. Every defect fixed above produced a check that could not fail when it mattered: NaN comparing false, an empty vector misread, a discarded parse error leaving a zero behind. Each one leaves you with a green dashboard, a passing experiment, and no resilience. When a probe reports healthy, ask what it would have to see to report otherwise, and then write the test that shows it does.

---
