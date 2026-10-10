## Question 17: Memory Leak Identification

**Level**: Senior

**Question**: This HTTP server has a memory leak. Find and fix it.

```go
func handler(w http.ResponseWriter, r *http.Request) {
    resp, err := http.Get("https://api.example.com/data")
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }

    data, _ := io.ReadAll(resp.Body)
    w.Write(data)
}
```

**Answer**:

The bug: **Response body is never closed**, causing goroutines and file descriptors to leak.

**Fix**:

```go
func handler(w http.ResponseWriter, r *http.Request) {
    resp, err := http.Get("https://api.example.com/data")
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }
    defer resp.Body.Close()  // ✓ MUST close body

    data, err := io.ReadAll(resp.Body)
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }

    w.Write(data)
}
```

**Why It Leaks**:

Without closing the body:
1. HTTP connection stays open
2. Goroutine waiting to read remains alive
3. File descriptor not released
4. Memory for buffer not freed

After 100s of requests, you'll see:
- `too many open files` error
- Memory usage climbing
- Goroutine count increasing

**Detection**:

```bash
# Check goroutines
curl localhost:6060/debug/pprof/goroutine?debug=1

# Check heap
go tool pprof http://localhost:6060/debug/pprof/heap
```

**Companies that asked this**: Google, Meta, Uber, Amazon

---

## Code Review Questions
