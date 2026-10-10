## 97.19 Debugging Containers In-Depth

### Remote Debugging with Delve

Remote debugging lets you set breakpoints, inspect variables, and step through Go code running inside a container from your local IDE. Delve runs in "headless" mode inside the container, listening on port 2345 for debugger connections. Your IDE (VS Code, GoLand, etc.) connects to that port and provides the same debugging experience as if the code were running locally. The key requirement is building the binary with `-gcflags="all=-N -l"` to disable compiler optimizations that would otherwise make variable inspection unreliable.

```dockerfile
# Dockerfile.debug
FROM golang:1.27.1-alpine

# Install debugging tools
RUN apk add --no-cache git curl bash

# Install Delve
RUN go install github.com/go-delve/delve/cmd/dlv@latest

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build with debug symbols (disable optimizations)
RUN go build -gcflags="all=-N -l" -o /app/server ./cmd/server

EXPOSE 8080 2345

# Run with Delve in headless mode
CMD ["dlv", "--listen=:2345", "--headless=true", "--api-version=2", "--accept-multiclient", "exec", "/app/server"]
```

```json
// .vscode/launch.json - VS Code debug configuration
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Attach to Container",
            "type": "go",
            "request": "attach",
            "mode": "remote",
            "remotePath": "/app",
            "port": 2345,
            "host": "localhost",
            "showLog": true,
            "trace": "verbose"
        }
    ]
}
```

### Interactive Debugging Commands

Once your debug container is running with Delve in headless mode, you can connect to it using the `dlv connect` command from your terminal. This gives you a REPL-style interface where you can set breakpoints, step through execution, print variable values, and inspect all running goroutines. You can also shell into the container directly with `docker exec` to run diagnostic commands, check environment variables, or inspect the filesystem.

```bash
# Start debug container
docker compose -f docker-compose.debug.yml up -d

# Attach to running container
docker exec -it myapp-debug sh

# Connect with dlv client
dlv connect :2345

# Inside dlv:
(dlv) break main.main
(dlv) continue
(dlv) print myVariable
(dlv) goroutines
(dlv) stack
(dlv) next
(dlv) step
(dlv) quit
```

### Profiling Containers

Go's built-in `pprof` tool lets you collect CPU profiles, heap snapshots, and execution traces from a running container. By importing `net/http/pprof` and starting an HTTP server on a separate port (typically 6060), your application exposes profiling endpoints that you can query with `curl` or `go tool pprof`. This is invaluable for diagnosing performance problems in production-like environments, where the container's resource constraints and concurrent workload may reveal bottlenecks that do not appear during local development.

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof" // Register pprof handlers
    "os"
)

func main() {
    // Enable pprof in development/debug mode
    if os.Getenv("ENABLE_PPROF") == "true" {
        go func() {
            log.Println("pprof server running on :6060")
            log.Println(http.ListenAndServe(":6060", nil))
        }()
    }

    // Main application...
}
```

```bash
# Collect CPU profile from container
docker exec myapp curl -o /tmp/cpu.prof http://localhost:6060/debug/pprof/profile?seconds=30
docker cp myapp:/tmp/cpu.prof ./cpu.prof
go tool pprof -http=:8081 cpu.prof

# Collect heap profile
docker exec myapp curl -o /tmp/heap.prof http://localhost:6060/debug/pprof/heap
docker cp myapp:/tmp/heap.prof ./heap.prof
go tool pprof -http=:8082 heap.prof

# Trace
docker exec myapp curl -o /tmp/trace.out http://localhost:6060/debug/pprof/trace?seconds=5
docker cp myapp:/tmp/trace.out ./trace.out
go tool trace trace.out
```

### Container Troubleshooting Checklist

When a container is not behaving as expected, systematic troubleshooting saves hours of guessing. The most common issues fall into five categories: startup failures (missing dependencies, wrong entrypoint), immediate exits (panics, daemonizing processes), network problems (binding to localhost instead of 0.0.0.0), performance degradation (incorrect GOMAXPROCS, no memory limits), and permission errors (non-root user cannot read files). The checklist below gives you a structured approach to diagnose each category.

```
┌──────────────────────────────────────────────────────────────────┐
│                 CONTAINER TROUBLESHOOTING                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CONTAINER WON'T START:                                          │
│  ├── docker logs <container>                                     │
│  ├── docker inspect <container>                                  │
│  ├── Check entrypoint/cmd                                        │
│  ├── Check for missing dependencies                              │
│  └── Check file permissions                                      │
│                                                                  │
│  CONTAINER EXITS IMMEDIATELY:                                    │
│  ├── Check if process is daemonizing (shouldn't)                 │
│  ├── Check for panic in Go code                                  │
│  ├── Check environment variables                                 │
│  └── Run interactively: docker run -it image sh                  │
│                                                                  │
│  NETWORK ISSUES:                                                 │
│  ├── docker network inspect <network>                            │
│  ├── Check if binding to 0.0.0.0 (not localhost)                 │
│  ├── Check port mappings                                         │
│  └── Test with curl from inside container                        │
│                                                                  │
│  PERFORMANCE ISSUES:                                             │
│  ├── Check GOMAXPROCS setting                                    │
│  ├── Check memory limits vs GOMEMLIMIT                           │
│  ├── Profile with pprof                                          │
│  └── Check for resource throttling                               │
│                                                                  │
│  PERMISSION ISSUES:                                              │
│  ├── Check USER directive in Dockerfile                          │
│  ├── Check file ownership in image                               │
│  ├── Check volume mount permissions                              │
│  └── Check security context (SELinux, AppArmor)                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Practical Container Debugging Without Panic

The first time a Go container crashes in staging with no shell and cryptic output, the instinct is panic. The productive response is a systematic process: check exit code, check logs, check events (in Kubernetes), check resource usage.

Exit codes carry information. Exit code 0 means clean shutdown. Exit code 1 means the application exited with an error (check logs). Exit code 137 means the container was killed with SIGKILL, which almost always means an OOM kill (check memory limits and usage). Exit code 143 means SIGTERM was received but the process did not exit within the grace period (check shutdown handling). Memorizing these exit codes saves significant time during incident response.

For local debugging of production-like containers, the `dlv` remote debugging approach in this section is valuable, but it requires building a debug variant of the image with the binary compiled without optimizations (`-gcflags="all=-N -l"`). Having a Makefile target that builds and runs the debug variant is a good first-job habit.

### Senior @ FAANG: Container Debugging at Scale and Incident Response Playbooks

At staff level, the goal of debugging infrastructure is to make individual debugging sessions unnecessary. Every incident that requires someone to exec into a container or add debug logging and redeploy is evidence of an observability gap. The post-incident action item should be to add the missing signal to the standard instrumentation so the next similar incident can be diagnosed without manual intervention.

The incident response pattern for container-related incidents: automated alerting fires based on SLO violation (error rate or latency, not just "container crashed"), the on-call engineer follows a runbook that starts with checking pre-built dashboards (not raw logs), the dashboards are designed to answer specific diagnostic questions (is this one instance or all instances, is CPU or memory the constraint, did a recent deployment correlate with the degradation).

The ephemeral debug container pattern (`kubectl debug` with a sidecar or ephemeral container) is the Kubernetes-native solution for the cases where you genuinely need a shell. It attaches a container to a running pod without modifying the pod spec, uses the debug container's tools, and goes away when you are done. The staff-level concern is access control: who is allowed to create ephemeral debug containers in production? This capability is powerful enough that it needs to be gated behind an explicit RBAC role, audited, and potentially integrated with a just-in-time access request workflow.
