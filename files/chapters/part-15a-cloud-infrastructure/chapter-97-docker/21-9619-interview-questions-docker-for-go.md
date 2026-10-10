## 97.21 Interview Questions: Docker for Go

### Fundamental Questions

**Q1: Why is Go particularly well-suited for containerization?**

Answer:
```
GO'S CONTAINER ADVANTAGES:

1. STATIC BINARIES:
   - No runtime dependencies (unlike Python, Node.js, Java)
   - Can use scratch image (0 bytes base)
   - Result: ~10MB final images vs ~500MB+ for other languages

2. FAST STARTUP:
   - No VM warmup (unlike JVM)
   - No interpreter startup (unlike Python)
   - Critical for serverless/auto-scaling

3. CROSS-COMPILATION:
   - Build for any OS/architecture from any host
   - GOOS=linux GOARCH=arm64 go build
   - Simplifies multi-arch builds

4. SMALL MEMORY FOOTPRINT:
   - Efficient garbage collector
   - No VM overhead
   - Important for container density

5. SINGLE BINARY DEPLOYMENT:
   - No dependency management at runtime
   - No "works on my machine" issues
   - Immutable deployments
```

**Q2: Explain the difference between scratch and distroless base images.**

Answer:
```dockerfile
// SCRATCH:
// - Literally empty (0 bytes)
// - No shell, no debugging tools
// - Smallest possible image
// - Only works with static binaries (CGO_ENABLED=0)
FROM scratch

// DISTROLESS:
// - Minimal runtime (~2MB for static, ~20MB for base)
// - No shell, no package manager
// - Includes CA certificates, timezone data
// - Works with CGO-enabled binaries (distroless/base)
FROM gcr.io/distroless/static-debian12

// WHEN TO USE EACH:
// scratch     → Pure Go, no CGO, maximum security
// distroless  → Need glibc, timezone, certificates
// alpine      → Need shell for debugging
```

**Q3: How do you handle GOMAXPROCS in containers?**

Answer:
```go
// PROBLEM:
// Go defaults GOMAXPROCS to host CPU count, not container limit
// Container with 1 CPU on 64-core host: GOMAXPROCS=64

// SOLUTION 1: Environment variable
// docker run -e GOMAXPROCS=2 myapp

// SOLUTION 2: automaxprocs (recommended)
import _ "go.uber.org/automaxprocs"
// Automatically reads container CPU quota

// SOLUTION 3: Manual detection
func setGOMAXPROCS() {
    // Read cgroup quota
    quota, _ := os.ReadFile("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
    period, _ := os.ReadFile("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
    // Calculate: cpus = quota / period
    // Set: runtime.GOMAXPROCS(cpus)
}
```

### Intermediate Questions

**Q4: How do you optimize Docker build times for Go projects?**

Answer:
```dockerfile
# OPTIMIZATION 1: Layer caching
# Copy go.mod first, then source code
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# OPTIMIZATION 2: BuildKit cache mounts
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /app/server

# OPTIMIZATION 3: Multi-stage to reduce context
FROM golang:1.27.1 AS builder
# ... build ...

FROM scratch
COPY --from=builder /app/server /server

# OPTIMIZATION 4: .dockerignore
# Exclude tests, docs, .git

# RESULT: Rebuild on source change goes from 5min to 30sec
```

**Q5: How do you manage secrets in Docker containers for Go applications?**

Answer:
```
THREE APPROACHES:

1. ENVIRONMENT VARIABLES (Simple but visible in inspect)
   docker run -e API_KEY=xxx myapp
   os.Getenv("API_KEY")

2. SECRET FILES (More secure)
   # Mount as volume
   docker run -v ./secrets:/run/secrets:ro myapp

   # In Go:
   secret, _ := os.ReadFile("/run/secrets/api_key")

3. SECRET MANAGERS (Production recommended)
   # HashiCorp Vault, AWS Secrets Manager, etc.
   # Fetch at runtime with short TTL
   # Rotate automatically

NEVER:
- Bake secrets into images
- Pass secrets as build args (visible in layer history)
- Store secrets in environment for production
```

### Advanced Questions

**Q6: Design a zero-downtime deployment strategy for a Go service in Docker.**

Answer:
```
BLUE-GREEN DEPLOYMENT:

┌─────────────┐     ┌─────────────┐
│   Nginx     │────►│  Blue v1.0  │ ← Current production
│   (LB)      │     │  (stable)   │
│             │     └─────────────┘
│             │
│             │     ┌─────────────┐
│             │ - - │ Green v1.1  │ ← New version (idle)
└─────────────┘     │  (staged)   │
                    └─────────────┘

DEPLOYMENT PROCESS:
1. Deploy v1.1 to green (no traffic)
2. Run health checks on green
3. Update nginx config to point to green
4. nginx reload (graceful, no dropped connections)
5. Blue now idle (ready for rollback)
6. Optional: tear down blue after verification

DOCKER COMPOSE IMPLEMENTATION:
- Use weighted upstream in nginx
- Scale green up, verify, flip weights, scale blue down
- Health checks are critical

GRACEFUL SHUTDOWN IN GO:
- Handle SIGTERM
- Stop accepting new connections
- Drain existing connections
- Timeout for slow clients
```

**Q7: How would you debug a memory leak in a containerized Go application?**

Answer:
```bash
# STEP 1: Enable pprof in container
# import _ "net/http/pprof"
# go http.ListenAndServe(":6060", nil)

# STEP 2: Expose pprof port
# docker run -p 6060:6060 myapp

# STEP 3: Collect heap profiles over time
curl http://container:6060/debug/pprof/heap > heap1.prof
sleep 60
curl http://container:6060/debug/pprof/heap > heap2.prof

# STEP 4: Compare profiles
go tool pprof -base heap1.prof heap2.prof
# Look for growing allocations

# STEP 5: Identify leak source
# Common causes:
# - Goroutine leaks (check /debug/pprof/goroutine)
# - Unbounded caches/maps
# - Unclosed resources (connections, files)
# - Global variables holding references

# STEP 6: Set memory limits to trigger OOM earlier
# docker run -m 256m myapp
# Use GOMEMLIMIT to make GC more aggressive
```

### Junior → FAANG: Interview Preparation Strategy for Docker Questions

Docker interview questions at entry to mid level test two things: can you explain concepts clearly, and can you debug problems you have not seen before. The first is a preparation problem; the second is a reasoning-under-pressure problem.

For preparation, be able to explain from memory: multi-stage build mechanics, why `CGO_ENABLED=0` is needed for scratch/distroless images, what GOMAXPROCS and GOMEMLIMIT do inside a container, and what the difference is between CMD and ENTRYPOINT. These are the standard questions. Practicing explaining them out loud, not just knowing them mentally, is what makes the difference in a real interview.

For debugging questions, the approach matters as much as the answer. When given a broken Dockerfile or a failing container scenario, start by gathering information (exit code, logs, resource usage) before hypothesizing. Then form a hypothesis, explain how you would verify it, and describe the fix. Interviewers value the process as much as the correct answer.

### Senior @ FAANG: Bar-Raiser Interview Signals for Docker and Container Topics

At staff level, the interview questions shift from "do you know how Docker works" to "how would you design a container platform for 500 teams" and "how would you improve our current container deployment process." These are open-ended architectural questions with no single correct answer.

The bar-raiser signals are: unprompted consideration of failure modes and operational burden (not just the happy path), explicit discussion of tradeoffs (every choice has a cost; naming the cost signals maturity), reference to organizational and process concerns alongside technical ones (governance, standards, on-call rotation), and concrete examples from actual experience at scale.

A bar-raiser response to "how would you design a container security posture for this org" does not stop at "use non-root and distroless images." It covers: supply-chain security (signed images, provenance attestations), admission control (what is enforced at runtime, what exception process exists), vulnerability management process (who triages, what the SLA is for critical CVEs, how base image updates are propagated), and the maturity model (where we are now, what the next investment is, and how we know when we have reached adequate maturity). Each of those sections represents a real engineering project, and the ability to scope them and sequence them is an L6/L7 capability.

---
