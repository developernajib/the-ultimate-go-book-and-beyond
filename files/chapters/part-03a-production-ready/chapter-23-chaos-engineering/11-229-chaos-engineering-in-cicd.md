## 23.9 Chaos Engineering in CI/CD

Running chaos experiments manually is a good starting point, but the real value comes when you automate them so they run without anyone remembering to. The key technique is to use a Go build tag (`//go:build chaos`) so chaos tests only run when explicitly enabled, keeping them out of normal development builds.

Be clear-eyed about what this buys you, because the pitch usually oversells it. Chaos suites need real infrastructure and real time, which is why they run on a nightly schedule rather than on every pull request. A nightly run does not validate every code change, and it does not catch a regression at merge time. It catches it the next morning, against whatever landed in the last 24 hours, which means the bisect is yours to do. That is still an enormous improvement over discovering the same regression during an incident, but it is a different promise, and teams that believe the stronger version stop reviewing fallback logic on the grounds that CI has it covered.

If you want resilience checked at merge time, that is what the deterministic tests in 23.8 are for. They are fast, they need no infrastructure, and they belong in the normal PR suite. The nightly chaos suite is the layer underneath, exercising the parts a unit test cannot reach.

### Automated Chaos Tests

The build tag keeps these files out of every ordinary `go build` and `go test` invocation. One `//go:build` line is enough. The paired `// +build` line has been unnecessary since Go 1.17, and while `gofmt` will leave it alone if you write it, there is no reason to carry it in new code.

Notice that each experiment is fully specified. It is tempting to write `// ...` where the `SteadyState`, `Inject`, and `Cleanup` fields go and get on with the interesting part of the example, but those fields *are* the interesting part: they are the hypothesis, the fault, and the abort machinery. The runner from 23.5 rejects an experiment that omits them, and rightly so. An elided `Cleanup` in a nightly job means a fault that outlives the test run.

```go
// chaos_ci_test.go
//go:build chaos

package chaos_test

import (
    "context"
    "log/slog"
    "os"
    "testing"
    "time"

    "myapp/chaos"
)

func TestChaosInCI(t *testing.T) {
    target := requireEnv(t, "CHAOS_TARGET_URL")
    prom := requireEnv(t, "CHAOS_PROMETHEUS_URL")

    runner := chaos.NewChaosRunner(slog.Default())
    checker := chaos.NewSteadyStateChecker(prom)
    inj := chaos.NewRemoteInjector(target) // Drives the target's fault endpoint.

    // One hypothesis, shared by both experiments. The runner polls it while
    // each fault is live, and aborts the moment it stops holding.
    steady := checker.Hypothesis(0.01, 500*time.Millisecond, 50)

    experiments := []chaos.Experiment{
        {
            Name:          "api-latency",
            Description:   "300ms added to every inbound request",
            Hypothesis:    "Under 1% 5xx and p99 under 500ms, breakers absorb the delay",
            Duration:      30 * time.Second,
            ProbeInterval: 5 * time.Second,
            SteadyState:   steady,
            Inject: func(ctx context.Context) error {
                return inj.Store(ctx, chaos.FaultConfig{
                    Enabled: true,
                    Latency: 300 * time.Millisecond,
                })
            },
            Cleanup: func(ctx context.Context) error { return inj.Disable(ctx) },
        },
        {
            Name:          "partial-db-failure",
            Description:   "20% of database queries fail",
            Hypothesis:    "Read paths serve from cache, write paths shed cleanly",
            Duration:      60 * time.Second,
            ProbeInterval: 5 * time.Second,
            SteadyState:   steady,
            Inject: func(ctx context.Context) error {
                return inj.StoreDB(ctx, chaos.DBFaultConfig{
                    Enabled:   true,
                    ErrorRate: 0.2,
                })
            },
            Cleanup: func(ctx context.Context) error { return inj.DisableDB(ctx) },
        },
    }

    for _, exp := range experiments {
        t.Run(exp.Name, func(t *testing.T) {
            // Bound the whole thing. A runner that hangs should fail the job,
            // not sit there until the workflow-level timeout kills it.
            ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
            defer cancel()

            res := runner.Run(ctx, exp)

            // The outcomes mean different things and deserve different reports.
            switch res.Outcome {
            case chaos.OutcomeHeld:
                t.Logf("hypothesis held across %d probes", res.Probes)
            case chaos.OutcomeAborted:
                t.Errorf("ABORTED, steady state lost under fault: %v", res.Error)
            case chaos.OutcomeBroke:
                t.Errorf("system did not recover after cleanup: %v", res.Error)
            case chaos.OutcomeSkipped:
                // Nothing was injected, so nothing was learned. Failing the
                // job is right: a suite that silently skips is a suite that
                // reports green forever.
                t.Fatalf("experiment never ran: %v", res.Error)
            case chaos.OutcomeInvalid:
                t.Fatalf("experiment is missing safety machinery: %v", res.Error)
            }
        })
    }
}

func requireEnv(t *testing.T, key string) string {
    t.Helper()
    v := os.Getenv(key)
    if v == "" {
        t.Fatalf("%s must be set to run chaos tests", key)
    }
    return v
}
```

The `OutcomeSkipped` branch is worth pausing on. The original instinct is to `t.Skip` when the environment is not configured, which feels tidy and is a trap: a chaos job whose target URL is unset skips every experiment, reports success, and stays green through the entire quarter in which nobody notices it stopped running. A test that cannot run is not a test that passed. Fail loudly and fix the environment.

### GitHub Action for Chaos

```yaml
name: Chaos Tests

on:
  schedule:
    - cron: '0 3 * * *'  # Daily at 03:00 UTC
  workflow_dispatch:     # And on demand, for debugging a finding.

# A chaos run that overlaps its predecessor injects two faults at once and
# invalidates both results.
concurrency:
  group: chaos
  cancel-in-progress: false

jobs:
  chaos:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      # Compose V1 is gone from the ubuntu-24.04 runners that ubuntu-latest
      # now resolves to. It is `docker compose`, not `docker-compose`.
      - name: Start services
        run: docker compose up -d --wait --wait-timeout 120

      - name: Run chaos experiments
        env:
          CHAOS_TARGET_URL: http://localhost:8080
          CHAOS_PROMETHEUS_URL: http://localhost:9090
        run: go test -tags=chaos -v -timeout=25m ./chaos/...

      - name: Collect logs on failure
        if: failure()
        run: docker compose logs --no-color > chaos-logs.txt

      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: chaos-logs
          path: chaos-logs.txt

      # always(), not failure(). A cancelled or timed-out run leaves
      # containers behind exactly when you least want stray state.
      - name: Tear down
        if: always()
        run: docker compose down -v
```

Four things changed from the version most people write first, and each one is a real failure rather than a style preference.

`docker-compose` with a hyphen is Compose V1, which GitHub removed from its Ubuntu images in 2024. `ubuntu-latest` now resolves to ubuntu-24.04, where the command does not exist, so the workflow fails at the first step with `command not found`. Compose V2 is a plugin, invoked as `docker compose`.

`actions/setup-go` is not optional even though the runners ship a Go toolchain, because that toolchain is whatever the image happens to carry and it moves without telling you. Pinning to `go-version-file: go.mod` means the chaos job compiles against the same version as everything else.

`sleep 30` is a guess that is simultaneously too long on a good day and too short on a bad one, and when it is too short the suite fails against a service that was merely still booting, which reads as a resilience finding and is not. `--wait` blocks until the containers report healthy, which requires that your compose file declares `healthcheck` blocks. Declare them.

The teardown runs on `always()`. `failure()` skips it when the job is cancelled or hits its timeout, which are precisely the runs most likely to have left a fault injected and containers holding ports.

### Staff Lens: CI Chaos Catches Regressions

Chaos tests in CI catch resilience regressions before the next real outage does. Without them, a change that breaks fallback logic ships and only surfaces when the fallback is finally needed, which is the worst possible moment to discover it never worked. Nightly chaos is unglamorous but most productive.

The failure mode to watch for is not the suite going red. It is the suite going green for the wrong reason. A chaos job that skips because an env var is unset, aborts because Prometheus is down, or passes because its verification returns `nil` unconditionally all look identical on the dashboard, and all of them report resilience you do not have. Audit the suite periodically by breaking something on purpose and confirming it goes red. If it does not, the suite has been decorative for longer than you think.

---
