## 24.9 Production Debugging Checklist

### Initial Triage

The first minutes of a production incident should follow a repeatable checklist rather than ad-hoc investigation to avoid missing obvious signals. A programmatic triage runner checks HTTP health, error rate, latency percentiles, goroutine count, memory, CPU, disk, and database connection pool in sequence, returning a structured report that gives the on-call engineer an immediate multi-dimensional view of system health.

```go
package debug

import "time"

type TriageChecklist struct {
    ServiceName string
    Timestamp   time.Time
    Symptoms    []string
    Checks      []TriageCheck
}

type TriageCheck struct {
    Name     string
    Status   string // "ok", "warning", "critical", "unknown"
    Value    string
    Expected string
}

func RunTriage(serviceName string) *TriageChecklist {
    checklist := &TriageChecklist{
        ServiceName: serviceName,
        Timestamp:   time.Now(),
        Symptoms:    make([]string, 0),
        Checks:      make([]TriageCheck, 0),
    }

    // Check 1: Is the service responding?
    checklist.Checks = append(checklist.Checks, checkHTTPHealth(serviceName))

    // Check 2: What's the error rate?
    checklist.Checks = append(checklist.Checks, checkErrorRate(serviceName))

    // Check 3: What's the latency?
    checklist.Checks = append(checklist.Checks, checkLatency(serviceName))

    // Check 4: How many goroutines?
    checklist.Checks = append(checklist.Checks, checkGoroutines(serviceName))

    // Check 5: Memory usage?
    checklist.Checks = append(checklist.Checks, checkMemory(serviceName))

    // Check 6: CPU usage?
    checklist.Checks = append(checklist.Checks, checkCPU(serviceName))

    // Check 7: Disk space?
    checklist.Checks = append(checklist.Checks, checkDisk(serviceName))

    // Check 8: Database connections?
    checklist.Checks = append(checklist.Checks, checkDBConnections(serviceName))

    return checklist
}

func checkHTTPHealth(service string) TriageCheck {
    // Implementation
    return TriageCheck{
        Name:     "http_health",
        Status:   "ok",
        Value:    "200",
        Expected: "200",
    }
}
```

### Debug Information Endpoint

A `/debug/info` endpoint encodes the binary's build metadata, version tag, commit SHA, build timestamp, alongside live runtime state: goroutine count, heap bytes, GC cycle count, and process uptime. Embedding this in every service eliminates the common "which version is actually running?" confusion during incidents and provides a single curl command that confirms both deployment and runtime health.

The `Version`/`Commit`/`BuildTime` variables below are the classic `-ldflags -X` approach, and they still work. But you get much of this for free now: the toolchain stamps VCS information into every binary built inside a repository, and `runtime/debug.ReadBuildInfo()` reads it back at runtime with no build-time wiring at all. Look for the `vcs.revision`, `vcs.time`, and `vcs.modified` keys in `BuildInfo.Settings`. The one that earns its keep during an incident is `vcs.modified`, which tells you the binary was built from a dirty tree. Note that `-trimpath` does not remove this, but building outside a git checkout (a common Docker pattern that copies only source files) does, which is why some fleets still stamp explicitly.

Whatever you do, keep this endpoint free of secrets. It is tempting to dump the whole environment here, and that is how tokens end up in a screenshot pasted into an incident channel. Allowlist the keys, never range over `os.Environ()`.

```go
package debug

import (
    "cmp"
    "encoding/json"
    "net/http"
    "os"
    "runtime"
    "strconv"
    "time"
)

type DebugInfo struct {
    Version     string            `json:"version"`
    Commit      string            `json:"commit"`
    BuildTime   string            `json:"build_time"`
    GoVersion   string            `json:"go_version"`
    GOOS        string            `json:"goos"`
    GOARCH      string            `json:"goarch"`
    NumCPU      int               `json:"num_cpu"`
    Hostname    string            `json:"hostname"`
    Environment map[string]string `json:"environment"`
    Runtime     RuntimeInfo       `json:"runtime"`
}

type RuntimeInfo struct {
    NumGoroutine int    `json:"num_goroutine"`
    MemAlloc     uint64 `json:"mem_alloc_bytes"`
    MemSys       uint64 `json:"mem_sys_bytes"`
    NumGC        uint32 `json:"num_gc"`
    Uptime       string `json:"uptime"`
}

var (
    Version   = "dev"
    Commit    = "unknown"
    BuildTime = "unknown"
    startTime = time.Now()
)

func debugInfoHandler(w http.ResponseWriter, r *http.Request) {
    hostname, _ := os.Hostname()

    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    info := DebugInfo{
        Version:   Version,
        Commit:    Commit,
        BuildTime: BuildTime,
        GoVersion: runtime.Version(),
        GOOS:      runtime.GOOS,
        GOARCH:    runtime.GOARCH,
        NumCPU:    runtime.NumCPU(),
        Hostname:  hostname,
        // Report the values the runtime is actually using, not the env vars.
        // os.Getenv("GOMAXPROCS") is empty on almost every service, because
        // the value is usually defaulted by the runtime or set by a library
        // rather than exported into the environment. An endpoint that exists
        // to answer "what is this process doing" must not report "" for the
        // knob you are trying to check.
        Environment: map[string]string{
            "GOMAXPROCS":  strconv.Itoa(runtime.GOMAXPROCS(0)),
            "NumCPU":      strconv.Itoa(runtime.NumCPU()),
            "GOGC":        cmp.Or(os.Getenv("GOGC"), "100 (default)"),
            "GOMEMLIMIT":  cmp.Or(os.Getenv("GOMEMLIMIT"), "math.MaxInt64 (unset)"),
        },
        Runtime: RuntimeInfo{
            NumGoroutine: runtime.NumGoroutine(),
            MemAlloc:     m.Alloc,
            MemSys:       m.Sys,
            NumGC:        m.NumGC,
            Uptime:       time.Since(startTime).String(),
        },
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(info)
}
```

### Staff Lens: Build Info Per Service

Every service should expose its build info (version, commit, build time). During incidents, the first question is "what version is running?". Without build info endpoint, this is guesswork.

---
