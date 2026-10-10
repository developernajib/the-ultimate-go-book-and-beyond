## 25.5 Testing Tools

### Coverage

Coverage profiles record which source lines were executed during a test run. The `-coverpkg=./...` flag extends coverage measurement to all packages in the module, not just those with test files, giving an accurate view of how much production code is covered. The HTML report from `go tool cover -html` visually highlights uncovered lines, making it easy to identify gaps in test coverage.

```bash
# Generate coverage profile
go test -coverprofile=coverage.out ./...

# HTML report
go tool cover -html=coverage.out -o coverage.html

# Function coverage
go tool cover -func=coverage.out

# Coverage by package
go test -cover ./... | grep -v "no test files"

# Coverage with multiple packages
go test -coverprofile=coverage.out -coverpkg=./... ./...
```

### Race Detector

The race detector instruments memory accesses at compile time and reports concurrent reads and writes to shared variables without synchronization. Cost depends heavily on how much memory traffic the workload does: budget 2-20x CPU and 5-10x memory, with lock-heavy code sitting near the top of that range (a contended-counter benchmark measures about 10x). That is fine in CI and prohibitive in production. The `GORACE` environment variable configures behavior: `halt_on_error=1` causes the program to crash on first race detection rather than continuing and logging all races.

The property that matters most is what the race detector does *not* do. It is a dynamic analysis, not a proof. It reports only races it actually observes at runtime, on the interleavings your tests happen to execute. A clean `-race` run means the races you exercised did not happen this time, not that the code is race-free, and a race that needs a specific timing window can pass a thousand runs and fail in production. This is why `-race` belongs on tests that genuinely exercise concurrency, why it pairs with `-count` to vary scheduling, and why it is worth running against realistic load rather than a single-goroutine unit test that can never trip it.

```bash
# Run tests with race detector
go test -race ./...

# Build with race detector
go build -race

# Set race detector options
GORACE="log_path=race.log halt_on_error=1" go test -race ./...
```

### Benchmarks

Go benchmarks use `testing.B` and measure wall-clock time per operation. Running with `-benchmem` adds per-operation allocation counts and bytes, which is often more actionable than raw timing. The `benchstat` tool performs statistical comparison of two benchmark runs, showing percentage changes and p-values so you can confidently distinguish real performance changes from noise.

```bash
# Run benchmarks
go test -bench=. ./...

# With memory allocation stats
go test -bench=. -benchmem ./...

# Multiple iterations for stability
go test -bench=. -count=5 ./...

# Save results for comparison
go test -bench=. -count=10 > old.txt
# Make changes
go test -bench=. -count=10 > new.txt

# Compare with benchstat
go install golang.org/x/perf/cmd/benchstat@latest
benchstat old.txt new.txt
```

### Fuzzing

Go's built-in fuzzer, available since Go 1.18 and refined through Go 1.26, generates random inputs to find panics, incorrect behavior, and boundary conditions. The fuzzer maintains a corpus of interesting inputs that it mutates. Seed inputs can be provided in `testdata/fuzz/<FuncName>/` to guide initial exploration. Setting `-fuzztime` prevents unbounded CI runs while still providing meaningful coverage expansion during each run. Failing inputs are auto-saved to `testdata/fuzz/` and must be committed so regressions surface as normal unit test failures.

```bash
# Fuzz ONE package. -fuzz cannot be used with a multi-package pattern:
# `go test -fuzz=FuzzMyFunction ./...` fails with
# "cannot use -fuzz flag with multiple packages".
go test -fuzz=FuzzMyFunction ./internal/parser

# Run for a bounded duration. Without -fuzztime, fuzzing runs until it
# finds a failure or you interrupt it, which is not what you want in CI.
go test -fuzz=FuzzMyFunction -fuzztime=60s ./internal/parser

# Limit minimization time (0 disables minimization)
go test -fuzz=FuzzMyFunction -fuzztime=60s -fuzzminimizetime=10s ./internal/parser

# Run every fuzz target's SEED corpus only, as ordinary unit tests, with no
# fuzzing at all. This is the form that belongs in `go test ./...` on every
# PR: it is fast, deterministic, and replays committed regressions.
go test ./...

# View corpus
ls testdata/fuzz/FuzzMyFunction/
```

That last point is the one people miss. A fuzz target is also a normal test: without `-fuzz`, `go test` runs `f.Fuzz` against the seed corpus and any failing inputs previously written to `testdata/fuzz/`. So the workflow is to fuzz one package at a time, on a schedule or a dedicated job with a `-fuzztime` budget, commit whatever crashers it finds, and let the ordinary `go test ./...` on every PR guard against their return.

### Staff Lens: Fuzz Everything That Parses

Any function that accepts untrusted bytes gets a fuzz target. Parsers, deserializers, URL handlers. Low-cost, high-value.

---
