## Quick Debugging & Production Triage Guide

When a high-severity production incident strikes, engineering teams cannot afford random guessing. This guide provides a rapid triage playbook for diagnosing the four most common classes of Go production emergencies.

---

### Scenario A: High CPU Utilization & Latency Spikes

#### Step 1: Capture a 30-Second Production CPU Profile
```bash
# Capture CPU profile directly from Kubernetes pod
kubectl exec -it <pod-name> -- curl -s http://localhost:6060/debug/pprof/profile?seconds=30 > cpu.pprof

# Analyze interactively with go tool pprof
go tool pprof -http=:8080 cpu.pprof
```

#### Step 2: Identify Top Offenders
Look at the top CPU consumers in the **Flame Graph** or text list:
- **Application Logic**: Identify hot loops or un-preallocated string/slice concatenation.
- **runtime.mallocgc**: Indicates massive heap allocation rate! High memory allocations trigger heavy garbage collector CPU pressure. Switch to Heap Profiling (Scenario B).
- **runtime.futex / sync.(*Mutex).Lock**: High lock contention! Goroutines are waiting on a shared lock. Capture a Mutex profile via `/debug/pprof/mutex`.

---

### Scenario B: Memory Leaks & Container OOM Evictions

#### Step 1: Capture In-Use vs. Allocated Heap Profiles
```bash
# 1. Inspect currently live in-use heap objects
curl -s http://localhost:6060/debug/pprof/heap > heap-inuse.pprof
go tool pprof -inuse_space -http=:8080 heap-inuse.pprof

# 2. Inspect total cumulative allocations (helps identify GC churn)
go tool pprof -alloc_space -http=:8080 heap-inuse.pprof
```

#### Step 2: Differentiate Heap Leak vs. Goroutine Stack Leak
- If `pprof heap` shows low memory (e.g., 200MB) but the container is using 4GB of RAM, **the leak is NOT in the heap**.
- It is almost certainly **accumulated goroutine stacks**! Each goroutine consumes at least 2KB–8KB of stack. If 500,000 goroutines are leaked, they consume over 2GB of unmanaged stack RAM. Proceed to Scenario C.

---

### Scenario C: Goroutines Accumulating / Hung Requests

#### Step 1: Capture Full Goroutine Stack Dump
```bash
# Dump all active goroutines with full call stacks (debug=2)
curl -s http://localhost:6060/debug/pprof/goroutine?debug=2 > goroutines.txt

# Count total active goroutines
grep -c "^goroutine " goroutines.txt
```

#### Step 2: Identify Blocked Call Sites
Grep for the most frequent blocking states:
```bash
# Check how many goroutines are blocked on network I/O
grep "net.(*netFD).Read" goroutines.txt | wc -l

# Check how many goroutines are blocked on channel receives
grep "runtime.chanrecv1" goroutines.txt | wc -l

# Check how many goroutines are blocked on mutexes
grep "sync.(*Mutex).Lock" goroutines.txt | wc -l
```
- **If blocked on `net.Read`**: An upstream dependency is hanging and the HTTP/gRPC client lacks a context deadline!
- **If blocked on `chanrecv1`**: An unbuffered channel was created with no sender, or the sender panicked before writing.

---

### Scenario D: Intermittent Panics & Silent Process Exits

#### Step 1: Configure Core Dump & Verbose Traceback
By default, Go only prints the panicking goroutine. To view the stacks of all goroutines during a crash:
```bash
# Set in container environment
export GOTRACEBACK=all

# Or generate OS core dump for post-mortem debugging with Delve
export GOTRACEBACK=crash
```

#### Step 2: Diagnose Common Crash Signatures
- **`fatal error: concurrent map read and map write`**: Map accessed concurrently without synchronization. (Rerun with `-race` in staging).
- **`fatal error: stack overflow`**: Unbounded recursive function calls.
- **`panic: runtime error: invalid memory address or nil pointer dereference`**: Dereferencing a nil pointer or uninitialized interface.

---
