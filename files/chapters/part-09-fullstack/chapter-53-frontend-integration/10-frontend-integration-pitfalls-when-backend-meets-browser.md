## Frontend Integration Pitfalls: When Backend Meets Browser

### Pitfall 1: The CORS Credentials Confusion

**Incident Report**: Frontend team complained auth wasn't working. Cookies were being set by the server but never sent back. After 3 days of debugging, discovered CORS wasn't configured for credentials. The auth cookie existed in dev tools but was never attached to requests.

```go
// WRONG: Missing credentials support
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")  // Can't use * with credentials!
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
        // Missing: Access-Control-Allow-Credentials

        if r.Method == "OPTIONS" {
            w.WriteHeader(http.StatusOK)
            return
        }
        next.ServeHTTP(w, r)
    })
}

// CORRECT: Proper CORS with credentials
func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
    allowedMap := make(map[string]bool)
    for _, origin := range allowedOrigins {
        allowedMap[origin] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            // Must specify exact origin for credentials (not *)
            if allowedMap[origin] {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Credentials", "true")
            }

            w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID")
            w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID, X-RateLimit-Remaining")
            w.Header().Set("Access-Control-Max-Age", "86400")  // Cache preflight for 24h

            if r.Method == "OPTIONS" {
                w.WriteHeader(http.StatusNoContent)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// Frontend must also enable credentials
// fetch(url, { credentials: 'include' })
```

### Pitfall 2: The WebSocket Memory Leak Epidemic

**Incident Report**: Server memory grew by 500MB daily. Investigation revealed WebSocket connections weren't being cleaned up when clients disconnected ungracefully. Browser crashes, network changes, and mobile app backgrounding all left zombie connections consuming memory.

```go
// WRONG: No connection lifecycle management
type Hub struct {
    clients map[*Client]bool
    mu      sync.Mutex
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
    conn, _ := upgrader.Upgrade(w, r, nil)
    client := &Client{Conn: conn}

    h.mu.Lock()
    h.clients[client] = true
    h.mu.Unlock()

    // If this goroutine exits unexpectedly, client is never removed
    for {
        _, msg, err := conn.ReadMessage()
        if err != nil {
            break  // Connection broken, but client still in map!
        }
        h.broadcast(msg)
    }
}

// CORRECT: Proper connection lifecycle with cleanup
type Hub struct {
    clients    map[*Client]bool
    register   chan *Client
    unregister chan *Client
    broadcast  chan []byte
    mu         sync.RWMutex
}

func NewHub() *Hub {
    return &Hub{
        clients:    make(map[*Client]bool),
        register:   make(chan *Client),
        unregister: make(chan *Client),
        broadcast:  make(chan []byte, 256),
    }
}

func (h *Hub) Run(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return

        case client := <-h.register:
            h.mu.Lock()
            h.clients[client] = true
            h.mu.Unlock()
            log.Printf("Client connected: %s (total: %d)", client.ID, len(h.clients))

        case client := <-h.unregister:
            h.mu.Lock()
            if _, ok := h.clients[client]; ok {
                delete(h.clients, client)
                close(client.send)
            }
            h.mu.Unlock()
            log.Printf("Client disconnected: %s (total: %d)", client.ID, len(h.clients))

        case message := <-h.broadcast:
            h.mu.RLock()
            for client := range h.clients {
                select {
                case client.send <- message:
                default:
                    // Client not receiving - schedule for removal
                    go func(c *Client) {
                        h.unregister <- c
                    }(client)
                }
            }
            h.mu.RUnlock()

        case <-ticker.C:
            // Periodic cleanup of stale connections
            h.mu.RLock()
            for client := range h.clients {
                if time.Since(client.lastPong) > 60*time.Second {
                    go func(c *Client) {
                        h.unregister <- c
                        c.Conn.Close()
                    }(client)
                }
            }
            h.mu.RUnlock()
        }
    }
}

type Client struct {
    ID       string
    Conn     *websocket.Conn
    send     chan []byte
    hub      *Hub
    lastPong time.Time
}

func (c *Client) readPump() {
    defer func() {
        c.hub.unregister <- c
        c.Conn.Close()
    }()

    c.Conn.SetReadLimit(maxMessageSize)
    c.Conn.SetReadDeadline(time.Now().Add(pongWait))
    c.Conn.SetPongHandler(func(string) error {
        c.lastPong = time.Now()
        c.Conn.SetReadDeadline(time.Now().Add(pongWait))
        return nil
    })

    for {
        _, message, err := c.Conn.ReadMessage()
        if err != nil {
            if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
                log.Printf("WebSocket error: %v", err)
            }
            return  // Triggers deferred cleanup
        }
        c.hub.broadcast <- message
    }
}
```

### Pitfall 3: The SPA Routing 404 Nightmare

**Incident Report**: Users bookmarked app URLs like `/dashboard/projects/123`. When they refreshed the page, they got a 404. The server was looking for a file at that path instead of serving the SPA and letting the frontend router handle it.

```go
// WRONG: Simple static file serving breaks SPA routing
func main() {
    fs := http.FileServer(http.Dir("./static"))
    http.Handle("/", fs)  // /dashboard/projects/123 returns 404
    http.ListenAndServe(":8080", nil)
}

// CORRECT: SPA-aware static file serving with API routing
func spaHandler(staticDir, indexFile string) http.Handler {
    fs := http.Dir(staticDir)

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        path := r.URL.Path

        // Check if file exists
        file, err := fs.Open(path)
        if err == nil {
            defer file.Close()
            stat, _ := file.Stat()
            if !stat.IsDir() {
                // File exists - serve it
                http.ServeFile(w, r, filepath.Join(staticDir, path))
                return
            }
        }

        // Check if it's a static asset that should 404
        if isStaticAsset(path) {
            http.NotFound(w, r)
            return
        }

        // Serve index.html for SPA routing
        http.ServeFile(w, r, filepath.Join(staticDir, indexFile))
    })
}

func isStaticAsset(path string) bool {
    extensions := []string{".js", ".css", ".png", ".jpg", ".svg", ".ico", ".woff", ".woff2"}
    for _, ext := range extensions {
        if strings.HasSuffix(path, ext) {
            return true
        }
    }
    return false
}

func main() {
    mux := http.NewServeMux()

    // API routes take precedence
    mux.Handle("/api/", http.StripPrefix("/api", apiRouter()))

    // SPA handler for everything else
    mux.Handle("/", spaHandler("./static", "index.html"))

    http.ListenAndServe(":8080", mux)
}
```

### Pitfall 4: The SSE Connection Limit Catastrophe

**Incident Report**: Users on Chrome couldn't open multiple tabs of the app. After 6 tabs, new SSE connections hung. Chrome limits HTTP/1.1 connections to 6 per domain. Each SSE connection held one slot indefinitely.

```go
// WRONG: SSE over HTTP/1.1 with no connection management
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Connection stays open forever - consumes connection slot
    for {
        select {
        case <-r.Context().Done():
            return
        case event := <-s.events:
            fmt.Fprintf(w, "data: %s\n\n", event)
            flusher.Flush()
        }
    }
}

// CORRECT: SSE with HTTP/2, reconnection, and connection management
func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("X-Accel-Buffering", "no")  // Disable nginx buffering

    // Send retry interval for automatic reconnection
    fmt.Fprintf(w, "retry: 3000\n\n")
    flusher.Flush()

    // Get last event ID for resumption
    lastEventID := r.Header.Get("Last-Event-ID")
    if lastEventID != "" {
        // Send missed events since lastEventID
        missedEvents := s.getEventsSince(lastEventID)
        for _, event := range missedEvents {
            fmt.Fprintf(w, "id: %s\ndata: %s\n\n", event.ID, event.Data)
            flusher.Flush()
        }
    }

    // Subscribe this connection
    clientID := uuid.New().String()
    events := make(chan Event, 100)
    s.subscribe(clientID, events)
    defer s.unsubscribe(clientID)

    // Heartbeat to detect dead connections
    ticker := time.NewTicker(15 * time.Second)
    defer ticker.Stop()

    // Connection timeout to free up resources
    timeout := time.NewTimer(30 * time.Minute)
    defer timeout.Stop()

    for {
        select {
        case <-r.Context().Done():
            return

        case <-timeout.C:
            // Force reconnection to free resources
            fmt.Fprintf(w, "event: reconnect\ndata: timeout\n\n")
            flusher.Flush()
            return

        case <-ticker.C:
            // Heartbeat comment (ignored by EventSource)
            fmt.Fprintf(w, ": heartbeat\n\n")
            flusher.Flush()

        case event := <-events:
            fmt.Fprintf(w, "id: %s\n", event.ID)
            if event.Type != "" {
                fmt.Fprintf(w, "event: %s\n", event.Type)
            }
            fmt.Fprintf(w, "data: %s\n\n", event.Data)
            flusher.Flush()
        }
    }
}

// Run server with HTTP/2 (multiplexing avoids connection limit)
func main() {
    srv := &http.Server{
        Addr:    ":443",
        Handler: mux,
    }
    // HTTP/2 automatically enabled with TLS
    srv.ListenAndServeTLS("cert.pem", "key.pem")
}
```

### Pitfall 5: The JSON Response Inconsistency Chaos

**Incident Report**: Frontend kept crashing with "cannot read property of undefined". Backend returned errors as `{"error": "message"}` but success as raw data. Different endpoints used different structures. Frontend had to handle 5 different response formats.

```go
// WRONG: Inconsistent response formats
func getUserHandler(w http.ResponseWriter, r *http.Request) {
    user, err := getUser(r.Context())
    if err != nil {
        json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
        return
    }
    json.NewEncoder(w).Encode(user)  // Different structure
}

func listUsersHandler(w http.ResponseWriter, r *http.Request) {
    users, _ := listUsers(r.Context())
    json.NewEncoder(w).Encode(users)  // Array at root
}

func createUserHandler(w http.ResponseWriter, r *http.Request) {
    user, _ := createUser(r.Context())
    json.NewEncoder(w).Encode(map[string]any{
        "data":    user,
        "success": true,  // Yet another format
    })
}

// CORRECT: Consistent envelope for all responses
type APIResponse struct {
    Success bool        `json:"success"`
    Data    any `json:"data,omitempty"`
    Error   *APIError   `json:"error,omitempty"`
    Meta    *APIMeta    `json:"meta,omitempty"`
}

type APIError struct {
    Code    string            `json:"code"`
    Message string            `json:"message"`
    Details map[string]string `json:"details,omitempty"`
}

type APIMeta struct {
    Page       int `json:"page,omitempty"`
    PageSize   int `json:"page_size,omitempty"`
    TotalCount int `json:"total_count,omitempty"`
    TotalPages int `json:"total_pages,omitempty"`
}

func respondJSON(w http.ResponseWriter, status int, resp APIResponse) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(resp)
}

func respondSuccess(w http.ResponseWriter, data any) {
    respondJSON(w, http.StatusOK, APIResponse{
        Success: true,
        Data:    data,
    })
}

func respondError(w http.ResponseWriter, status int, code, message string) {
    respondJSON(w, status, APIResponse{
        Success: false,
        Error: &APIError{
            Code:    code,
            Message: message,
        },
    })
}

func respondPaginated(w http.ResponseWriter, data any, page, pageSize, total int) {
    respondJSON(w, http.StatusOK, APIResponse{
        Success: true,
        Data:    data,
        Meta: &APIMeta{
            Page:       page,
            PageSize:   pageSize,
            TotalCount: total,
            TotalPages: (total + pageSize - 1) / pageSize,
        },
    })
}

// All handlers now use consistent format
func getUserHandler(w http.ResponseWriter, r *http.Request) {
    user, err := getUser(r.Context())
    if err == ErrNotFound {
        respondError(w, 404, "USER_NOT_FOUND", "User not found")
        return
    }
    if err != nil {
        respondError(w, 500, "INTERNAL_ERROR", "Failed to fetch user")
        return
    }
    respondSuccess(w, user)
}
```

### Quick Reference: Frontend Integration Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| CORS credentials confusion | Cookies not sent | Specific origin, credentials: true |
| WebSocket memory leak | Server memory growth | Proper lifecycle, cleanup on disconnect |
| SPA routing 404 | Bookmarked URLs fail | Fallback to index.html for non-assets |
| SSE connection limit | Tabs hang after 6 | Use HTTP/2, connection timeout/heartbeat |
| Response inconsistency | Frontend crashes | Consistent API envelope structure |

### Junior -> FAANG: Turning Incident Reports Into Interview Stories

Each incident report in this section is a structure you can use in behavioral interviews. STAR format (Situation, Task, Action, Result) maps directly to the incident pattern: the situation is the symptom (cookies not sent, memory growing, URLs 404ing), the task is the debugging goal, the action is the root cause analysis and fix, and the result is the outcome.

For the CORS credentials incident: describe the three-day debugging session as a learning experience about browser security model versus server behavior. The key insight to convey is that the browser's CORS enforcement is a client-side security feature, not a server-side feature. The server ran perfectly. Only the browser rejected the response. This distinction matters because it affects where you look when debugging: always check the browser's DevTools Network tab, filter for OPTIONS requests, and read the response headers before checking any server-side code.

For the WebSocket memory leak incident: describe it in terms of the observability gap that allowed 500MB/day growth to go undetected. The fix is not just the code change but adding a `websocket_active_connections` gauge metric exposed at `/metrics`. An anomaly detection alert on this gauge (value outside 2 standard deviations of the rolling 1-hour average) would have caught the growth within hours. Mention the observability fix, not just the code fix, when telling this story.

For the SSE connection limit incident: Chrome's six-connection-per-domain limit for HTTP/1.1 is a historical constraint (HTTP/1.1 RFC recommended two, browsers raised it to six). The correct fix is HTTP/2 because multiplexing removes the limit. The production configuration required adding TLS to the Go server (HTTP/2 is only served over TLS in practice) and verifying the nginx proxy was configured for HTTP/2 upstream with `grpc_pass` or `proxy_http_version 1.1` replaced by an HTTP/2 upstream directive.

### Senior @ FAANG: Incident Prevention and Post-Mortem Thinking at Platform Level

The five incidents in this section are individually fixable with the code changes shown. At senior level, the question is why these incidents occurred and what process changes prevent the entire class of incidents from reaching production.

**CORS incident root cause: no integration environment.** The CORS credentials confusion lasted three days because developers tested backend and frontend in isolation. A shared integration environment (or even a Docker Compose setup that runs both services together) would have caught the CORS issue in the first hour. Platform teams at FAANG operate shared integration environments as a first-class infrastructure concern. Treat the absence of an integration environment as a risk in the project's technical design document, not as something to fix after the first incident.

**WebSocket memory leak root cause: no connection lifecycle contract.** The leak existed because there was no definition of "what does a healthy WebSocket server look like?" Without a definition, there is no alert. Without an alert, the leak grew for days. A connection lifecycle contract includes: expected connection count range, acceptable growth rate, maximum per-connection memory, and graceful shutdown behavior. Express this contract as SLOs (connection count within N, memory per connection below M MB) and implement alerts against those SLOs on day one of the feature, not after the first incident.

**SPA routing 404 root cause: no end-to-end smoke test.** The SPA routing failure only manifests when a user navigates directly to a deep link (bookmarked URL, link from an email). Local development with Vite masks this because Vite's dev server handles all routes. A single end-to-end smoke test (`GET /dashboard/projects/123` returns 200 with `Content-Type: text/html`) would catch this in CI before any deploy. Add SPA route smoke tests to the deployment verification suite for every service that serves a SPA.

**SSE connection limit root cause: no multi-tab test.** The connection limit failure is only visible when a user opens more than six tabs. A synthetic browser test that opens eight tabs and verifies all SSE connections establish would catch this. Playwright and Puppeteer both support running multiple browser contexts within a single test. This kind of test is rare in backend testing suites because backend engineers typically test with `curl` (one connection at a time). Investing in browser-based integration tests for real-time features is a platform-level decision, not something individual engineers can drive alone.

**Response inconsistency root cause: no API contract enforcement.** The inconsistency grew because handlers were written independently without a shared response utility. A single code review that required every new handler to use `respondJSON`, `respondError`, or `respondPaginated` before merging would have prevented it. This is a linting and review process problem, not a code problem. The technical fix is the shared utility. The process fix is a custom linter rule that detects direct `json.NewEncoder(w).Encode` calls in handler files and fails the CI build. Both fixes are required: the utility provides the correct path, the linter blocks the incorrect path.

---
