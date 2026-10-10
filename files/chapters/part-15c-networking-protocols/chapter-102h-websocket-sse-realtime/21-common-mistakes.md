## 102H.19 Production Anti-Patterns and Correct Implementations

### Anti-Pattern 1: Writing to WebSocket from Multiple Goroutines

**Problem:** `gorilla/websocket` is not safe for concurrent writes. Calling `conn.WriteMessage` from multiple goroutines causes a data race and panic.

```go
// WRONG - concurrent writes cause panic
go func() { conn.WriteMessage(websocket.TextMessage, msg1) }()
go func() { conn.WriteMessage(websocket.TextMessage, msg2) }() // RACE
```

**Fix:** Funnel all writes through a single `writePump` goroutine via a buffered channel:

```go
// CORRECT - single writer goroutine
send := make(chan []byte, 256)
go func() { // writePump: sole owner of conn writes
    for msg := range send {
        conn.WriteMessage(websocket.TextMessage, msg)
    }
}()
send <- msg1
send <- msg2
```

### Anti-Pattern 2: Blocking the Hub on Slow Clients

**Problem:** Broadcasting by iterating over clients and calling `send <- msg` blocks the entire hub if one client's channel is full.

```go
// WRONG - blocks entire hub if one client is slow
for _, client := range clients {
    client.send <- msg // blocks if channel full
}
```

**Fix:** Use a non-blocking send. Disconnect slow consumers:

```go
// CORRECT - drop slow clients rather than blocking
for _, client := range clients {
    select {
    case client.send <- msg:
    default:
        // Channel full - client is too slow. Disconnect.
        close(client.send)
        delete(clients, client)
    }
}
```

### Anti-Pattern 3: No Message Size Limit

**Problem:** A malicious client sends a 500 MB WebSocket message, exhausting server memory and causing OOM.

```go
// WRONG - no size limit
conn, _ := upgrader.Upgrade(w, r, nil)
_, msg, _ := conn.ReadMessage() // attacker sends 500 MB message
```

**Fix:** Set `SetReadLimit` immediately after upgrading:

```go
// CORRECT - limit message size to 4 KB
conn, _ := upgrader.Upgrade(w, r, nil)
conn.SetReadLimit(4096) // gorilla/websocket closes conn if exceeded
_, msg, _ := conn.ReadMessage()
```

### Anti-Pattern 4: SSE Without Disabling Proxy Buffering

**Problem:** nginx (and other reverse proxies) buffer SSE responses by default. Clients receive events in batches after a delay, breaking the "real-time" experience.

```go
// WRONG - nginx will buffer the response
w.Header().Set("Content-Type", "text/event-stream")
fmt.Fprintf(w, "data: hello\n\n")
flusher.Flush() // flushed to nginx, but nginx buffers it
```

**Fix:** Set the `X-Accel-Buffering: no` header (nginx) and `Cache-Control: no-cache`:

```go
// CORRECT - tells nginx to pass bytes immediately
w.Header().Set("Content-Type", "text/event-stream")
w.Header().Set("Cache-Control", "no-cache")
w.Header().Set("X-Accel-Buffering", "no") // nginx directive
fmt.Fprintf(w, "data: hello\n\n")
flusher.Flush()
```

### Anti-Pattern 5: Thundering Herd on Server Restart

**Problem:** Server restarts. All 10,000 clients simultaneously reconnect. Server is overwhelmed before it's ready, causing another crash.

```javascript
// WRONG - client reconnects immediately with no backoff
eventSource.onerror = () => {
    setTimeout(() => connectWebSocket(), 0); // immediate retry
};
```

**Fix:** Exponential backoff with full jitter on the client side. For SSE, set the `retry:` field to a non-zero value. For WebSocket, implement backoff in the client:

```go
// Server: SSE - hint reconnect interval to client
fmt.Fprintf(w, "retry: 3000\n\n") // start at 3s

// Client (JavaScript) - exponential backoff for WebSocket
// let delay = 1000;
// function reconnect() {
//     setTimeout(() => {
//         delay = Math.min(delay * 2, 30000) + Math.random() * 1000 - // jitter
//         connect();
//     }, delay) - // }
```

For server-side protection, add a rate limiter on the `/ws` endpoint to reject connections during thundering herd events:

```go
// Per-IP rate limiter - max 5 connection attempts per second per IP
var ipLimiters sync.Map // map[string]*rate.Limiter

func getIPLimiter(ip string) *rate.Limiter {
	v, _ := ipLimiters.LoadOrStore(ip, rate.NewLimiter(5, 10))
	return v.(*rate.Limiter)
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	ip := r.RemoteAddr
	if !getIPLimiter(ip).Allow() {
		http.Error(w, "too many connection attempts", http.StatusTooManyRequests)
		return
	}
	// ... upgrade and handle
}
```

### Junior → FAANG: The Anti-Pattern That Appears in Every Code Review

Anti-Pattern 1 (writing from multiple goroutines) is the single most common mistake in WebSocket code reviews. It appears as: a handler goroutine that calls `conn.WriteMessage` directly alongside a broadcaster goroutine that also calls `conn.WriteMessage` on the same connection. The race detector will catch it, but only if you run tests with `go test -race`. Always run the race detector on WebSocket code before shipping.

The fix is simple and consistent: every connection has exactly one goroutine that writes to it. All other goroutines that want to write communicate through a buffered channel to the writer goroutine. Once this pattern is internalized, it becomes automatic. Use it for every connection, in every codebase, without exception.

For interviews: if shown WebSocket code that has multiple goroutines writing to the same connection, immediately identify it as a data race and explain the fix. This is a common "what's wrong with this code?" question in Go concurrency interviews.

### Senior @ FAANG: Systemic Prevention of Anti-Patterns Through Type Design

The repeated appearance of WebSocket anti-patterns across teams is a signal that the abstraction layer is not providing enough guardrails. A better-designed WebSocket connection abstraction would make the unsafe operation unexpressable, not just documented as wrong.

The type-system approach: instead of exposing the raw `*websocket.Conn`, expose a `WebSocketClient` type that has only a `Send(msg Message) error` method. The `Send` method internally writes to the writer goroutine's channel. The raw `WriteMessage` is not accessible. With this abstraction, the anti-pattern of concurrent writes is literally not expressable with the public API.

This is the "make the pit of success wide" principle from Eric Lippert's writing: design APIs so that the correct usage is the easiest usage, and incorrect usage requires explicit and obvious workarounds. Applying this principle to the WebSocket connection type is a two-hour refactor that prevents the same code review comment from being repeated across every service in the organization. At L6, proposing and implementing this kind of leverage-amplifying abstraction is a more valuable contribution than reviewing individual PRs for the same anti-pattern.

---
