## 19.2 Memory Profiling

### Heap Profile

A heap profile captures the state of the heap at a specific moment in the program's execution. Calling `runtime.GC()` immediately before writing the profile forces a collection cycle so the "in use" numbers reflect only genuinely live objects rather than garbage that has not yet been swept.

```go
f, err := os.Create("mem.prof")
if err != nil {
    log.Fatal(err)
}
runtime.GC()  // Get up-to-date stats
pprof.WriteHeapProfile(f)
f.Close()
```

### The Heap Profile Is Sampled, Not Exact

This is the single most important thing to know about memory profiling, and it is the source of most confusion when the numbers do not add up.

The runtime does not record every allocation. It records roughly one allocation per `runtime.MemProfileRate` bytes allocated, which defaults to **524288 (512KB)**. `pprof` then scales the sampled values back up to estimate the true totals. The estimate is statistically sound for hot paths that allocate a lot, and it is unreliable for anything that allocates a little. A function that allocates 50KB once over the life of the process may not appear in the profile at all, and a function that shows "1.5MB" may really have allocated 1.1MB or 2MB.

The practical consequences:

- Do not treat heap profile numbers as exact. Treat them as ranked estimates. "This function is near the top" is trustworthy. "This function allocated exactly 27.83MB" is not.
- Do not go hunting for a small allocation you are certain exists but cannot find. At the default rate it is probably below the sampling threshold.
- If you need precision for a specific investigation, set `runtime.MemProfileRate = 1` before any allocation happens (that is, at the top of `main`, since the setting is only reliably applied once at startup). This records every allocation. It is also expensive, so it belongs in a debugging build or a test, never in production.

```go
func main() {
    runtime.MemProfileRate = 1  // Record every allocation. Debug builds only.
    // ...
}
```

For exact allocation counts in a benchmark, do not use the heap profile at all. Use `b.ReportAllocs()`, which reports precise per-operation allocation counts. That is covered in the benchmarking section.

A heap profile actually carries four sample types, not one, and each answers a different question:

| Sample type | Meaning |
|---|---|
| `alloc_objects` | Number of objects allocated over the process lifetime |
| `alloc_space` | Bytes allocated over the process lifetime |
| `inuse_objects` | Number of live objects at the snapshot |
| `inuse_space` | Bytes held by live objects at the snapshot |

Both `/debug/pprof/heap` and `/debug/pprof/allocs` serve this same four-type profile. They differ only in the default view `pprof` opens: `heap` defaults to `inuse_space`, `allocs` defaults to `alloc_space`.

### Memory Profile Types

Go's `pprof` HTTP endpoint exposes several memory views, each answering a different question about allocation behavior. Use `-inuse_space` to find what is currently consuming heap, and `-alloc_space` to find what has been allocated over the program's lifetime, the latter is essential for spotting high-throughput allocation paths that the GC keeps reclaiming but that still impose CPU overhead.

```bash
# All heap allocations
go tool pprof http://localhost:6060/debug/pprof/heap

# Allocations (count)
go tool pprof http://localhost:6060/debug/pprof/allocs

# Memory in use
go tool pprof -inuse_space http://localhost:6060/debug/pprof/heap

# Memory allocated
go tool pprof -alloc_space http://localhost:6060/debug/pprof/heap
```

### Analyzing Memory Profile

Once inside the interactive `pprof` shell, these commands cover the most common analysis workflow. `sample_index` selects which of the four views you are looking at, `top10` ranks functions by their contribution to that view, `list` drills into a specific function to show per-line allocation costs, and `web` renders the entire call graph as an SVG so you can visually trace the allocation hot-path back to its root caller.

```
(pprof) sample_index=inuse_space
(pprof) top10
(pprof) list functionName
(pprof) web
```

Note the syntax carefully. Inside the interactive shell you switch views with `sample_index=inuse_space`, not by passing `-inuse_space` to `top10`. This matters more than it looks: `top10 -inuse_space` is not an error and does not warn you in any obvious way. `pprof` parses the bare argument as an *ignore regex*, so it quietly reports `ignore=inuse_space` under "Active filters" and shows you whatever the default view already was. You get a plausible-looking table that does not answer the question you asked. The `-inuse_space` and `-alloc_space` spellings are command-line flags, valid only when you launch `go tool pprof`, as in the previous section.

### inuse vs alloc

- `inuse_space`: memory currently held by live objects. Useful for finding memory leaks.
- `alloc_space`: total memory allocated over time. Useful for finding GC pressure sources.

A function might allocate heavily but hold nothing (alloc high, inuse low). That is GC pressure. A function might allocate once but hold forever (alloc low, inuse high). That is a leak. Understand which view answers your question.

### Staff Lens: Allocation Reduction as Latency Improvement

Most GC pauses come from allocation pressure. Reducing allocations reduces GC pauses, which reduces tail latency. This is the single most effective lever for improving Go service P99 latency. Teams that internalize this ship measurably faster services than teams that do not.

The top allocation sources to audit: string concatenation in a loop (use `strings.Builder`), slice growth (pre-allocate with `make([]T, 0, n)` when you know the size), interface boxing (prefer concrete types or generics on hot paths), map growth (pre-size with `make(map[K]V, n)`), and reflection, which the `encoding/json` path drags in whether you asked for it or not.

---
