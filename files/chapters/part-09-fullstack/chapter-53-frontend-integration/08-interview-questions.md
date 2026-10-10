## Interview Questions

### Question 1: How do you handle authentication with WebSockets in a SPA?

**What FAANG expects:** Know that `new WebSocket()` in the browser has no `headers` option, so `Authorization: Bearer` cannot be set on the upgrade request. List the three real options (query param, post-upgrade auth message, same-origin cookie) and the trade-offs (tokens in server access logs, auth-timeout window, CSRF posture for cookie auth). Bonus for mentioning `Sec-WebSocket-Protocol` as a quiet channel to smuggle the token.

**Answer:**

WebSocket authentication requires a different approach than HTTP because you can't send headers with the initial connection in browsers:

```go
// Strategy 1: Token in query string (simple, but token visible in logs)
func AuthenticateFromQuery(r *http.Request) (*User, error) {
    token := r.URL.Query().Get("token")
    if token == "" {
        return nil, ErrNoToken
    }
    return validateJWT(token)
}

// Strategy 2: Send auth message after connection (more secure)
type AuthenticatedWSServer struct {
    upgrader websocket.Upgrader
    timeout  time.Duration
}

func (s *AuthenticatedWSServer) HandleConnection(w http.ResponseWriter, r *http.Request) {
    conn, err := s.upgrader.Upgrade(w, r, nil)
    if err != nil {
        return
    }
    defer conn.Close()

    // Set deadline for auth message
    conn.SetReadDeadline(time.Now().Add(s.timeout))

    // Wait for auth message
    var authMsg struct {
        Type  string `json:"type"`
        Token string `json:"token"`
    }

    if err := conn.ReadJSON(&authMsg); err != nil {
        conn.WriteJSON(map[string]string{"error": "auth_timeout"})
        return
    }

    if authMsg.Type != "auth" {
        conn.WriteJSON(map[string]string{"error": "expected_auth"})
        return
    }

    user, err := validateJWT(authMsg.Token)
    if err != nil {
        conn.WriteJSON(map[string]string{"error": "invalid_token"})
        return
    }

    // Auth successful - remove deadline
    conn.SetReadDeadline(time.Time{})

    // Send auth success
    conn.WriteJSON(map[string]any{
        "type": "auth_success",
        "user": user,
    })

    // Continue with authenticated session
    s.handleAuthenticatedSession(conn, user)
}

// Strategy 3: Cookie-based (same-origin only)
func AuthenticateFromCookie(r *http.Request) (*User, error) {
    cookie, err := r.Cookie("session")
    if err != nil {
        return nil, ErrNoCookie
    }
    return validateSession(cookie.Value)
}

// Frontend implementation (TypeScript)
/*
const connect = async () => {
    const ws = new WebSocket('wss://api.example.com/ws');

    ws.onopen = () => {
        // Send auth message immediately after connection
        ws.send(JSON.stringify({
            type: 'auth',
            token: localStorage.getItem('access_token')
        }));
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_success') {
            console.log('Authenticated as:', msg.user);
        } else if (msg.error) {
            // Handle auth failure
            ws.close();
            redirectToLogin();
        }
    };
};
*/
```

Best practices:
1. Use TLS (wss://) to protect tokens in transit
2. Implement token refresh over WebSocket
3. Set connection timeout for auth
4. Close connections that fail authentication

**Follow-ups:**
- *Why is a token in the query string considered a bad option?* Query strings land in access logs, proxies, and browser history. Rotating the token on every connect reduces exposure but does not eliminate it.
- *How do you refresh an expired token on an open WebSocket?* Send a refresh message over the existing connection before expiry, validate the new token server-side, and swap the session's claims. Never close and reconnect just to rotate.
- *What is the `Sec-WebSocket-Protocol` trick?* Browsers let you pass subprotocols on the upgrade request. Encode the token there and the server echoes back the selected subprotocol. Cleaner than query strings, invisible to most log formats.

---

### Question 2: How would you implement real-time updates for a dashboard?

**What FAANG expects:** Pick the transport that fits the shape of the data. SSE wins for one-way server-to-client streams because it auto-reconnects, carries `Last-Event-ID`, and runs over plain HTTP with no upgrade dance. WebSocket wins when the client also pushes. Bonus for calling out backpressure (the `default` branch on buffered send) and the heartbeat comment channel (`: ping\n\n`) for intermediaries that idle-close idle HTTP connections.

**Answer:**

I'd use SSE for server→client updates (simpler) or WebSocket for bidirectional:

```go
// Dashboard real-time updates with SSE
type DashboardUpdater struct {
    subscribers map[string]chan *DashboardEvent // userID -> channel
    mu          sync.RWMutex
}

type DashboardEvent struct {
    Type    string      `json:"type"`
    Widget  string      `json:"widget"`
    Data    any `json:"data"`
    Version int64       `json:"version"` // For conflict resolution
}

func (d *DashboardUpdater) Subscribe(userID string) (<-chan *DashboardEvent, func()) {
    ch := make(chan *DashboardEvent, 100)

    d.mu.Lock()
    d.subscribers[userID] = ch
    d.mu.Unlock()

    unsubscribe := func() {
        d.mu.Lock()
        delete(d.subscribers, userID)
        close(ch)
        d.mu.Unlock()
    }

    return ch, unsubscribe
}

func (d *DashboardUpdater) PublishToUser(userID string, event *DashboardEvent) {
    d.mu.RLock()
    ch, ok := d.subscribers[userID]
    d.mu.RUnlock()

    if ok {
        select {
        case ch <- event:
        default:
            // Buffer full - client too slow
        }
    }
}

// HTTP handler for SSE
func (d *DashboardUpdater) HandleSSE(w http.ResponseWriter, r *http.Request) {
    userID := getUserFromContext(r.Context())

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    flusher := w.(http.Flusher)
    events, unsubscribe := d.Subscribe(userID)
    defer unsubscribe()

    // Send initial dashboard state
    state := d.loadDashboardState(userID)
    data, _ := json.Marshal(state)
    fmt.Fprintf(w, "event: init\ndata: %s\n\n", data)
    flusher.Flush()

    heartbeat := time.NewTicker(30 * time.Second)
    defer heartbeat.Stop()

    for {
        select {
        case <-r.Context().Done():
            return
        case event := <-events:
            data, _ := json.Marshal(event)
            fmt.Fprintf(w, "event: update\nid: %d\ndata: %s\n\n",
                event.Version, data)
            flusher.Flush()
        case <-heartbeat.C:
            fmt.Fprintf(w, ": ping\n\n")
            flusher.Flush()
        }
    }
}

// Usage from other services
func (s *OrderService) CreateOrder(ctx context.Context, order *Order) error {
    if err := s.db.Create(order); err != nil {
        return err
    }

    // Push real-time update to dashboard
    s.dashboardUpdater.PublishToUser(order.UserID, &DashboardEvent{
        Type:    "order_created",
        Widget:  "recent_orders",
        Data:    order,
        Version: time.Now().UnixMilli(),
    })

    return nil
}
```

**Follow-ups:**
- *Client dropped the connection mid-stream, how do you avoid sending the same update twice?* SSE `id:` field plus `Last-Event-ID` on reconnect. Server replays events newer than the last ID from a bounded buffer (in-memory ring, Redis Stream, or Postgres LISTEN/NOTIFY with a sequence).
- *What happens when a dashboard user opens five tabs?* Each SSE connection gets its own subscriber entry. With per-user channels, you fan out once per user but every tab receives a copy. Use a per-tab `connectionID` if you need targeted delivery.
- *Why not just poll every 3 seconds?* Polling adds latency (half the interval on average), wastes capacity at scale (10k users = 3333 RPS baseline), and misses sub-interval updates. Fine for a status page, not for a trading dashboard.

---

### Question 3: How do you handle file uploads with progress reporting?

**What FAANG expects:** Split the channels. Upload is a standard `POST multipart/form-data`, and progress is a separate SSE stream keyed by an `uploadID`. A progress-tracking `io.Reader` wraps each part and publishes deltas to a channel consumed by the SSE endpoint. Bonus for recognizing that the *browser* already knows its own upload progress via `XMLHttpRequest.upload.onprogress` or `fetch` with a `TransformStream`, so the server-side SSE approach is useful when progress depends on post-receive processing (virus scan, thumbnailing, transcoding).

**Answer:**

File upload progress requires two coordinated channels: the upload itself (a standard multipart POST) and a separate SSE connection that streams progress events to the client. The server wraps the multipart reader in a progress-tracking `io.Reader` that reports bytes read to a per-upload channel. A separate SSE endpoint subscribes to that channel and pushes percentage updates to the browser in real time.

```go
// File upload with progress via SSE
type UploadManager struct {
    progress map[string]chan *UploadProgress
    mu       sync.RWMutex
}

type UploadProgress struct {
    UploadID   string  `json:"upload_id"`
    Filename   string  `json:"filename"`
    BytesSent  int64   `json:"bytes_sent"`
    TotalBytes int64   `json:"total_bytes"`
    Percent    float64 `json:"percent"`
    Status     string  `json:"status"` // uploading, processing, complete, error
    Error      string  `json:"error,omitempty"`
}

func (m *UploadManager) HandleUpload(w http.ResponseWriter, r *http.Request) {
    uploadID := generateUploadID()

    // Create progress channel
    progressChan := make(chan *UploadProgress, 10)
    m.mu.Lock()
    m.progress[uploadID] = progressChan
    m.mu.Unlock()

    defer func() {
        m.mu.Lock()
        delete(m.progress, uploadID)
        close(progressChan)
        m.mu.Unlock()
    }()

    // Return upload ID immediately
    w.Header().Set("X-Upload-ID", uploadID)

    // Parse multipart form
    reader, err := r.MultipartReader()
    if err != nil {
        http.Error(w, "Invalid multipart", http.StatusBadRequest)
        return
    }

    for {
        part, err := reader.NextPart()
        if err == io.EOF {
            break
        }
        if err != nil {
            return
        }

        if part.FormName() != "file" {
            continue
        }

        filename := part.FileName()
        totalSize := r.ContentLength

        // Create progress-tracking reader
        pr := &progressReader{
            reader:   part,
            total:    totalSize,
            uploadID: uploadID,
            filename: filename,
            progress: progressChan,
        }

        // Save file
        dst, err := os.Create(filepath.Join("uploads", filename))
        if err != nil {
            m.sendProgress(uploadID, &UploadProgress{
                UploadID: uploadID,
                Status:   "error",
                Error:    err.Error(),
            })
            return
        }

        _, err = io.Copy(dst, pr)
        dst.Close()

        if err != nil {
            m.sendProgress(uploadID, &UploadProgress{
                UploadID: uploadID,
                Status:   "error",
                Error:    err.Error(),
            })
            return
        }

        // Processing phase
        m.sendProgress(uploadID, &UploadProgress{
            UploadID:   uploadID,
            Filename:   filename,
            BytesSent:  totalSize,
            TotalBytes: totalSize,
            Percent:    100,
            Status:     "processing",
        })

        // Process file (virus scan, thumbnails, etc.)
        time.Sleep(time.Second) // Simulate processing

        // Complete
        m.sendProgress(uploadID, &UploadProgress{
            UploadID: uploadID,
            Filename: filename,
            Status:   "complete",
        })
    }

    json.NewEncoder(w).Encode(map[string]string{
        "upload_id": uploadID,
        "status":    "complete",
    })
}

type progressReader struct {
    reader   io.Reader
    total    int64
    read     int64
    uploadID string
    filename string
    progress chan<- *UploadProgress
    lastReport time.Time
}

func (pr *progressReader) Read(p []byte) (n int, err error) {
    n, err = pr.reader.Read(p)
    pr.read += int64(n)

    // Report progress every 100ms
    if time.Since(pr.lastReport) > 100*time.Millisecond {
        percent := float64(pr.read) / float64(pr.total) * 100
        pr.progress <- &UploadProgress{
            UploadID:   pr.uploadID,
            Filename:   pr.filename,
            BytesSent:  pr.read,
            TotalBytes: pr.total,
            Percent:    percent,
            Status:     "uploading",
        }
        pr.lastReport = time.Now()
    }

    return n, err
}

// SSE endpoint for progress
func (m *UploadManager) HandleProgressSSE(w http.ResponseWriter, r *http.Request) {
    uploadID := r.URL.Query().Get("upload_id")

    m.mu.RLock()
    progressChan, ok := m.progress[uploadID]
    m.mu.RUnlock()

    if !ok {
        http.Error(w, "Upload not found", http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    flusher := w.(http.Flusher)

    for progress := range progressChan {
        data, _ := json.Marshal(progress)
        fmt.Fprintf(w, "data: %s\n\n", data)
        flusher.Flush()

        if progress.Status == "complete" || progress.Status == "error" {
            return
        }
    }
}
```

**Follow-ups:**
- *What about resumable uploads for large files?* Use the `tus` protocol (IETF draft, widely implemented) or presigned S3 multipart uploads. Client uploads in chunks with `Upload-Offset`, and resume picks up where it left off. Temporary state survives crashes on either side.
- *Why not return progress inline on the upload response?* HTTP is request-response. Chunked transfer-encoding + NDJSON works in theory, but browsers and proxies often buffer it, defeating the point. A side-channel SSE stream is simpler and reliable.
- *Is the 100ms throttle arbitrary?* Yes, pick something matching your target frame budget. 100ms = 10 updates/sec feels smooth without saturating the channel. On a 10GB upload that is still 600 events at 60MB/s.

---

### Question 4: How do you design APIs that work well with React Query/RTK Query?

**What FAANG expects:** Four concrete principles: (1) return the full updated entity on mutations so the client can splice it into the cache without a refetch, (2) version numbers or ETags so optimistic updates can detect conflicts, (3) cursor pagination for infinite-scroll UIs because offsets shift under concurrent writes, (4) stable `cacheKey` semantics so the client can invalidate surgically. Bonus for referencing RTK Query's `providesTags`/`invalidatesTags` model and RFC 7232 ETag semantics.

**Answer:**

Frontend data libraries like RTK Query and TanStack Query work best with APIs that provide consistent response envelopes, ETag-based conditional requests, and version numbers for optimistic update conflict detection. The API should return the full updated entity on mutations so the client can update its cache without a refetch. Cursor-based pagination works better than offset-based for infinite scroll UIs because inserting or deleting items doesn't shift page boundaries.

```go
// API design optimized for frontend data libraries
type APIResponse struct {
    Data any `json:"data"`
    Meta *Meta       `json:"meta,omitempty"`
}

type Meta struct {
    // Pagination
    Page       int    `json:"page,omitempty"`
    PerPage    int    `json:"per_page,omitempty"`
    Total      int    `json:"total,omitempty"`
    TotalPages int    `json:"total_pages,omitempty"`
    HasMore    bool   `json:"has_more,omitempty"`

    // Cursor-based pagination (better for infinite scroll)
    NextCursor string `json:"next_cursor,omitempty"`
    PrevCursor string `json:"prev_cursor,omitempty"`

    // Cache control
    CacheKey   string `json:"cache_key,omitempty"`   // For client-side cache invalidation
    Version    int64  `json:"version,omitempty"`     // For optimistic updates
}

// Endpoint that works great with RTK Query
func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
    // Parse query params
    page, _ := strconv.Atoi(r.URL.Query().Get("page"))
    if page < 1 { page = 1 }

    perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
    if perPage < 1 { perPage = 20 }
    if perPage > 100 { perPage = 100 }

    projectID := r.URL.Query().Get("project_id")
    status := r.URL.Query().Get("status")

    // Build cache key from query params (for client cache invalidation)
    cacheKey := fmt.Sprintf("tasks:project=%s:status=%s:page=%d",
        projectID, status, page)

    // Get data
    tasks, total, err := h.taskService.List(r.Context(), ListTasksParams{
        ProjectID: projectID,
        Status:    status,
        Page:      page,
        PerPage:   perPage,
    })
    if err != nil {
        respondError(w, err)
        return
    }

    // Add total count header (useful for some libraries)
    w.Header().Set("X-Total-Count", strconv.Itoa(total))

    // Set ETag for caching
    etag := generateETag(tasks)
    w.Header().Set("ETag", etag)

    if r.Header.Get("If-None-Match") == etag {
        w.WriteHeader(http.StatusNotModified)
        return
    }

    totalPages := (total + perPage - 1) / perPage

    respondJSON(w, http.StatusOK, APIResponse{
        Data: tasks,
        Meta: &Meta{
            Page:       page,
            PerPage:    perPage,
            Total:      total,
            TotalPages: totalPages,
            HasMore:    page < totalPages,
            CacheKey:   cacheKey,
        },
    })
}

// Update endpoint that returns updated entity (for optimistic updates)
func (h *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
    taskID := chi.URLParam(r, "id")

    var req UpdateTaskRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        respondError(w, ErrBadRequest)
        return
    }

    // Get current version for conflict detection
    currentVersion := r.Header.Get("If-Match")

    task, err := h.taskService.Update(r.Context(), taskID, req, currentVersion)
    if err == ErrVersionConflict {
        // Return current state so frontend can merge
        current, _ := h.taskService.Get(r.Context(), taskID)
        w.WriteHeader(http.StatusConflict)
        respondJSON(w, http.StatusConflict, APIResponse{
            Data: current,
            Meta: &Meta{Version: current.Version},
        })
        return
    }
    if err != nil {
        respondError(w, err)
        return
    }

    // Return updated entity with new version
    respondJSON(w, http.StatusOK, APIResponse{
        Data: task,
        Meta: &Meta{
            Version:  task.Version,
            CacheKey: fmt.Sprintf("task:%s", taskID),
        },
    })
}
```

**Follow-ups:**
- *Why cursor pagination over offset for infinite scroll?* Offsets shift under insert/delete, so a user sees duplicates or skips rows. Cursors encode a stable position (usually a sort-key tuple) and are skip-proof. Trade-off: cursors do not support "jump to page N".
- *How does RTK Query know what to invalidate after a mutation?* The query defines `providesTags: [{ type: 'Task', id }]`, the mutation declares `invalidatesTags: [{ type: 'Task', id: 'LIST' }]`. Match those to your response `cacheKey` semantics so the client can automate invalidation.
- *When do you need `If-Match` vs `If-Unmodified-Since`?* `If-Match` uses ETags (entity identity). `If-Unmodified-Since` uses timestamps (one-second resolution, worse under high write rate). Default to ETags.

---

### Question 5: How do you handle graceful degradation when WebSocket isn't available?

**What FAANG expects:** A transport fallback chain (WebSocket → SSE → long polling) plus a transport-agnostic message store so application logic does not care which channel the client picked. Know the failure modes that actually matter in 2026: corporate proxies strip `Upgrade`, some CDNs buffer SSE, and long polling scales worst because each "pending" connection still costs a goroutine and file descriptor. Bonus for mentioning WebTransport (HTTP/3-based, Chromium GA) as the modern alternative to WebSocket for lossy networks.

**Answer:**

The standard approach is a transport fallback chain: try WebSocket first (full-duplex, lowest latency), fall back to SSE if WebSocket fails (one-way but auto-reconnecting), and finally fall back to long polling if SSE is also blocked (works everywhere but has higher latency and server load). The server should expose all three endpoints and let the client negotiate the best available transport. On the server side, all three transports feed into the same message store and subscription system so the application logic is transport-agnostic.

```go
// Fallback strategy: WebSocket → SSE → Polling
type RealtimeClient struct {
    wsURL      string
    sseURL     string
    pollURL    string
    connection Connection
    onMessage  func([]byte)
}

type Connection interface {
    Send(data []byte) error
    Close() error
}

func (c *RealtimeClient) Connect(ctx context.Context) error {
    // Try WebSocket first
    ws, err := c.connectWebSocket(ctx)
    if err == nil {
        c.connection = ws
        return nil
    }
    log.Printf("WebSocket unavailable: %v, trying SSE", err)

    // Fall back to SSE
    sse, err := c.connectSSE(ctx)
    if err == nil {
        c.connection = sse
        return nil
    }
    log.Printf("SSE unavailable: %v, falling back to polling", err)

    // Fall back to polling
    c.connection = c.startPolling(ctx)
    return nil
}

// Server-side: Support all three methods
type RealtimeServer struct {
    wsServer  *WebSocketServer
    sseServer *SSEServer
    store     *MessageStore
}

func (s *RealtimeServer) Router() chi.Router {
    r := chi.NewRouter()

    // WebSocket endpoint
    r.Get("/ws", s.wsServer.HandleConnection)

    // SSE endpoint
    r.Get("/events", s.sseServer.HandleConnection)

    // Polling endpoint
    r.Get("/poll", s.handlePoll)

    return r
}

func (s *RealtimeServer) handlePoll(w http.ResponseWriter, r *http.Request) {
    lastEventID := r.URL.Query().Get("last_event_id")
    userID := getUserFromContext(r.Context())

    // Long polling with timeout
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
    defer cancel()

    // Try to get new messages
    messages, err := s.store.GetMessagesSince(ctx, userID, lastEventID)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    if len(messages) == 0 {
        // Wait for new messages or timeout
        ch := s.store.Subscribe(userID)
        defer s.store.Unsubscribe(userID, ch)

        select {
        case msg := <-ch:
            messages = []Message{msg}
        case <-ctx.Done():
            // Timeout - return empty response
        }
    }

    respondJSON(w, http.StatusOK, map[string]any{
        "messages":      messages,
        "last_event_id": getLastEventID(messages),
    })
}
```

**Follow-ups:**
- *How does the client detect that WebSocket failed vs just slow?* Race the upgrade against a 3-5s timer. If no `open` event, abort and try the next transport. Store the winning transport in `localStorage` so the next page load skips the failed one.
- *Why is long polling worst at scale?* Every pending client holds a goroutine and a file descriptor. 100k idle SSE connections cost ~1GB of Go runtime memory. 100k idle long polls cost the same plus a new TCP handshake every 30s. SSE wins on connection efficiency.
- *When should you use WebTransport instead?* HTTP/3-based, multiplexed, supports unreliable datagrams. Ideal for games or voice where occasional loss beats head-of-line blocking. Chromium-only today. Not yet a fallback target for production.

### Junior -> FAANG: Interview Entry Points for Frontend Integration Topics

The five questions in this section represent the most common real-time systems interview topics for backend engineers at companies with significant frontend products. Each question has a pattern: describe the constraint, list the approaches with trade-offs, pick the best one for the scenario, and anticipate follow-ups about edge cases.

For WebSocket authentication: memorize that the browser's `WebSocket` constructor has no `headers` parameter. The three approaches are query-param token, post-connect auth message, and HttpOnly cookie. If the interviewer pushes on security, the post-connect message approach is most defensible because the token never appears in the URL (no server logs, no browser history).

For the dashboard real-time question: lead with SSE rather than WebSocket. Choosing WebSocket when SSE is sufficient is a common mistake that signals you defaulted to the "more powerful" option without analyzing the requirements. SSE is simpler, auto-reconnects, carries `Last-Event-ID`, and works over standard HTTP proxies. These are strong selling points that demonstrate you evaluate tools against requirements.

For API design with React Query/RTK Query: the key signal is mentioning cursor pagination and the `providesTags`/`invalidatesTags` contract explicitly. Interviewers at FAANG know these patterns and expect backend engineers working on SPA-backed APIs to understand how their response shapes affect client-side cache behavior.

### Senior @ FAANG: Bar-Raiser Interview Signals on Real-Time Systems

At L6 and above, these interview questions are evaluated not for knowledge of the pattern but for the ability to reason about the pattern at system scale and anticipate failure modes that only appear under production conditions.

**WebSocket authentication question at L6+.** The expected answer is not just the three strategies. It includes: how do you handle token expiry on a long-lived connection (send a refresh message over the existing socket before the token expires, validated server-side against the refresh endpoint, no reconnect required), how do you handle the race between the auth deadline and a slow auth message from a mobile client on a weak network (use a configurable deadline, emit a metric when the deadline fires, and distinguish auth-timeout closes from auth-failure closes in logs for operational visibility), and what is the CSRF exposure for cookie-based WebSocket auth (WebSocket upgrades send cookies but lack CSRF tokens, so the upgrade handler must validate the `Origin` header against the allowed list independently of the CORS middleware, which may not run for websocket upgrade paths in some router configurations).

**Dashboard real-time question at L6+.** The expected answer adds: how do you handle the "thundering herd" when a server restarts and 50,000 SSE clients reconnect simultaneously (staggered `retry` values sent in the `event: reconnect` message before shutdown, combined with a client-side jitter of 0 to `retry` milliseconds, spreads the reconnection over 30 seconds), how do you guarantee that a client who was offline for 3 minutes does not miss an important event (persistent event log with a retention window, `Last-Event-ID` resumption query that replays from the stored log, and a special `event: snapshot-required` if the client is outside the retention window so it knows to fetch full state from a REST endpoint), and how do you measure SSE reliability (event delivery latency from publish to flush, per-client event miss rate, reconnection rate as a deployment health signal).

**Graceful degradation question at L6+.** Candidates operating at principal level connect the WebSocket/SSE/polling fallback chain to the product definition of "real-time." A trading platform that accepts 50ms latency must not degrade to polling (which has at least polling-interval latency). A notification feed that accepts 30-second latency can degrade to polling without user-visible impact. The transport choice is a product SLA decision, not a technology preference. Document the accepted latency SLA per feature in the product spec, map each SLA to the correct transport, and build the fallback chain only for features where multiple transports are acceptable. Building a three-layer fallback for a feature that requires sub-100ms latency is theater, not engineering.

---
