## 3. Node.js to Go Migration

### 3.1 Architectural Rationale & Runtime Mechanics

Node.js and Go are both widely celebrated for asynchronous network I/O, but their runtime mechanics diverge fundamentally under load:

- **Node.js (libuv Single-Threaded Event Loop)**: Node.js runs JavaScript on Google's V8 engine backed by the `libuv` event loop. While asynchronous non-blocking network calls perform well, execution of JavaScript code is strictly single-threaded per process. If a single request performs CPU-heavy work—such as parsing a 10MB JSON document, hashing a password with bcrypt, or compressing a file—the event loop stalls. While the loop is blocked, every other concurrent user connected to that Node.js process experiences latency spikes or connection timeouts.
- **Go (Preemptive M:N Scheduler)**: Go executes across all available CPU cores natively. The Go runtime scheduler automatically preempts long-running goroutines at function prologues and loop edges (since Go 1.14 non-cooperative preemption). A CPU-heavy mathematical calculation or JSON parse in one goroutine cannot starve concurrent HTTP requests running on other logical processors.

```
┌──────────────────────────────────────────────────────────────┐
│                    Node.js vs. Go Concurrency                │
├──────────────────────────────┬───────────────────────────────┤
│ Node.js (libuv Event Loop)   │ Go (M:N Runtime Scheduler)    │
├──────────────────────────────┼───────────────────────────────┤
│ • Single-Threaded JavaScript │ • Native Multi-Core Execution │
│ • Event Loop Stalls on CPU   │ • Preemptive Goroutine Switch │
│ • Promisified Callback Queues│ • Synchronous-Style Channels  │
│ • V8 Dynamic Heap Compaction │ • Low-Pause Tri-Color Mark GC │
│ • Fragile node_modules Tree  │ • Single Pinned go.mod File   │
│ • Uncaught Promise Unhandled │ • Explicit Value Return Errors│
└──────────────────────────────┴───────────────────────────────┘
```

---

### 3.2 When Go Is the Best Option (The "Why")

1. **CPU-Intensive & Mixed I/O Microservices**:
   - Applications that combine heavy network I/O with data manipulation (cryptographic token signing, report generation, compression, image resizing) saturate Node.js instantly. Go handles mixed workloads without breaking a sweat.
2. **Eliminating Supply Chain Vulnerabilities & Dependency Bloat**:
   - A typical enterprise Node.js service imports 800+ npm packages totaling 400MB of `node_modules`. Each transitive package introduces security attack surfaces (typosquatting, malicious maintainer takeovers). Go has an exceptionally rich standard library (`net/http`, `crypto`, `encoding/json`, `database/sql`), allowing enterprise services to run with fewer than 10 well-vetted external dependencies.
3. **Compile-Time Type Safety Without TypeScript Transpilation Overhead**:
   - TypeScript adds static typing during development, but types are completely erased at runtime. Runtime crashes (`TypeError: Cannot read properties of undefined`) remain common in production Node.js. Go enforces strict, permanent static type safety compiled directly into the binary.
4. **Predictable Memory Footprint Under Load**:
   - V8 heap allocation behavior varies wildly under memory pressure and can trigger sudden latency cliffs when running full-heap sweeps. Go memory consumption remains flat, linear, and predictable.

---

### 3.3 When Go Is NOT a Good Option (When NOT to Migrate)

1. **Full-Stack Applications Sharing UI Components**:
   - If your team builds modern React / Next.js / Remix frontends, keeping the backend in Node.js/TypeScript allows sharing TypeScript interfaces, validation schemas (Zod), and utility functions seamlessly across the client-server boundary.
2. **Dynamic GraphQL Aggregators & BFF (Backend-For-Frontend) Layers**:
   - Services whose sole purpose is stitching heterogeneous JSON responses together without business logic often benefit from JavaScript's flexible, frictionless object manipulation.
3. **Teams with Pure Frontend Backgrounds**:
   - If your engineering organization consists primarily of frontend engineers who know JavaScript, forcing a Go migration without concurrency and memory management training will lead to race conditions and goroutine leaks.

---

### 3.4 Architectural Pattern Comparison: Streaming API Proxy

Compare an HTTP service that streams large files or real-time event payloads from an external provider to clients with backpressure.

#### Node.js (Express / Stream Pipeline)
```javascript
// Node.js stream pipeline
const express = require('express');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const app = express();

app.get('/export', async (req, res) => {
    try {
        const upstream = await axios({
            method: 'get',
            url: 'https://storage.internal/large-report.csv',
            responseType: 'stream',
            timeout: 10000
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="report.csv"');

        // Unhandled client disconnects can leak upstream sockets
        await pipeline(upstream.data, res);
    } catch (err) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Stream failed' });
        }
    }
});
```

#### Go (Native io.Copy with Context & HTTP Flusher)
```go
package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"time"
)

func streamReportHandler(client *http.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://storage.internal/large-report.csv", nil)
		if err != nil {
			http.Error(w, "internal request error", http.StatusInternalServerError)
			return
		}

		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, "upstream service unavailable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", `attachment; filename="report.csv"`)

		// Zero-allocation streaming buffer directly connecting network sockets
		// If client terminates connection, r.Context() cancels and io.Copy terminates immediately
		written, err := io.Copy(w, resp.Body)
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("streaming failed mid-transfer", "error", err, "bytes_written", written)
		}
	}
}
```

---

### 3.5 Migration Execution: Microservice Decomposition

1. **Step 1: Extract Hot Paths First**:
   - Profile your Node.js application to identify endpoints with the highest event-loop latency. These are typically PDF generation, cryptography, image processing, or high-volume webhook ingestion.
2. **Step 2: Deploy Go as a Sidecar or Internal Service**:
   - Extract that single hot-path function into an internal Go microservice communicating over gRPC or HTTP. The Node.js application delegates compute work to Go while continuing to handle general routing.
3. **Step 3: Gradually Eliminate Node.js Layer**:
   - Once all compute-heavy and data-layer services run in Go, move the API gateway to Go, retiring the Node.js backend entirely.
