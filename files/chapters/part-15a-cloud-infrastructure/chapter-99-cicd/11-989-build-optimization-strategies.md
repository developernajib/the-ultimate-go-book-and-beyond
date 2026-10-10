## 99.11 Build Optimization Strategies

### Caching Strategies

CI build times are dominated by module downloads and compilation, both of which are highly cacheable. GitHub Actions provides two complementary mechanisms: the `actions/setup-go` action's built-in module cache and the `actions/cache` action for the Go build cache (`~/.cache/go-build`). The workflow below keys the cache on the hash of `go.sum` so that any dependency change invalidates the module cache while still falling back to a partial restore, and it uses Docker BuildKit's GitHub Actions cache backend to persist image layers between runs.

```yaml
# .github/workflows/optimized-build.yaml
name: Optimized Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'
          cache: true  # Automatic module caching

      - name: Cache build artifacts
        uses: actions/cache@v4
        with:
          path: |
            ~/.cache/go-build
            ~/go/pkg/mod
          key: ${{ runner.os }}-go-${{ hashFiles('**/go.sum') }}
          restore-keys: |
            ${{ runner.os }}-go-

      - name: Build
        run: go build -v ./...

  docker-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build with cache
        uses: docker/build-push-action@v5
        with:
          context: .
          push: false
          tags: myapp:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          # Using GitHub Actions cache for layers
```

### Parallel Jobs for Speed

Running lint, unit tests, and security scanning sequentially wastes wall-clock time because each step is independent. GitHub Actions schedules jobs without a `needs` dependency in parallel on separate runners, so the pipeline below completes all three fast checks concurrently and only blocks the slower integration and build jobs on their combined success. This structure typically cuts total pipeline duration by 40-60 % compared to a purely sequential workflow.

```yaml
# .github/workflows/parallel.yaml
name: Parallel Pipeline

on: [push, pull_request]

jobs:
  # These run in parallel
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: golangci/golangci-lint-action@v4

  test-unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - run: go test -short ./...

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

  # This waits for all above
  integration:
    needs: [lint, test-unit, security]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - run: go test -tags=integration ./...

  # Build only if everything passes
  build:
    needs: [integration]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t myapp:latest .
```

### Affected Target Detection

In a large monorepo, running the full test suite on every pull request is wasteful when only a handful of packages changed. This workflow uses `git diff` between the PR base and head commits to list modified Go files, extracts their unique package directories, and feeds them into a matrix job so only the affected packages are tested. The approach dramatically reduces CI minutes consumed while keeping coverage meaningful, because unchanged packages were already validated by earlier runs.

```yaml
# .github/workflows/affected.yaml
name: Affected Packages

on:
  pull_request:
    branches: [main]

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      packages: ${{ steps.changes.outputs.packages }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Detect affected packages
        id: changes
        run: |
          BASE_SHA=${{ github.event.pull_request.base.sha }}
          HEAD_SHA=${{ github.sha }}

          # Get changed Go files
          CHANGED_FILES=$(git diff --name-only $BASE_SHA $HEAD_SHA | grep '\.go$' || true)

          if [ -z "$CHANGED_FILES" ]; then
            echo "packages=[]" >> $GITHUB_OUTPUT
            exit 0
          fi

          # Get unique package directories
          PACKAGES=$(echo "$CHANGED_FILES" | xargs -I {} dirname {} | sort -u | jq -R -s -c 'split("\n") | map(select(length > 0))')
          echo "packages=$PACKAGES" >> $GITHUB_OUTPUT

  test:
    needs: detect
    if: needs.detect.outputs.packages != '[]'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        package: ${{ fromJson(needs.detect.outputs.packages) }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Test ${{ matrix.package }}
        run: go test -v ./${{ matrix.package }}/...
```

---

### Junior → FAANG: Build Optimization That Pays Off Immediately

The highest-return optimizations for a Go CI build are: module cache persistence (saves 30-60 seconds of `go mod download` per run), build cache persistence (saves significant recompilation time for large projects), and test result caching (avoids re-running tests for code that has not changed). All three are single-configuration changes in the CI YAML that pay off immediately.

The practical approach: run your pipeline without caching and note the time per stage. Add caching configuration and note the improvement. This before/after measurement is the justification for the cache configuration and the baseline for detecting future regressions.

First-job habit: when a CI pipeline run is slower than usual, check the cache hit rate before assuming the code change is the cause. A cache miss (expired cache, cache key collision, or cache eviction) can make a 3-minute build look like a 12-minute build, causing false alarm about build time regressions.

### Senior @ FAANG: Build Performance as an Engineering Productivity Metric

At staff level, build performance is a productivity metric with a clear ROI model. If the average pipeline run is 15 minutes, 500 engineers each wait for 5 pipeline runs per day, and the organization is paying for 500 engineers at an average of $300k/year total compensation, then each minute of pipeline reduction saves approximately $600/day in waiting time plus roughly $200/day in runner costs. A 5-minute reduction in pipeline time saves $4,000/day, which easily justifies significant infrastructure investment in caching and parallelism.

The remote cache architecture at scale (BuildKit cache in an S3 bucket or OCI registry, module cache in a shared S3 bucket, test result cache in a shared key-value store) requires careful key design and eviction policies. Too-aggressive eviction wastes cache warming time. Too-conservative eviction wastes storage and can serve stale cached results for build steps that are sensitive to environmental changes.

The Bazel remote execution path (for organizations that have invested in Bazel) adds remote execution on top of remote caching: not just "use the cached result if available" but "if the result is not cached, run the action on a remote executor in the cache's data center" for faster cache write and lower runner cost. This is the architecture Google and other large organizations use for sub-minute incremental builds, and it represents a major platform investment that requires dedicated infrastructure engineering capacity to build and maintain.
