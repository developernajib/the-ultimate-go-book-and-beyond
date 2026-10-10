## Common Mistakes

### Mistake 1: CORS Misconfiguration Allowing All Origins with Credentials

Combining `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` is rejected by browsers and is also a serious security mistake. It would allow any origin to make credentialed cross-site requests if a browser accepted it. The fix is to echo back the specific request origin only after validating it against an allowlist, and never use the wildcard when credentials are involved. The comparison below contrasts the broken pattern with the correct origin-reflection approach.

```go
// ❌ Bad: Allowing credentials with wildcard origin
func BadCORS(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // This is DANGEROUS - browsers will block this anyway
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Credentials", "true") // Won't work!

        next.ServeHTTP(w, r)
    })
}

// Also bad: Reflecting any origin without validation
func ReflectingCORS(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        origin := r.Header.Get("Origin")
        // Blindly reflecting origin is a security vulnerability
        w.Header().Set("Access-Control-Allow-Origin", origin)
        w.Header().Set("Access-Control-Allow-Credentials", "true")
        next.ServeHTTP(w, r)
    })
}

// ✅ Good: Validate against allowlist
type SecureCORS struct {
    allowedOrigins map[string]bool
    allowedMethods []string
    allowedHeaders []string
}

func NewSecureCORS(origins []string) *SecureCORS {
    allowed := make(map[string]bool)
    for _, o := range origins {
        allowed[o] = true
    }
    return &SecureCORS{
        allowedOrigins: allowed,
        allowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        allowedHeaders: []string{"Authorization", "Content-Type", "X-Request-ID"},
    }
}

func (c *SecureCORS) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        origin := r.Header.Get("Origin")

        // Only allow origins in our list
        if c.allowedOrigins[origin] {
            w.Header().Set("Access-Control-Allow-Origin", origin)
            w.Header().Set("Access-Control-Allow-Credentials", "true")
            w.Header().Set("Vary", "Origin") // Important for caching
        }

        // Handle preflight
        if r.Method == "OPTIONS" {
            w.Header().Set("Access-Control-Allow-Methods", strings.Join(c.allowedMethods, ", "))
            w.Header().Set("Access-Control-Allow-Headers", strings.Join(c.allowedHeaders, ", "))
            w.Header().Set("Access-Control-Max-Age", "86400")
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Mistake 2: Not Handling SPA Client-Side Routing

When a Go server serves a SPA, returning a 404 for any path not matching a physical file breaks browser refreshes and direct links to frontend routes. The correct behavior is to detect that a path belongs to the SPA router (not a static asset or API route) and return `index.html` so the client-side router can render the right view. The fix below adds a catch-all fallback that distinguishes API prefixes and file extensions from SPA navigation paths.

```go
// ❌ Bad: Standard file server returns 404 for SPA routes
func BadSPAServer() http.Handler {
    return http.FileServer(http.Dir("./dist"))
    // /app/users/123 returns 404 because file doesn't exist
}

// ✅ Good: Fallback to index.html for SPA routes
func GoodSPAServer(distDir string) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := filepath.Join(distDir, r.URL.Path)

        // Check if file exists
        stat, err := os.Stat(path)
        if err == nil && !stat.IsDir() {
            // Serve the file
            http.ServeFile(w, r, path)
            return
        }

        // Don't serve index.html for API routes
        if strings.HasPrefix(r.URL.Path, "/api/") {
            http.NotFound(w, r)
            return
        }

        // Don't serve index.html for static assets that are missing
        ext := filepath.Ext(r.URL.Path)
        staticExts := map[string]bool{
            ".js": true, ".css": true, ".png": true, ".jpg": true,
            ".svg": true, ".ico": true, ".woff": true, ".woff2": true,
        }
        if staticExts[ext] {
            http.NotFound(w, r)
            return
        }

        // Serve index.html for SPA routes
        indexPath := filepath.Join(distDir, "index.html")

        // Set proper cache headers for HTML
        w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

        http.ServeFile(w, r, indexPath)
    })
}
```

### Mistake 3: WebSocket Memory Leaks from Unclean Disconnects

A WebSocket hub that doesn't detect and remove stale clients will accumulate goroutines and channel references indefinitely as users disconnect. The pattern of sending to a closed channel or writing to a broken connection panics unless the hub uses non-blocking sends with a dead-client detection path. The corrected hub below wraps sends in a `select` with a `default` case that triggers deregistration when the client's buffer is full or the connection is gone.

```go
// ❌ Bad: Not properly cleaning up connections
type BadWSServer struct {
    clients map[*websocket.Conn]bool
}

func (s *BadWSServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, _ := upgrader.Upgrade(w, r, nil)
    s.clients[conn] = true // Added but never removed!

    for {
        _, msg, err := conn.ReadMessage()
        if err != nil {
            break // Connection lost, but client still in map
        }
        s.broadcast(msg)
    }
    // conn is closed but still in s.clients = memory leak
}

// ✅ Good: Proper cleanup with defer and channels
type GoodWSServer struct {
    clients    map[*Client]bool
    register   chan *Client
    unregister chan *Client
    mu         sync.RWMutex
}

type Client struct {
    conn   *websocket.Conn
    send   chan []byte
    server *GoodWSServer
}

func (s *GoodWSServer) Run() {
    for {
        select {
        case client := <-s.register:
            s.mu.Lock()
            s.clients[client] = true
            s.mu.Unlock()

        case client := <-s.unregister:
            s.mu.Lock()
            if _, ok := s.clients[client]; ok {
                delete(s.clients, client)
                close(client.send) // Close send channel
            }
            s.mu.Unlock()
        }
    }
}

func (s *GoodWSServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }

    client := &Client{
        conn:   conn,
        send:   make(chan []byte, 256),
        server: s,
    }

    s.register <- client

    // Ensure cleanup on any exit path
    defer func() {
        s.unregister <- client
        conn.Close()
    }()

    go client.writePump()
    client.readPump() // Blocking
}
```

### Mistake 4: Not Setting Proper Cache Headers for Static Assets

Serving all static files without cache headers forces the browser to revalidate every asset on each navigation, adding avoidable round trips on every page load. Content-hashed filenames (e.g., `main.abc123.js`) allow a one-year `max-age` because the URL changes when content changes, while HTML entry points should always use `no-cache` to ensure users get the latest app shell. The middleware below inspects the file extension and path to apply the appropriate cache policy.

```go
// ❌ Bad: Same cache policy for all files
func BadCaching(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Cache-Control", "public, max-age=31536000")
        next.ServeHTTP(w, r)
        // Problem: HTML files cached forever, users never see updates
    })
}

// ✅ Good: Different policies based on file type and naming
func GoodCaching(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := r.URL.Path
        ext := filepath.Ext(path)

        switch {
        case ext == ".html":
            // Never cache HTML - always check for updates
            w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

        case isHashedAsset(path):
            // Hashed assets (main.abc123.js) are immutable
            w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

        case ext == ".js" || ext == ".css":
            // Non-hashed JS/CSS - short cache with revalidation
            w.Header().Set("Cache-Control", "public, max-age=86400, must-revalidate")

        case ext == ".png" || ext == ".jpg" || ext == ".svg":
            // Images - medium cache
            w.Header().Set("Cache-Control", "public, max-age=604800")

        default:
            // Everything else
            w.Header().Set("Cache-Control", "public, max-age=86400")
        }

        // Add ETag for conditional requests
        if stat, err := os.Stat(filepath.Join("dist", path)); err == nil {
            etag := generateETag(path, stat.ModTime())
            w.Header().Set("ETag", etag)

            // Check If-None-Match
            if r.Header.Get("If-None-Match") == etag {
                w.WriteHeader(http.StatusNotModified)
                return
            }
        }

        next.ServeHTTP(w, r)
    })
}

func isHashedAsset(path string) bool {
    // Match patterns like: main.abc12345.js, chunk-vendors.9f8e7d.css
    re := regexp.MustCompile(`\.[a-f0-9]{8,}\.(js|css)$`)
    return re.MatchString(path)
}
```

### Mistake 5: Blocking SSE Event Loop


Performing synchronous database queries or slow computations inside the SSE handler goroutine blocks the entire event stream for that client and can cascade to starve other connections if a thread pool is exhausted. The correct approach is to decouple event production (database polling, pub/sub subscription) from event delivery by using a buffered channel, allowing the SSE write loop to remain non-blocking. The fixed handler below delegates data fetching to a background goroutine and forwards results through a per-connection channel.

```go
// ❌ Bad: Blocking operations in SSE handler
func BadSSEHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/event-stream")
    flusher := w.(http.Flusher)

    for {
        // Database query blocks the event loop
        data, _ := db.QueryContext(r.Context(), "SELECT * FROM events LIMIT 1")

        // If database is slow, client doesn't receive heartbeats
        fmt.Fprintf(w, "data: %s\n\n", data)
        flusher.Flush()

        time.Sleep(time.Second) // Fixed interval regardless of processing time
    }
}

// ✅ Good: Non-blocking event loop with proper channel usage
func GoodSSEHandler(eventStream <-chan Event) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "text/event-stream")
        w.Header().Set("Cache-Control", "no-cache")
        w.Header().Set("Connection", "keep-alive")
        w.Header().Set("X-Accel-Buffering", "no")

        flusher, ok := w.(http.Flusher)
        if !ok {
            http.Error(w, "SSE not supported", http.StatusInternalServerError)
            return
        }

        // Heartbeat ticker - keeps connection alive
        heartbeat := time.NewTicker(15 * time.Second)
        defer heartbeat.Stop()

        ctx := r.Context()

        for {
            select {
            case <-ctx.Done():
                return

            case event, ok := <-eventStream:
                if !ok {
                    return
                }
                data, _ := json.Marshal(event)
                fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
                flusher.Flush()

            case <-heartbeat.C:
                // Send comment as heartbeat (doesn't trigger onmessage)
                fmt.Fprintf(w, ": heartbeat\n\n")
                flusher.Flush()
            }
        }
    })
}
```

### Junior -> FAANG: Recognizing These Mistakes in Code Review

The five mistakes in this section follow a pattern: each one works in a local dev environment and fails in production. The CORS credentials confusion works locally if the frontend and backend share `localhost`. The SPA 404 is invisible in development because Vite's dev server handles all routing. The WebSocket memory leak takes hours to days to manifest. Cache header problems are only visible after a CDN deployment. The SSE blocking is invisible when there is low event volume.

Code review habits that catch these: (1) any `Access-Control-Allow-Origin: *` combined with a search for `credentials` in the same middleware deserves scrutiny, (2) any `http.FileServer` serving an SPA without a 404 fallback is wrong, (3) any WebSocket hub that writes to connections outside the hub goroutine or without checking channel closure is a potential panic, (4) any static file server without per-extension cache headers is an oversight, (5) any SSE handler that calls a database directly in the event loop has a scaling problem.

Build a mental checklist for each pattern category: CORS, static serving, WebSocket lifecycle, caching, SSE I/O. Run through the checklist when reviewing any file that touches these patterns.

### Senior @ FAANG: Systematic Mistake Prevention Through Platform Defaults

The most effective way to prevent these mistakes at scale is to make the correct behavior the path of least resistance. Engineers copy examples from internal wikis and existing code. If the example is wrong, the mistake propagates. If the platform default is correct, most engineers will use it correctly without knowing the details.

**CORS: provide a shared library, not documentation.** Instead of documenting that origin reflection requires an allowlist, provide a `platform/cors` package with `New(allowedOrigins []string) Middleware`. The constructor validates that the list is non-empty, panics if `*` is in the list alongside other origins (which indicates misconfiguration), and sets `Vary: Origin` automatically. Engineers who use the package cannot make the credential/wildcard mistake because the package enforces the constraint. Engineers who bypass the package are visible in code review.

**WebSocket: enforce lifecycle through abstraction.** Provide a `platform/ws` package with a `Hub` that is already implemented correctly: register/unregister channels, non-blocking send with dead-client detection, ping/pong heartbeat, and graceful shutdown. Expose only `NewHub()`, `Hub.Run(ctx)`, `Hub.HandleUpgrade(w, r)`, and `Hub.Broadcast(room, payload)`. Engineers using this package cannot make the goroutine leak mistake because the lifecycle is managed internally. The implementation details are hidden. This is Interface Segregation applied at the platform level.

**Caching: embed the policy in the asset pipeline.** Cache header mistakes happen because the header must be set at serve time but the correct value depends on whether the filename contains a content hash, which is a build-time property. The correct fix is to generate a `cache-manifest.json` at build time that maps each file path to its cache policy (`immutable`, `no-cache`, or a specific `max-age`). The Go server reads this manifest at startup and applies the pre-computed policy per file. Engineers do not need to understand cache header semantics because the build tool makes the decision.

**SSE: separate the event production interface from the HTTP handler.** The blocking SSE mistake occurs when engineers put I/O inside the handler. Enforce the separation by making the handler accept only `<-chan Event` as input. The channel must be pre-populated by a separate goroutine. The handler's only job is to drain the channel and write to the `ResponseWriter`. If engineers must construct the `<-chan Event` before calling the handler, they are forced to think about the event production lifecycle separately from the HTTP handler. This architectural constraint eliminates the mistake class at the interface level.

**Mistake detection in CI.** Add linters or custom `go vet` rules that flag: (1) direct `http.FileServer` usage without a search for `index.html` fallback in the same file, (2) `websocket.Conn.WriteMessage` calls outside a `writePump` pattern (any write from a goroutine that also reads is a concurrent write race), (3) `fmt.Fprintf` to a `http.ResponseWriter` inside a `select` without a preceding `flusher.Flush` call check. Automated detection is more reliable than code review for these structural patterns.

---
