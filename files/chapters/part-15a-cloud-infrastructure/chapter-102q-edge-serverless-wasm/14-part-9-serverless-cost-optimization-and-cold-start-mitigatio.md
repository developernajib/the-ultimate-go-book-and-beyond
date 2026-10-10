## 102Q.12 Serverless Cost Optimization and Cold Start Mitigation

### Cold Start Root Causes

A Lambda cold start occurs when the platform must provision a new execution environment before running your handler. The delay breaks into three phases:

```
│ Platform init │ Runtime init │  Handler init  │  Handler exec  │
│   50-200ms    │   0-50ms     │   your code    │   your code    │
└───────────────┴──────────────┴────────────────┴────────────────┘
                                ↑ this is your only tunable zone
```

**Platform init** - AWS provisions the microVM (Firecracker), mounts the filesystem layer, and starts the process. Invisible to you. VPC attachment adds 200-500ms here (ENI provisioning).

**Runtime init** - the Lambda runtime process starts (Go: near zero. JVM: 300-800ms).

**Handler init** - your `init()` functions and global variable initializers run.

### Cold Start Times by Runtime (p50, 128 MB, no VPC)

| Runtime | Typical Cold Start |
|---------|--------------------|
| Go (arm64) | ~50-80ms |
| Go (x86_64) | ~80-120ms |
| Node.js 20 | ~200-350ms |
| Python 3.12 | ~150-250ms |
| Java 21 (standard) | ~800-1200ms |
| Java 21 (SnapStart) | ~150-300ms |
| .NET 8 NativeAOT | ~80-150ms |

Go's compiled binary with no runtime interpreter gives it a structural cold start advantage. The only cost is your own `init()` work.

### Strategies to Minimize Cold Starts

**1. Defer initialization with `sync.Once`**

```go
package main

import (
    "context"
    "database/sql"
    "os"
    "sync"

    "github.com/aws/aws-lambda-go/lambda"
    _ "github.com/lib/pq"
)

var (
    db     *sql.DB
    dbOnce sync.Once
    dbErr  error
)

// getDB lazily opens the connection on first real invocation,
// not during the cold start platform-init phase.
func getDB() (*sql.DB, error) {
    dbOnce.Do(func() {
        db, dbErr = sql.Open("postgres", mustEnv("DATABASE_URL"))
        if dbErr == nil {
            db.SetMaxOpenConns(5)
            db.SetMaxIdleConns(2)
        }
    })
    return db, dbErr
}

type Request struct {
    UserID string `json:"userId"`
}

type Response struct {
    Email string `json:"email"`
}

func handler(ctx context.Context, req Request) (Response, error) {
    conn, err := getDB()
    if err != nil {
        return Response{}, err
    }

    var email string
    err = conn.QueryRowContext(ctx,
        "SELECT email FROM users WHERE id = $1", req.UserID,
    ).Scan(&email)
    if err != nil {
        return Response{}, err
    }

    return Response{Email: email}, nil
}

func main() {
    lambda.Start(handler)
}

func mustEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        panic("missing env: " + key)
    }
    return v
}
```

**2. Binary size optimization**

```bash
# Standard stripped build
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -trimpath -o bootstrap .

# Verify size
ls -lh bootstrap
# Target: < 8 MB for < 50ms cold start contribution

# Optional: further compress with UPX (tradeoff: adds ~15ms decompression)
upx --best bootstrap
```

**3. GOMAXPROCS tuning**

Lambda allocates fractional vCPUs at lower memory tiers. Setting `GOMAXPROCS` above the available vCPU count wastes scheduler cycles:

```go
package main

import (
    "math"
    "os"
    "runtime"
    "strconv"
)

func parseIntEnv(key string, defaultVal int) int {
    if v := os.Getenv(key); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            return n
        }
    }
    return defaultVal
}

func init() {
    // Lambda vCPU allocation: 1 vCPU per 1769 MB
    memMB := parseIntEnv("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", 128)
    vcpus := math.Max(1, math.Round(float64(memMB)/1769.0))
    runtime.GOMAXPROCS(int(vcpus))
}
```

**4. VPC cold start mitigation**

VPC functions pay an ENI provisioning cost. Mitigations:
- Use **VPC Lattice** or **RDS Proxy** to avoid direct VPC Lambda placement.
- Enable **hyperplane ENI** (automatic since 2020) - eliminates ENI provisioning delay, replaces with ~100ms fixed overhead only on the first deployment.
- Use **PrivateLink endpoints** for DynamoDB/S3 so the function can stay outside the VPC.

**5. Provisioned Concurrency**

```yaml
# SAM template snippet
MyFunction:
  Type: AWS::Serverless::Function
  Properties:
    Handler: bootstrap
    Runtime: provided.al2023
    Architectures: [arm64]
    AutoPublishAlias: live
    ProvisionedConcurrencyConfig:
      ProvisionedConcurrentExecutions: 5
```

Provisioned concurrency keeps N execution environments initialized and warm. Cost: you pay for the provisioned environments continuously (not just per invocation), so size carefully.

**6. Lambda SnapStart (JVM. referenced for completeness)**

SnapStart takes a snapshot of the initialized JVM state after the `init` phase and restores it on subsequent cold starts. Reduces Java cold starts from ~1s to ~200ms. Not available for Go (Go already starts fast enough that the snapshotting overhead would not benefit).

### Cost Modeling: Lambda vs EC2

Lambda pricing (us-east-1, arm64, as of 2025):
- **Invocation cost**: $0.20 per million requests
- **Duration cost**: $0.0000133334 per GB-second

```
Monthly cost formula:
  invocations × $0.0000002
+ invocations × (avg_duration_sec) × (memory_GB) × $0.0000133334
```

Break-even vs EC2 t4g.small ($0.0168/hr ≈ $12.10/mo):

```
At 128 MB / 50ms average duration:
  12.10 / (0.0000002 + 0.00005 × 0.125 × 0.0000133334)
≈ 12.10 / 0.00000029167
≈ ~41 million invocations/month break-even

Above ~41M req/mo at this profile → EC2 or containers cheaper.
Below → Lambda cheaper (you pay nothing at zero traffic).
```

Rule of thumb: Lambda wins for **spiky, unpredictable, or low-to-medium throughput** workloads. EC2/containers win for **sustained high throughput** (>50 req/s continuously at sub-100ms durations).

### Step Function Orchestration Cost

Step Functions Express Workflows: $1.00 per million state transitions. Each Lambda invocation in a workflow = 1 transition per state. For a 5-step pipeline:

```
Cost per execution = 5 transitions × $0.000001 + Lambda costs
At 1M executions/mo: $5 in Step Functions overhead alone
```

For high-frequency orchestration (>10M/mo), consider **direct Lambda invocation chains** (one Lambda calls the next) or **SQS fan-out** to reduce Step Functions costs - but you lose the built-in retry/audit trail.

### Minimal Cold Start Lambda: ~15ms Target

```go
// ultra-lean Lambda: no VPC, no DB, pure compute, arm64
package main

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "runtime"

    "github.com/aws/aws-lambda-go/lambda"
)

func init() {
    runtime.GOMAXPROCS(1) // single vCPU at 128MB
}

type HashRequest struct {
    Data string `json:"data"`
}

type HashResponse struct {
    SHA256 string `json:"sha256"`
    Algo   string `json:"algo"`
}

func handler(_ context.Context, req HashRequest) (HashResponse, error) {
    h := sha256.Sum256([]byte(req.Data))
    return HashResponse{
        SHA256: hex.EncodeToString(h[:]),
        Algo:   "sha256",
    }, nil
}

func main() {
    lambda.Start(handler)
}
```

```bash
# Build
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -trimpath -o bootstrap .

# Deploy
zip function.zip bootstrap
aws lambda update-function-code \
  --function-name hash-fn \
  --zip-file fileb://function.zip \
  --architectures arm64

# Measure cold start
aws lambda invoke \
  --function-name hash-fn \
  --cli-binary-format raw-in-base64-out \
  --payload '{"data":"hello"}' \
  --log-type Tail \
  out.json | jq -r '.LogResult' | base64 -d | grep "Init Duration"
# Init Duration: 13.42 ms
```

---

### Junior → FAANG: Cost Optimization as a First-Principles Skill

Lambda pricing has two components: invocation count and GB-seconds (memory allocated multiplied by duration in seconds). The optimization insight is that these two components interact: increasing memory reduces duration (more CPU is allocated), which can reduce total GB-seconds cost even though memory increases. The optimal memory setting is not the minimum, it is the setting where GB-seconds is minimized. AWS Lambda Power Tuning (an open-source Step Functions state machine) automates this measurement by invoking a function at multiple memory settings and plotting cost vs. performance.

Running Lambda Power Tuning on every production function before launching is a first-job habit that pays for itself quickly. A function invoked 100 million times per month that is 20% over-provisioned on memory wastes approximately $15--$50/month per function. Across a fleet of 50 functions, that is $750--$2,500/month in avoidable Lambda cost, not including the performance improvement from right-sizing.

The cold start measurement using `Init Duration` in the log output is the ground truth for cold start latency. The `aws lambda invoke` command with `--log-type Tail` returns the last 4KB of the log as base64, which includes the REPORT line with `Init Duration`. Automating this measurement in CI (invoke the function, parse Init Duration, fail the build if it exceeds the budget) converts the cold start budget from a aspiration to a deployment gate.

### Senior @ FAANG: Serverless Cost Governance as a Platform Program

At staff level, cold start optimization and cost efficiency are platform programs with organizational metrics, not per-function improvements. The platform team owns the Lambda cost dashboard (total monthly Lambda spend, cost per invocation by function, GB-seconds by function, cold start frequency by function), the rightsizing program (automated Lambda Power Tuning runs on a schedule, with recommendations pushed to function owners), and the provisioned concurrency policy (which functions qualify, what the budget limit is, and who approves exceptions).

The organizational cost reduction opportunity that is most commonly missed: functions with consistent invocation patterns benefit from scheduled scaling. A function that handles batch processing jobs from 8am to 6pm weekdays does not need provisioned concurrency at 2am Sunday. Lambda Application Auto Scaling supports scheduled scaling actions that adjust provisioned concurrency based on time-of-day and day-of-week patterns, reducing provisioned concurrency cost by 50-70% for predictable workloads. Implementing this as an organizational pattern (all provisioned concurrency is configured with scheduled scaling unless an exception is approved) converts a per-function optimization into a fleet-wide policy.

The arm64 migration for existing Lambda functions is a platform-level effort, not a per-team effort. The platform team should own the migration playbook: rebuild with `GOARCH=arm64`, verify functional correctness with the existing test suite, benchmark duration against the x86_64 baseline, and deploy with a canary percentage. The expected outcome is 20% cost reduction (10-20% lower duration plus the 20% lower price per GB-second for arm64) with no functional changes. At scale, this migration pays for the platform team's time many times over.
