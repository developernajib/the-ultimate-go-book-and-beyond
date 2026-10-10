## Failure Handling

GPU worker crashes are especially disruptive in LLM serving because each worker holds in-flight generation state (the KV cache and partially generated tokens) that cannot simply be retried from scratch without the user noticing a gap. The failover strategy below buffers generated tokens in Redis so that when a client reconnects after a worker crash, the system can replay missed tokens and resume generation on a different worker. Health checks run on a short interval, and a worker is marked unhealthy after three consecutive failures to prevent sending new requests to a degraded GPU.

```go
package resilience

import (
	"context"
	"fmt"
	"time"
)

type WorkerPool interface {
	RequeueRequest(ctx context.Context, reqID string) error
	ResumeRequest(ctx context.Context, reqID string, tokens []string) error
}

type TokenBuffer interface {
	GetTokens(reqID string) []string
}

type InferenceFailover struct {
	pool   WorkerPool
	buffer TokenBuffer
}

// HandleWorkerCrash recovers a request whose worker died mid-generation.
// Nothing generated yet: requeue from scratch. Otherwise resume on a new
// worker by replaying prompt + already-generated tokens, while the client
// reconnects with Last-Event-ID and replays missed tokens from the Redis
// buffer.
func (f *InferenceFailover) HandleWorkerCrash(ctx context.Context, reqID string) error {
	tokens := f.buffer.GetTokens(reqID)
	if len(tokens) == 0 {
		return f.pool.RequeueRequest(ctx, reqID)
	}
	return f.pool.ResumeRequest(ctx, reqID, tokens)
}

type GPUHealthCheck struct {
	interval time.Duration
}

func (h *GPUHealthCheck) Monitor(ctx context.Context, workerID string) {
	ticker := time.NewTicker(h.interval)
	defer ticker.Stop()

	fails := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !h.isHealthy(ctx, workerID) {
				fails++
				if fails >= 3 {
					h.markUnhealthy(ctx, workerID)
					return
				}
			} else {
				fails = 0
			}
		}
	}
}

func (h *GPUHealthCheck) isHealthy(ctx context.Context, wid string) bool {
	return true // simplified: probe /v1/health and check GPU error counters
}

func (h *GPUHealthCheck) markUnhealthy(ctx context.Context, wid string) {
	fmt.Printf("Worker %s marked unhealthy\n", wid)
}
```

---
