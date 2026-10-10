## Observability for Inference

You cannot run a serving cluster without instrumentation. Inference adds a few metrics that traditional service monitoring does not cover (GPU use, KV cache fill, TTFT distribution, prefill / decode mix). This section walks the metric set, the tools, and the C++ instrumentation patterns.

### SLOs for LLM Serving

The four metrics that matter:

**TTFT (Time To First Token).** From request arrival to the first generated token reaching the client. Reflects prefill latency plus queueing. p50, p95, p99 reported separately.

**TPOT (Time Per Output Token).** Average ms between successive tokens during decode. Reflects decode iteration time. Smooth UX needs <50 ms, premium UX needs <30 ms.

**Throughput.** Tokens generated per second per GPU. The dollar metric.

**Goodput.** Throughput conditioned on meeting TTFT and TPOT SLOs. A burst of slow tokens is not goodput. Defined by Anyscale and DistServe, now standard.

A typical production target: TTFT p95 <500 ms, TPOT p99 <40 ms, goodput >X tokens/s at those SLOs.

### GPU Metrics

DCGM (Data Center GPU Manager) is NVIDIA's telemetry library. The C++ API exposes per-GPU counters:

```cpp
#include <dcgm_agent.h>

dcgmHandle_t handle;
dcgmInit();
dcgmStartEmbedded(DCGM_OPERATION_MODE_AUTO, &handle);

unsigned int gpuId = 0;
dcgmFieldValue_v2 values[20];
unsigned short fields[] = {
    DCGM_FI_PROF_GR_ENGINE_ACTIVE,        // SM busy fraction
    DCGM_FI_PROF_SM_ACTIVE,               // SM activity (incl. waiting)
    DCGM_FI_PROF_SM_OCCUPANCY,            // warps per SM / max warps
    DCGM_FI_PROF_PIPE_TENSOR_ACTIVE,      // tensor core busy
    DCGM_FI_PROF_DRAM_ACTIVE,             // HBM bandwidth used
    DCGM_FI_PROF_NVLINK_TX_BYTES,
    DCGM_FI_PROF_NVLINK_RX_BYTES,
    DCGM_FI_DEV_FB_USED,                  // VRAM used
    DCGM_FI_DEV_FB_TOTAL,
    DCGM_FI_DEV_POWER_USAGE,
    DCGM_FI_DEV_GPU_TEMP,
};

dcgmGetLatestValuesForFields(handle, gpuId, fields,
                              sizeof(fields)/sizeof(fields[0]),
                              values);

for (auto& v : values) {
    publish_metric(v.fieldId, v.value.dbl);
}
```

The interesting interpretations:

- **GR_ENGINE_ACTIVE** at 90%+ does not mean useful work. It means the SMs are doing *something*. Could be waiting on memory.
- **PIPE_TENSOR_ACTIVE** at 60%+ on a transformer means the GEMMs are saturating Tensor Cores. Below 30% means you are kernel-launch-bound or memory-bound.
- **DRAM_ACTIVE** at 80%+ in decode means you are at the memory roofline. Quantization (FP8 weights, FP8 KV) is the answer.
- **SM_OCCUPANCY** below 20% with low PIPE_TENSOR_ACTIVE means register pressure or shared memory pressure. Profile with NSight.

### SM Occupancy and the Roofline

Roofline analysis: plot operation arithmetic intensity (FLOPs / byte) against the hardware's compute / bandwidth ratio. H100 peak is ~590 FLOPS / byte (FP16). Operations below that line are memory-bound, operations above are compute-bound.

For an LLM:

- Prefill GEMMs (M=2048, N=8192, K=8192): intensity ~2000 FLOPs/byte. Compute-bound. Should hit 80%+ of FP16 peak.
- Decode GEMMs (M=batch=32, N=8192, K=8192): intensity ~30 FLOPs/byte. Memory-bound. Cannot exceed bandwidth-limited rate.
- Attention prefill: compute-bound (large Q @ K^T).
- Attention decode: memory-bound (read full KV cache).

Watching `PIPE_TENSOR_ACTIVE` vs `DRAM_ACTIVE` per phase tells you which roofline you are hitting.

### Engine-Level Metrics

Beyond GPU counters, the engine itself emits metrics. The standard set:

```cpp
class InferenceMetrics {
public:
    // Counters
    std::atomic<uint64_t> requests_total{0};
    std::atomic<uint64_t> requests_completed{0};
    std::atomic<uint64_t> requests_aborted{0};
    std::atomic<uint64_t> requests_rejected{0};
    std::atomic<uint64_t> tokens_generated{0};
    std::atomic<uint64_t> tokens_input{0};

    // Histograms (use HDR histogram or Prometheus client)
    Histogram ttft_ms;          // request -> first token
    Histogram tpot_ms;           // per inter-token interval
    Histogram queue_time_ms;
    Histogram prefill_chunk_ms;
    Histogram input_token_count;
    Histogram output_token_count;

    // Gauges
    std::atomic<int> running_requests{0};
    std::atomic<int> waiting_requests{0};
    std::atomic<int> kv_blocks_used{0};
    std::atomic<int> kv_blocks_total{0};
    std::atomic<double> prefix_cache_hit_ratio{0.0};
    std::atomic<int> decode_batch_size{0};
};
```

Hook the metrics into a Prometheus exporter. Ship to your observability backend (Mimir, M3, internal). Build a per-deployment dashboard with these panels:

- TTFT and TPOT distributions (p50 / p95 / p99) over time.
- Tokens / sec per GPU (the dollar number).
- KV cache fill ratio (alarm if >90%).
- Prefix cache hit ratio (alarm if drops below baseline).
- GPU SM occupancy and tensor core use.
- Power per GPU (thermal management).
- Queue depth and waiting requests (capacity signal).

### NSight Systems Integration

NSight Systems is NVIDIA's profiler. For deep performance work it is the answer.

```cpp
#include <nvtx3/nvtx3.hpp>  // header-only NVTX

void Engine::forward(const Batch& b) {
    nvtx3::scoped_range fwd{"forward"};
    {
        nvtx3::scoped_range emb{"embedding"};
        embed(b);
    }
    for (int l = 0; l < num_layers_; ++l) {
        nvtx3::scoped_range layer{"layer_" + std::to_string(l)};
        run_layer(l, b);
    }
    {
        nvtx3::scoped_range head{"lm_head"};
        run_head(b);
    }
}
```

NVTX ranges show up as colored blocks in the NSight timeline. You see exactly which CUDA kernels run inside which logical phase. Combined with the GPU's SM activity timeline, you can spot:

- A kernel that is running but doing no work (load-bound).
- A kernel that returns before the GPU is idle (pipelining works).
- Idle gaps between kernels (launch overhead, eligible for CUDA Graph capture).
- Stream serialization that should be parallel.

Run NSight on a single inference iteration in production-like conditions. Save the report. Diff across releases.

### Distributed Tracing

For multi-stage requests (router -> tokenizer -> engine -> detokenizer -> response), use OpenTelemetry. Each stage emits a span with parent/child relationships.

```cpp
#include <opentelemetry/trace/provider.h>
namespace ot = opentelemetry::trace;

void handle_request(const Request& req) {
    auto tracer = ot::Provider::GetTracerProvider()->GetTracer("inference");
    auto root = tracer->StartSpan("inference_request");
    root->SetAttribute("model", req.model_name);
    root->SetAttribute("input_tokens", static_cast<int64_t>(req.input_token_count));

    {
        auto tok_span = tracer->StartSpan("tokenize",
            {{"parent", root->GetContext().span_id()}});
        tokenize(req);
        tok_span->End();
    }
    {
        auto inf_span = tracer->StartSpan("engine_forward");
        engine_forward(req);
        inf_span->SetAttribute("output_tokens",
            static_cast<int64_t>(req.output_token_count));
        inf_span->End();
    }
    root->End();
}
```

Traces let you debug long tails. A request that took 3 seconds when others took 200 ms: the trace shows whether time was lost in the tokenizer, in the queue, in prefill, or in detokenization.

### Logging the Right Things

Log per request, structured:

```cpp
struct RequestLog {
    uint64_t request_id;
    std::string model;
    int input_tokens;
    int output_tokens;
    std::string finish_reason;     // "stop" / "length" / "error"
    int64_t arrival_ts_us;
    int64_t first_token_ts_us;
    int64_t finish_ts_us;
    double ttft_ms;
    double tpot_ms;
    int prefix_cache_hit_blocks;
    int kv_blocks_allocated;
};
```

Sampled at production rates (1% to 0.01%, depending on volume) and shipped to a structured log store. Aggregate to find:

- Which prompts are slowest (cache misses).
- Which client tenants are dominating cost.
- Output length distribution (drives capacity planning).

Avoid logging full prompts and responses by default (privacy, compliance, cost). Sample 0.001% if you must. Hash-only the rest.

### Senior at FAANG: The Capacity Signal

The capacity question for a serving cluster: at what point do new replicas need to come online?

The signal is not "GPU use" (always misleading). The signal is *goodput at SLO*. As load increases:

1. Throughput rises linearly (more concurrent requests).
2. KV cache fills, scheduler starts preempting, p99 TTFT rises.
3. Decode batch grows, p99 TPOT rises.
4. SLOs start to fail.

The right alarm: "p99 TTFT > 500 ms for 5 minutes" or "goodput drops below X". When that fires, you provision more capacity. The wrong alarm: "GPU util > 80%". On a perfectly tuned engine, GPU util is 95%+ at half load and useless as a capacity signal.

Build the dashboard. Tune the alarm. Get on call. The next section translates these metrics into dollars.

---
