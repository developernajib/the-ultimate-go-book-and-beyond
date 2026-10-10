## Production Debugging Pitfalls: When Debugging Makes Things Worse

Debugging tools that are safe in development can cause outages in production. Each pitfall below describes a real incident pattern, shows the dangerous code, and provides the corrected approach.

### The pprof Endpoint Exposure

**The Incident**: `/debug/pprof/` was publicly accessible. Attackers triggered CPU profiles to cause denial of service.

```go
// WRONG: pprof exposed to the internet

import _ "net/http/pprof"  // Auto-registers on DefaultServeMux

func main() {
    // WARNING: Anyone on the internet can now:
    // - Trigger CPU profiles (DOS)
    // - Dump all goroutines (info disclosure)
    // - Read heap contents (data leak)
    http.ListenAndServe(":8080", nil)
}
```

```go
// CORRECT: Protected debug endpoints

func main() {
    // Public server - no debug endpoints
    publicMux := http.NewServeMux()
    publicMux.HandleFunc("/api/", handleAPI)

    // Private debug server - internal network only
    debugMux := http.NewServeMux()
    debugMux.HandleFunc("/debug/pprof/", pprof.Index)
    debugMux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
    debugMux.HandleFunc("/debug/pprof/profile", pprof.Profile)
    debugMux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
    debugMux.HandleFunc("/debug/pprof/trace", pprof.Trace)

    // Wrap with authentication
    authedDebug := authMiddleware(debugMux)

    go func() {
        // Only listen on localhost or internal network
        log.Fatal(http.ListenAndServe("127.0.0.1:6060", authedDebug))
    }()

    log.Fatal(http.ListenAndServe(":8080", publicMux))
}

func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("X-Debug-Token")
        if !validateDebugToken(token) {
            http.Error(w, "Unauthorized", 401)
            return
        }

        // Audit log all debug access
        log.Printf("DEBUG ACCESS: user=%s endpoint=%s ip=%s",
            getUserFromToken(token), r.URL.Path, r.RemoteAddr)

        next.ServeHTTP(w, r)
    })
}
```

### The Production Debugger Lock

**The Problem**: Attaching a debugger to production pauses all goroutines. Your 1000-pod service just became unavailable.

```go
// WRONG: Interactive debugging in production

// Engineer attaches delve to production pod:
// dlv attach <pid>
// (dlv) break main.processOrder
// (dlv) continue
//
// Result: ALL goroutines STOP at breakpoint
// Entire pod becomes unresponsive
// Load balancer health checks fail
// Pod gets killed
// You lose your debug session AND cause an incident
```

```go
// CORRECT: Non-blocking debugging techniques

// 1. Use pprof instead of breakpoints
func debugHotPath(ctx context.Context) {
    // Start CPU profile
    f, _ := os.CreateTemp("", "cpu-*.prof")
    pprof.StartCPUProfile(f)

    // Do work
    time.Sleep(30 * time.Second)

    pprof.StopCPUProfile()
    f.Close()
    log.Printf("Profile saved to: %s", f.Name())
}

// 2. Add debug logging that can be enabled dynamically
type DebugLogger struct {
    enabled atomic.Bool
}

func (d *DebugLogger) Debug(msg string, args ...any) {
    if d.enabled.Load() {
        log.Printf("[DEBUG] "+msg, args...)
    }
}

// Enable via admin endpoint
func handleEnableDebug(w http.ResponseWriter, r *http.Request) {
    duration := r.URL.Query().Get("duration")
    d, _ := time.ParseDuration(duration)
    if d == 0 || d > 10*time.Minute {
        d = 5 * time.Minute  // Default, max 10 minutes
    }

    debugLogger.enabled.Store(true)
    time.AfterFunc(d, func() {
        debugLogger.enabled.Store(false)
    })
}

// 3. Conditional tracing
func processOrder(ctx context.Context, order Order) error {
    // Only trace if debug header present
    if ctx.Value("debug-trace") == true {
        ctx, span := tracer.Start(ctx, "processOrder", trace.WithAttributes(
            attribute.String("order.id", order.ID),
            attribute.Int64("order.total_cents", order.TotalCents),
        ))
        defer span.End()
    }

    return doProcess(ctx, order)
}
```

### The Core Dump Disk Bomb

**The Incident**: Core dumps enabled on 64GB heap service. Each restart generated 64GB core file. Disk filled, entire node died.

```go
// WRONG: Core dumps without limits

// Set in deployment: GOTRACEBACK=crash
// Result: 64GB core dump on crash
// If node has 100GB disk, 2 crashes = disk full = node down
```

```yaml
# CORRECT: Core dump limits and rotation

# In Kubernetes:
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    env:
    - name: GOTRACEBACK
      value: "crash"  # Enable core dumps
    resources:
      limits:
        ephemeral-storage: "10Gi"  # Limit disk usage

# In systemd:
# /etc/systemd/system/myapp.service
[Service]
LimitCORE=2G  # Limit core dump to 2GB
Environment="GOTRACEBACK=crash"
```

```go
// CORRECT: Smart core dump handling

func setupCoreDumps() {
    // Only enable in environments with enough disk
    diskFree := getDiskFreeSpace("/var/cores")
    heapSize := getExpectedHeapSize()

    if diskFree > heapSize*3 {  // Need 3x heap for safety
        os.Setenv("GOTRACEBACK", "crash")
        log.Printf("Core dumps enabled (disk free: %d, heap: %d)", diskFree, heapSize)
    } else {
        os.Setenv("GOTRACEBACK", "all")  // Just goroutine dump
        log.Printf("Core dumps disabled (insufficient disk)")
    }

    // Also set up core dump cleanup
    go func() {
        ticker := time.NewTicker(1 * time.Hour)
        for range ticker.C {
            cleanOldCoreDumps("/var/cores", 24*time.Hour)
        }
    }()
}

func cleanOldCoreDumps(dir string, maxAge time.Duration) {
    entries, _ := os.ReadDir(dir)
    for _, entry := range entries {
        if !strings.HasPrefix(entry.Name(), "core.") {
            continue
        }
        info, _ := entry.Info()
        if time.Since(info.ModTime()) > maxAge {
            os.Remove(filepath.Join(dir, entry.Name()))
        }
    }
}
```

### The Dump That Exposed Secrets, and the Dump That Did Not

This one is worth getting right, because the folklore version is wrong and the wrong version leads people to build a defence that defends nothing.

The claim you will hear is that a goroutine dump prints function arguments, so a password parameter shows up in plain text. It does not. Go's traceback prints raw machine words, and a `string` is a two-word header, so what you actually get is a pointer and a length:

```
goroutine 6 [select]:
main.authenticateUser({0x4c5b53, 0x5}, {0x3e578c5dc148, 0x8})
	/app/main.go:16 +0x45
```

Those are addresses and lengths (`0x5` for `"alice"`, `0x8` for an eight-byte secret), never contents. The runtime does not dereference the pointer, and it certainly does not call your `String()` method: a traceback runs in contexts where calling arbitrary user code would be unsafe. Grep a real goroutine dump for the secret and you find nothing.

So the `SensitiveString` wrapper below does **not** redact goroutine dumps. There is nothing there to redact.

What genuinely leaks the secret is a **core dump**, because a core is a byte-for-byte image of the process address space, and the secret is in that memory as plain text no matter what methods its type has. The same string that appears zero times in a goroutine dump appears verbatim in the core:

```bash
# Same program, same secret, two artifacts:
$ grep -c 'hunter2!' goroutine-dump.txt
0
$ grep -c 'hunter2!' core.1289505
2
```

That is the real threat model, and it is why 24.3 insists cores go to encrypted storage with narrow IAM and short retention, and why you rotate credentials that were live when the core was taken. No amount of type wrapping changes it. If you need secrets not to sit in recoverable memory, that is a different discipline: zero the bytes after use with a `[]byte` you control, and keep in mind that Go's GC may have copied the value elsewhere anyway.

The wrapper is still worth having, just for the places that *do* call your methods, which means logs and serialization:

```go
// Useful, but be clear about the scope: this redacts logs and JSON.
// It does NOT affect goroutine dumps (which never print contents) or
// core dumps (which contain the raw bytes regardless).

type SensitiveString struct {
    value string
}

func NewSensitiveString(v string) SensitiveString {
    return SensitiveString{value: v}
}

// Value returns the actual value when explicitly needed.
func (s SensitiveString) Value() string { return s.value }

// String covers fmt.Sprintf("%s"/"%v") and anything that formats it.
func (s SensitiveString) String() string { return "[REDACTED]" }

// MarshalJSON covers encoding/json, including accidental inclusion in an
// API response or a debug endpoint that dumps a config struct.
func (s SensitiveString) MarshalJSON() ([]byte, error) {
    return []byte(`"[REDACTED]"`), nil
}

// LogValue covers log/slog.
func (s SensitiveString) LogValue() slog.Value {
    return slog.StringValue("[REDACTED]")
}
```

One caveat even here: `%#v` asks for Go-syntax representation and deliberately ignores `String()`, so a struct containing this field prints its guts:

```go
c := Config{User: "alice", Pass: NewSensitiveString("hunter2!")}

fmt.Printf("%v\n", c)   // {alice [REDACTED]}
fmt.Printf("%#v\n", c)  // main.Config{User:"alice", Pass:main.SensitiveString{value:"hunter2!"}}
```

No tool catches that for you. `go vet`'s `printf` analyzer checks verbs against argument types and arity, not whether a value is sensitive, so `%#v` on a secret-bearing struct passes vet cleanly. The defence is code review and not putting the secret in a struct you debug-print in the first place.

### Quick Reference: Debug Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Public pprof | DOS, data exposure | Auth + internal network only |
| Breakpoints in prod | Service freeze | Use profiling, not debuggers |
| Unlimited core dumps | Disk exhaustion | Size limits + rotation |
| Secrets in dumps | Credential exposure | SensitiveString wrapper |
| Debug logging always on | Performance impact | Dynamic enable with timeout |
| No audit trail | Unknown who accessed what | Log all debug access |

### Staff Lens: Debug Safety Is Security

Every debug capability is an attack surface. Public pprof leaks memory contents. Uploaded core dumps leak secrets. Production Delve sessions give full memory access. Treat debug safety as security architecture, not afterthought.

---
