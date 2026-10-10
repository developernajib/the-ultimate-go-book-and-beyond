## 10C.36 Not Using io.LimitReader to Prevent Memory Bombs

When your HTTP handler reads the full request body with `io.ReadAll(r.Body)`, a malicious client can send a multi-gigabyte request that exhausts all available memory, crashing your server. This is a denial-of-service attack that requires zero authentication and zero cleverness.

### The Disaster

`io.ReadAll(r.Body)` reads until EOF with no size limit, allocating a buffer that grows with the request. An attacker sending a 10GB body with a valid `Content-Type` can exhaust all available heap memory, triggering an OOM kill and taking down the entire server with zero authentication required.

```go
package main

import (
    "encoding/json"
    "io"
    "log"
    "net/http"
)

type Payload struct {
    Name string `json:"name"`
    Data string `json:"data"`
}

// VULNERABLE: no limit on request body size, so the client picks your heap size
func handleUploadBroken(w http.ResponseWriter, r *http.Request) {
    // An attacker sends: curl -X POST -d @10gb_file.bin http://server/upload
    body, err := io.ReadAll(r.Body) // reads to EOF, and EOF is the client's call
    if err != nil {
        http.Error(w, "read error", http.StatusInternalServerError)
        return
    }
    defer r.Body.Close()

    var payload Payload
    if err := json.Unmarshal(body, &payload); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    w.WriteHeader(http.StatusOK)
}

// ALSO VULNERABLE: json.NewDecoder on raw body has no size limit
func handleDecodeBroken(w http.ResponseWriter, r *http.Request) {
    var payload Payload
    // No size limit - a 10GB JSON body will be read entirely
    if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }
    w.WriteHeader(http.StatusOK)
}

func main() {
    http.HandleFunc("/upload", handleUploadBroken)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Why It's Dangerous

- A single HTTP request can OOM the whole process, taking every in-flight request with it
- No authentication needed, and no skill. It is one `curl` flag.
- Concurrency multiplies it. Ten simultaneous 1GB requests need 10GB, so even a "reasonable" per-request size is not a bound on total memory.
- Even honest oversized payloads cause GC pressure and latency spikes long before they cause a crash
- The default `http.Server` has no request body size limit, and there is no field to set one. This is opt-in behavior that looks like a default.

### The Fix: Always Limit Input Size

Wrap every request body reader with a size limit before decoding. `http.MaxBytesReader` is preferred for HTTP handlers because it also closes the connection on overflow. `io.LimitReader` works for general `io.Reader` usage outside of HTTP.

```go
package main

import (
    "encoding/json"
    "errors"
    "io"
    "log"
    "net/http"
    "time"
)

const (
    maxBodySize = 1 << 20 // 1 MB, sized per endpoint rather than globally
)

type Payload struct {
    Name string `json:"name"`
    Data string `json:"data"`
}

// CORRECT Pattern 1: http.MaxBytesReader (preferred for HTTP handlers)
// Returns an error when the limit is exceeded AND closes the connection
func handleUploadSafe(w http.ResponseWriter, r *http.Request) {
    // MaxBytesReader wraps the body with a size limit.
    // If the client sends more than maxBodySize bytes, Read returns an error
    // AND the server closes the connection (preventing slow-read attacks).
    r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

    var payload Payload
    if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
        // Distinguish the two failures. Collapsing them into one 413 is a
        // real bug: it tells a client with a typo in their JSON that their
        // 200-byte request was too large, and they will believe you.
        // Since Go 1.19 MaxBytesReader returns a *http.MaxBytesError, so
        // there is no need to match on the error string.
        var maxErr *http.MaxBytesError
        if errors.As(err, &maxErr) {
            http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
            return
        }
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    w.WriteHeader(http.StatusOK)
}

// CORRECT Pattern 2: io.LimitReader (for general io.Reader, not just HTTP)
func handleUploadLimitReader(w http.ResponseWriter, r *http.Request) {
    defer r.Body.Close()

    // LimitReader caps the read at N bytes and then reports io.EOF. Note the
    // consequence: an oversized body is indistinguishable from a body that
    // simply ended, so a truncated JSON document just looks like invalid
    // JSON. Reading maxBodySize+1 is what makes overflow detectable, since
    // len(body) > maxBodySize can only happen if there was more to come.
    //
    // LimitReader also does not close anything. The attacker's connection
    // stays open and keeps sending. That is why MaxBytesReader is the right
    // tool inside an HTTP handler, and this one is for plain io.Readers.
    limitedReader := io.LimitReader(r.Body, maxBodySize+1)

    body, err := io.ReadAll(limitedReader)
    if err != nil {
        http.Error(w, "read error", http.StatusInternalServerError)
        return
    }

    // Check if we hit the limit
    if int64(len(body)) > maxBodySize {
        http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
        return
    }

    var payload Payload
    if err := json.Unmarshal(body, &payload); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    w.WriteHeader(http.StatusOK)
}

// CORRECT Pattern 3: apply the limit once, as middleware.
// http.MaxBytesHandler (Go 1.18+) wraps a handler and does the
// MaxBytesReader call for you, so no individual handler can forget.
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/upload", handleUploadSafe)
    mux.HandleFunc("/upload2", handleUploadLimitReader)

    server := &http.Server{
        Addr: ":8080",
        // Every route gets the cap, whether or not its handler asked.
        Handler:        http.MaxBytesHandler(mux, maxBodySize),
        MaxHeaderBytes: 1 << 20, // caps headers, which is a separate budget
        // There is no MaxBodyBytes field. The body limit only exists where
        // you put it: a handler, or a wrapper like the one above.

        // Size is not the only exhaustion axis. A slowloris client sends
        // one byte per minute and never trips a byte limit at all, so the
        // timeouts are part of the same defense.
        ReadHeaderTimeout: 5 * time.Second,
        ReadTimeout:       30 * time.Second,
        WriteTimeout:      30 * time.Second,
        IdleTimeout:       120 * time.Second,
    }

    log.Fatal(server.ListenAndServe())
}
```

**The Rule:** Never call `io.ReadAll(r.Body)` or `json.NewDecoder(r.Body)` without a size limit. Use `http.MaxBytesReader` for HTTP handlers (preferred, it closes the connection) or `io.LimitReader` for general IO. Apply this to every endpoint as a middleware or per-handler guard.

---
