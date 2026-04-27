export default `## 10C.36 Not Using io.LimitReader to Prevent Memory Bombs

When your HTTP handler reads the full request body with \`io.ReadAll(r.Body)\`, a malicious client can send a multi-gigabyte request that exhausts all available memory, crashing your server. This is a denial-of-service attack that requires zero authentication and zero cleverness.

### The Disaster

\`io.ReadAll(r.Body)\` reads until EOF with no size limit, allocating a buffer that grows with the request. An attacker sending a 10GB body with a valid \`Content-Type\` can exhaust all available heap memory, triggering an OOM kill and taking down the entire server with zero authentication required.

\`\`\`go
package main

import (
    "encoding/json"
    "io"
    "log"
    "net/http"
)

type Payload struct {
    Name string \`json:"name"\`
    Data string \`json:"data"\`
}

// VULNERABLE: No limit on request body size - OOM crash with a large request
func handleUploadBroken(w http.ResponseWriter, r *http.Request) {
    // An attacker sends: curl -X POST -d @10gb_file.bin http://server/upload
    body, err := io.ReadAll(r.Body) // reads ALL bytes into memory - 10GB allocation!
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
\`\`\`

### Why It's Dangerous

- A single HTTP request can crash the entire server
- No authentication needed, anyone can send a large body
- Cloud servers with auto-scaling can run up enormous bills before crashing
- Even moderate-sized unexpected payloads (100MB) can cause latency spikes
- The default \`http.Server\` has no request body size limit

### The Fix: Always Limit Input Size

Wrap every request body reader with a size limit before decoding. \`http.MaxBytesReader\` is preferred for HTTP handlers because it also closes the connection on overflow. \`io.LimitReader\` works for general \`io.Reader\` usage outside of HTTP.

\`\`\`go
package main

import (
    "encoding/json"
    "io"
    "log"
    "net/http"
)

const (
    maxBodySize = 1 << 20 // 1 MB - adjust based on your endpoint's needs
)

type Payload struct {
    Name string \`json:"name"\`
    Data string \`json:"data"\`
}

// CORRECT Pattern 1: http.MaxBytesReader (preferred for HTTP handlers)
// Returns an error when the limit is exceeded AND closes the connection
func handleUploadSafe(w http.ResponseWriter, r *http.Request) {
    // MaxBytesReader wraps the body with a size limit.
    // If the client sends more than maxBodySize bytes, Read returns an error
    // AND the server closes the connection (preventing slow-read attacks).
    r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
    defer r.Body.Close()

    var payload Payload
    if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
        // If body exceeds limit: "http: request body too large"
        http.Error(w, "request too large or invalid JSON", http.StatusRequestEntityTooLarge)
        return
    }

    w.WriteHeader(http.StatusOK)
}

// CORRECT Pattern 2: io.LimitReader (for general io.Reader, not just HTTP)
func handleUploadLimitReader(w http.ResponseWriter, r *http.Request) {
    defer r.Body.Close()

    // LimitReader wraps the reader to read at most maxBodySize bytes
    // After the limit, it returns io.EOF - does NOT close the connection
    limitedReader := io.LimitReader(r.Body, maxBodySize+1) // +1 to detect overflow

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

// CORRECT Pattern 3: Server-level limit (defense in depth)
func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/upload", handleUploadSafe)
    mux.HandleFunc("/upload2", handleUploadLimitReader)

    server := &http.Server{
        Addr:           ":8080",
        Handler:        mux,
        MaxHeaderBytes: 1 << 20, // 1 MB limit on headers
        // Note: there is no built-in MaxBodyBytes - you must use
        // MaxBytesReader in each handler or middleware
    }

    log.Fatal(server.ListenAndServe())
}
\`\`\`

**The Rule:** Never call \`io.ReadAll(r.Body)\` or \`json.NewDecoder(r.Body)\` without a size limit. Use \`http.MaxBytesReader\` for HTTP handlers (preferred, it closes the connection) or \`io.LimitReader\` for general IO. Apply this to every endpoint as a middleware or per-handler guard.

---
`;
