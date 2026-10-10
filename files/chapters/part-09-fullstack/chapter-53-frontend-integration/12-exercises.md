## Exercises

These exercises progress from isolated middleware components to full integration scenarios. Each one targets a specific failure mode covered in this chapter.

1. **Build CORS Middleware**: Implement CORS middleware that supports wildcard subdomain matching (e.g., `*.example.com`), preflight response caching with `Access-Control-Max-Age`, and credential-aware origin reflection. Write tests that verify the middleware rejects unrecognized origins and sets the `Vary: Origin` header.

2. **Create SPA Server**: Build a Go server that serves a compiled React app from an `embed.FS`. It should return `index.html` for any path that is not a static asset or API route, apply `no-cache` headers to HTML, and apply immutable caching to content-hashed assets. Test that refreshing a deep link like `/dashboard/projects/123` returns the SPA shell.

3. **Implement WebSocket Chat**: Create a chat application with named rooms, join/leave notifications, and message broadcasting. Use a central hub goroutine with register/unregister channels. Verify that disconnecting a client removes it from all rooms and closes its send channel without panicking.

4. **Build SSE Notifications**: Implement a notification stream using Server-Sent Events. Support named event types, `Last-Event-ID` resumption, and a 15-second heartbeat. Test that the connection recovers after a network interruption by verifying the client receives missed events on reconnect.

5. **Create API Client**: Build a TypeScript API client that wraps `fetch` with typed response parsing matching the Go backend's envelope structure. Include automatic token refresh on 401 responses and request cancellation via `AbortController`.

6. **Add RTK Query Integration**: Define an RTK Query API slice with endpoints for CRUD operations on a resource. Use `providesTags` and `invalidatesTags` for cache management. Implement optimistic updates on mutations that roll back on server error.

7. **Implement Reconnection with Backoff**: Add exponential backoff reconnection logic to the WebSocket hook from this chapter. Start at 1 second, double on each failure up to 30 seconds, and reset on successful connection. Cap total attempts at 10 before surfacing an error to the user.

8. **Build File Upload with Progress**: Create a file upload endpoint that streams progress updates over a separate SSE connection. The upload handler should report bytes received as a percentage, transition through `uploading`, `processing`, and `complete` states, and handle upload cancellation gracefully.

### Junior -> FAANG: Exercise Sequencing and Self-Assessment

The eight exercises are ordered by dependency, not by difficulty. Exercises 1 and 2 (CORS and SPA serving) are prerequisites for testing any of the real-time features, because without correct CORS and static serving, the frontend cannot connect to the backend at all. Complete them first even if they seem simpler.

For self-assessment: after completing Exercise 3 (WebSocket chat), add a deliberate bug: comment out the `defer s.unregister <- client` line in `HandleWebSocket`. Run the application, connect five clients, disconnect them all, then use `runtime.NumGoroutine()` to count goroutines. You should see goroutine count growing without returning to baseline. Restore the line and verify goroutine count returns to baseline after disconnection. This exercise in intentional-bug-then-fix is more memorable than reading about goroutine leaks.

For Exercise 5 (TypeScript client): the goal is not just making the fetch calls work but making a wrong response shape cause a TypeScript compile error. After building the client, change a field name in the Go response struct without updating the TypeScript interface. Verify the TypeScript compiler catches the mismatch. If it does not, your TypeScript interfaces are using `any` somewhere and need to be tightened.

For Exercise 7 (exponential backoff): test it by simulating network failure. In the browser DevTools Application tab, set the service worker to offline, wait for the reconnection attempts to start, then go back online. Verify the connection restores and the backoff counter resets. The reconnection pattern is only meaningful if you test reconnection under real network conditions.

### Senior @ FAANG: Extending Exercises to Production Scenarios

Each exercise has a natural extension that bridges it from a learning exercise to a production readiness scenario.

**Exercise 1 extension: CORS policy as a configuration file.** Modify the CORS middleware to read allowed origins from a YAML config file at startup rather than from code. Add a file watcher that reloads the config on change without restarting the server. Write a test that verifies a new origin added to the config file becomes allowed within 5 seconds of the file change. This extension practices hot-reload patterns and configuration management.

**Exercise 2 extension: cache manifest integration.** Add a build step (a `go generate` call or a Makefile target) that reads the compiled SPA output directory, identifies content-hashed files by name, and writes a `cache-manifest.json` mapping each file to its cache policy. Modify the SPA handler to read this manifest at startup and apply the pre-computed policy per file. Write a test that verifies a non-hashed JS file gets `max-age=86400` and a hashed JS file gets `max-age=31536000, immutable`.

**Exercise 3 extension: Redis Streams pub/sub for multi-pod chat.** Wrap the `ChatServer.broadcast` channel with a Redis Streams publisher. Add a Redis Streams consumer that reads messages published by other pods and dispatches them to local clients. Run two instances of the server on different ports with a load balancer in front. Verify that a message sent to a client on port 8080 is received by a client on port 8081 within 200ms. Write a test that starts two server instances and asserts cross-instance delivery.

**Exercise 4 extension: event durability with resumption.** Add a PostgreSQL-backed event store to the SSE notification system. When a client connects with a `Last-Event-ID` header, query for events newer than that ID from the store and deliver them before subscribing to the live stream. Add a retention policy that deletes events older than 10 minutes. Write a test that disconnects a client, publishes three events during the disconnect, reconnects the client with the correct `Last-Event-ID`, and asserts the client receives all three missed events.

**Exercise 8 extension: resumable upload with the tus protocol.** Replace the simple multipart upload with a tus-protocol implementation. Tus uses `HEAD` to query upload offset, `PATCH` to append chunks, and stores state in Redis or a database between requests. This allows uploads to resume after a browser crash or network failure at the byte where they left off. The exercise tests understanding of idempotent HTTP semantics, offset tracking, and the difference between progress (how much has been received) and completion (whether all bytes have been processed).
