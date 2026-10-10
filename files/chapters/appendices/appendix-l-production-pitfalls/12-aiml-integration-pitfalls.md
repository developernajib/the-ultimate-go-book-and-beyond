## AI/ML Integration Pitfalls

Integrating artificial intelligence models, Large Language Models (LLMs), and vector databases into production Go backend services introduces unique runtime risks. Go's high-concurrency model is well-suited for API proxies and orchestration, but interacting with non-Go native runtimes (C/C++ via cgo), streaming tokens over HTTP, and processing multi-gigabyte vector embeddings can easily exhaust system resources.

---

### 1. Vector Embeddings: The L2 Normalization & Heap Explosion Trap

#### Root Cause Mechanics
Vector search algorithms (e.g., Pinecone, Qdrant, Milvus, pgvector) rely on **Cosine Similarity** to compare semantic meaning. When calculating cosine similarity, if vectors are not L2-normalized (magnitude equal to 1.0), raw dot-product queries produce distorted results and wrong search rankings.
Furthermore, storing millions of high-dimensional embeddings (e.g., OpenAI `text-embedding-3-large` with 3,072 float32 dimensions per vector = 12KB per vector) in standard Go slices creates severe GC marking overhead:
- A slice of 100,000 vectors consumes 1.2GB of heap memory.
- The Go garbage collector must scan each slice header during marking, increasing GC pause latency.

#### Production-Grade Solution
```go
package vector

import (
    "math"
)

// NormalizeInPlace normalizes a vector to unit length (L2 norm = 1.0)
// Operates in-place to avoid allocating a new slice on the heap.
func NormalizeInPlace(vec []float32) {
    var sumSquares float64
    for _, v := range vec {
        sumSquares += float64(v) * float64(v)
    }

    norm := float32(math.Sqrt(sumSquares))
    if norm == 0 {
        return // Avoid division by zero
    }

    invNorm := 1.0 / norm
    for i := range vec {
        vec[i] *= invNorm
    }
}
```

---

### 2. LLM Streaming Backpressure & Goroutine Leak

#### Root Cause Mechanics
When streaming LLM responses to web clients via Server-Sent Events (SSE), developers routinely iterate over upstream model chunks in a background goroutine. If the end user closes their browser or drops their mobile connection, the downstream TCP socket closes.
If the Go server fails to monitor the request's context cancellation (`r.Context().Done()`), the server continues reading expensive tokens from the LLM provider (accumulating cloud API bills) and remains blocked writing to a dead socket, leaking goroutines.

#### Vulnerable Code
```go
// DANGEROUS: Continues consuming LLM tokens even if user disconnected!
func StreamLLMHandler(w http.ResponseWriter, r *http.Request) {
    stream, _ := llmClient.CreateCompletionStream(context.Background(), prompt)
    for {
        chunk, err := stream.Recv()
        if err != nil { break }
        fmt.Fprintf(w, "data: %s\n\n", chunk.Text)
        w.(http.Flusher).Flush() // Fails silently on closed connection
    }
}
```

#### Production-Grade Solution
```go
func StreamLLMHandler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context() // Inherit client request context
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Pass request context to upstream LLM client to abort API call immediately on client disconnect
    stream, err := llmClient.CreateCompletionStream(ctx, prompt)
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadGateway)
        return
    }
    defer stream.Close()

    for {
        select {
        case <-ctx.Done():
            // User disconnected or timed out: abort immediately!
            return
        default:
            chunk, err := stream.Recv()
            if err != nil {
                return // EOF or upstream error
            }
            if _, err := fmt.Fprintf(w, "data: %s\n\n", chunk.Text); err != nil {
                return // Socket write failed
            }
            flusher.Flush()
        }
    }
}
```

---

### 3. CGO Native Memory Leaks in ML Inference Runtimes

#### Root Cause Mechanics
Many Go services bind to native C/C++ inference libraries (such as ONNX Runtime, GGML, or LibTorch) via cgo. Memory allocated within C code (`malloc`, `C.CString`) exists outside the Go runtime's managed heap and is **completely invisible to the Go garbage collector**.
Failing to explicitly release C pointers via `C.free()` results in silent, catastrophic native heap growth that inevitably triggers Linux kernel OOM kills.

#### Production-Grade Solution
```go
package inference

/*
#include <stdlib.h>
#include "onnxruntime_c_api.h"
*/
import "C"
import (
    "runtime"
    "unsafe"
)

type ModelSession struct {
    cSession *C.OrtSession
}

func NewModelSession(modelPath string) (*ModelSession, error) {
    cPath := C.CString(modelPath)
    // CRITICAL: Every C.CString MUST be paired with C.free to prevent native memory leaks
    defer C.free(unsafe.Pointer(cPath))

    var session *C.OrtSession
    // ... initialize session with cPath ...

    ms := &ModelSession{cSession: session}
    // Set a runtime finalizer as a safety net against leaked native handles
    runtime.SetFinalizer(ms, (*ModelSession).Destroy)
    return ms, nil
}

func (ms *ModelSession) Destroy() {
    if ms.cSession != nil {
        C.OrtReleaseSession(ms.cSession)
        ms.cSession = nil
    }
}
```

---
