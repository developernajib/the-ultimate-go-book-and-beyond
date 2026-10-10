## Interview Follow-Ups

**Q: How do you handle the cold start problem (5-min GPU instance startup)?**

Predictive pre-warming: ML model predicts traffic 10 minutes ahead based on historical patterns. Pre-launch instances before they're needed. Minimum warm instances always running (floor). Spot/preemptible instances for burst capacity (cheaper, but may be interrupted).

**Q: How do you serve 405B parameter models efficiently?**

Model parallelism: Tensor Parallelism (split attention heads across GPUs) + Pipeline Parallelism (split layers across nodes). 405B on 8× H100 80GB = 8×80GB = 640GB available, model needs 810GB in fp16 → use 8-bit (FP8) quantization → 405GB + KV cache. RDMA networking (InfiniBand) between GPUs for tensor communication.

**Q: How do you handle token streaming reliability?**

SSE reconnection: client sends `Last-Event-ID` header on reconnect. Server replays missed tokens (stored in Redis list with TTL = 60s). If server dies mid-stream: client detects connection close, reconnects, gets remaining tokens from Redis buffer. Token-level idempotency: each token has sequence number.

**Q: How does LLM serving fundamentally differ from traditional REST API serving?**

Traditional APIs have predictable, short request durations (1-50ms). LLM serving is radically different:

| Dimension | Traditional API | LLM Serving |
|-----------|----------------|-------------|
| Latency | 1-50ms total | 100ms-60s (depends on output length) |
| Compute profile | CPU-bound or I/O-bound | GPU-bound, memory-bandwidth-bound |
| Response shape | Fixed-size JSON | Variable token stream |
| Request isolation | Stateless | Stateful (KV cache grows per token) |
| Batching | Usually single-request | Continuous batching critical for GPU utilization |
| Cost structure | CPU/memory | GPU hours (100-1000x more expensive per request) |
| Scaling unit | Stateless pods | GPU instances with model loaded in VRAM |

Key implications for Go serving layer: request timeout must accommodate full generation time (not just network RTT), connection pools must handle long-held streaming connections, backpressure matters, if the GPU is saturated, queue requests rather than shedding them.

**Q: Explain KV cache management and why it's the central challenge in LLM inference.**

During inference, every generated token attends to the Key-Value tensors of all previous tokens in the context. Without caching, each new token re-runs the forward pass over the entire prefix, making an n-token generation O(n²) overall, extremely wasteful.

KV cache stores the computed K/V tensors for all previous tokens, so each decode step processes only the new token and attends to the cached keys. The challenge:

- **Memory**: KV cache costs ~320KB per token on a 70B model, a full 128K context is ~40GB per request.
- **Fragmentation**: Requests have different lengths, naive allocation wastes GPU VRAM.
- **Sharing**: Multiple requests with identical system prompts have duplicate KV computations.

Solutions:
1. **PagedAttention (vLLM)**: GPU VRAM divided into fixed 16-token pages. KV cache allocated page-by-page, eliminating fragmentation. Enables 2-4x more concurrent requests.
2. **Prefix caching**: Cache KV for shared prefixes (system prompts). Hash the prefix tokens → look up cached KV block. 30-50% compute savings for high-reuse prefixes.
3. **KV offloading**: Spill cold KV blocks from VRAM to NVMe SSDs. Reload on next-token access. Trades latency for memory capacity (2-3x more concurrent long-context requests).

**Q: How do you handle model updates and new versions without downtime?**

Blue-green deployment adapted for GPU constraints:

1. **Model registry**: Each model version tagged (e.g., `llama-3.1-70b:v2`). Workers pull from registry at startup.
2. **Rolling upgrade**: Bring up new worker instances (green) loading the new model weights. Old workers (blue) continue serving.
3. **Request routing**: API gateway routes new requests to green workers once they pass health checks (`/v1/health` returns "model loaded").
4. **Drain blue workers**: Stop sending new requests to blue, let in-flight streaming requests complete (can take up to 60s). Then terminate.
5. **Canary deployment**: Route 5% of traffic to new model version first. Monitor TTFT, error rate, and output quality metrics for 30 minutes before full rollout.
6. **Rollback**: If canary metrics degrade, flip routing back to blue workers. New model weights stay loaded in green (don't evict) for 1 hour in case re-promotion is needed.

Constraint: GPU instances take 5 minutes to start + 2 minutes to load a 70B model. Plan rollovers with 10-minute buffer.

**Q: What are the primary cost optimization strategies for LLM inference at scale?**

GPU compute is the dominant cost (>80% of operating expense). Key levers:

1. **Continuous batching**: Never let GPUs sit idle. Merge requests into batches dynamically. 5-10x better utilization vs. one-request-at-a-time.
2. **Quantization**: Use int8 or int4 weight quantization. 70B fp16 = 140GB, 70B int4 = 35GB. Fits on 1× H100 instead of 2× A100. Modern methods (AWQ, GPTQ) lose only a few percent on benchmarks, acceptable for many use cases.
3. **Speculative decoding**: Small draft model generates tokens cheaply, large model verifies in parallel. Net 2-3x speedup on typical queries, most effective at low batch sizes where decode is memory-bandwidth-bound.
4. **Spot/preemptible instances**: Use AWS spot (p4d.24xlarge) for batch/async workloads. 60-80% cost reduction. Eviction handled by re-queuing requests.
5. **Request routing by model size**: Route simple queries (short context, factual) to smaller models (7B). Reserve 70B+ for complex reasoning. Half or more of requests may be serviceable by the 7B model.
6. **Prompt caching**: Cache KV for repeated system prompts across customers. OpenAI charges 50% less for cached prompt tokens, which reflects real compute savings.
7. **Idle scale-down**: Reduce warm GPU pool overnight (traffic drops 70%). Scale back up predictively before morning peak.

**Q: How do you implement fair multi-tenant GPU sharing without one customer starving others?**

Tenants (customers) should not monopolize GPU capacity:

1. **Per-tenant rate limiting**: Per-tenant token quota in Redis. `tokens_per_minute` enforced at API gateway before requests enter GPU queue.
2. **Priority queue with tenant fairness**: Instead of one queue, use a weighted fair queuing (WFQ) scheduler. Each tenant has a weight proportional to their tier. GPU workers pull from the tenant with the highest accumulated "debt" (used least recently relative to their weight).
3. **Request time limits**: Maximum generation length capped per tier (free: 1K tokens, pro: 8K, enterprise: 128K). Prevents one long request from blocking short requests for all other tenants.
4. **Resource isolation for enterprise**: Dedicated GPU instances for enterprise tenants at premium pricing. Guaranteed capacity, no sharing with other customers.
5. **Burst allowance**: Allow short-term burst above quota (e.g., 2x normal rate for 60 seconds). Smooth traffic spikes without hard rate limit errors. Tracked with a sliding window counter.

**Q: What observability is critical specifically for LLM latency, and how do you implement it in Go?**

LLM latency has unique characteristics that require purpose-built metrics:

Key metrics (beyond standard HTTP metrics):
- **TTFT (Time-to-First-Token)**: Latency from request receipt to first token emitted. Dominated by prefill compute. Target: P99 < 1s.
- **TPOT (Time-Per-Output-Token)**: Inter-token latency once generation starts. Dominated by GPU throughput. Target: P99 < 50ms/token.
- **Total generation time**: TTFT + (output_tokens × TPOT).
- **Queue wait time**: Time request spent in queue before GPU picked it up.
- **KV cache hit rate**: % of prompt tokens served from prefix cache. Low hit rate = wasted compute.
- **GPU utilization per model**: Per-model tracking prevents one model's traffic masking another's saturation.

// Go implementation pattern:
```go
import (
	"log/slog"

	"github.com/prometheus/client_golang/prometheus"
)

type InferenceServer struct{}

var (
	ttftHistogram      *prometheus.HistogramVec
	tpotHistogram      *prometheus.HistogramVec
	queueWaitHistogram *prometheus.HistogramVec
	cacheHitRatio      *prometheus.GaugeVec
)

type InferenceMetrics struct {
    RequestID    string
    ModelID      string
    TenantID     string
    PromptTokens int
    OutputTokens int
    CachedTokens int
    TTFTMs       int64   // time-to-first-token in ms
    TPOTMs       float64 // avg inter-token latency
    QueueWaitMs  int64
    Status       string  // completed, canceled, error
}

// Emit structured log line + Prometheus histogram after each request
func (s *InferenceServer) recordMetrics(m InferenceMetrics) {
    ttftHistogram.WithLabelValues(m.ModelID, m.TenantID).Observe(float64(m.TTFTMs))
    tpotHistogram.WithLabelValues(m.ModelID).Observe(m.TPOTMs)
    queueWaitHistogram.WithLabelValues(m.ModelID).Observe(float64(m.QueueWaitMs))
    cacheHitRatio.WithLabelValues(m.ModelID).Set(
        float64(m.CachedTokens) / float64(m.PromptTokens+1))

    slog.Info("inference_complete",
        "request_id", m.RequestID,
        "model", m.ModelID,
        "tenant", m.TenantID,
        "ttft_ms", m.TTFTMs,
        "tpot_ms", m.TPOTMs,
        "output_tokens", m.OutputTokens,
        "queue_wait_ms", m.QueueWaitMs,
    )
}
```

Alert thresholds: P99 TTFT > 2s (page on-call), KV cache hit rate < 20% (investigate prefix sharing), queue depth > 50 sustained for 5 minutes (trigger scale-up).

---
