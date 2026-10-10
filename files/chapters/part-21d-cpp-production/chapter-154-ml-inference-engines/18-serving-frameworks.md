## Serving Frameworks

The pieces in earlier sections (kernels, scheduler, KV cache, NCCL) need to wrap into a deployable service. Serving frameworks are the glue: model loading, request routing, version management, gRPC / HTTP endpoints, metrics, health checks. This section surveys the major frameworks and shows how to embed them in a C++ service.

### Triton Inference Server

NVIDIA's Triton is the most flexible. Backends include TensorRT, ONNX Runtime, TensorFlow, PyTorch, OpenVINO, vLLM, TensorRT-LLM, and a generic Python backend. One server process can host hundreds of models across these backends.

Triton ships as a binary or a C library. The C API lets you embed Triton in another C++ process:

```cpp
#include <tritonserver.h>

TRITONSERVER_ServerOptions* opts = nullptr;
TRITONSERVER_ServerOptionsNew(&opts);
TRITONSERVER_ServerOptionsSetModelRepositoryPath(opts, "/models");
TRITONSERVER_ServerOptionsSetLogVerbose(opts, 0);

TRITONSERVER_Server* server = nullptr;
TRITONSERVER_ServerNew(&server, opts);

// Wait for the server to be ready
while (true) {
    bool ready;
    TRITONSERVER_ServerIsReady(server, &ready);
    if (ready) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
}

// Build a request
TRITONSERVER_InferenceRequest* req = nullptr;
TRITONSERVER_InferenceRequestNew(&req, server, "llama3-70b", -1);

const int64_t shape[] = {1, 128};
TRITONSERVER_InferenceRequestAddInput(
    req, "input_ids", TRITONSERVER_TYPE_INT32, shape, 2);
TRITONSERVER_InferenceRequestAppendInputData(
    req, "input_ids", input_buf, input_bytes,
    TRITONSERVER_MEMORY_GPU, /*device_id=*/0);

TRITONSERVER_InferenceRequestSetResponseCallback(
    req,
    response_alloc,    // your alloc callback
    nullptr,
    response_complete, // your callback
    nullptr);

TRITONSERVER_ServerInferAsync(server, req, nullptr);
```

Triton's strength is the *model repository* abstraction: a directory layout where each model has a name, versions, and a `config.pbtxt` describing inputs / outputs / batching policy / EP options. You drop a new version of a model into the repo, Triton hot-reloads it. Versions can be live in parallel for canary rollouts.

For LLMs, the recommended Triton backend is **TensorRT-LLM backend**, which wraps the `tensorrt_llm::executor::Executor` (section 4) behind Triton's request / response interface. You get continuous batching, paged KV, speculative decoding, all via Triton's standard gRPC / HTTP endpoints.

### TGI (Text Generation Inference)

HuggingFace's TGI is Rust + Python (with C++ kernels via Pybind11). Optimized for HuggingFace transformers models. Production deployment at HuggingFace Inference Endpoints.

The C++ pieces are mainly the attention kernels (FlashAttention v2/v3, paged attention) accessed via the `text-generation-inference` Python module. Most production deployments run TGI as a turnkey Docker container, you do not embed it from C++.

If you want TGI semantics in C++, the path is to take the kernels (which are open-source CUDA C++) and integrate them into your own runtime. The Rust-Python orchestration on top is not the interesting part.

### vLLM

vLLM is the most-deployed open-source LLM server in 2026. Python frontend, C++/CUDA backend (paged attention, sampling kernels). Continuous batching, prefix caching, speculative decoding (with draft and Medusa), tensor parallel, pipeline parallel, MoE, FP8, MXFP4.

vLLM exposes an OpenAI-compatible HTTP server out of the box:

```bash
vllm serve meta-llama/Llama-3.3-70B-Instruct \
    --tensor-parallel-size 8 \
    --max-model-len 32768 \
    --kv-cache-dtype fp8 \
    --enable-prefix-caching
```

For C++ embedding, vLLM's path is the **AsyncLLMEngine** Python class. To call from C++, you would either go via a Python embedded interpreter (slow, not recommended) or use the OpenAI HTTP API as a sidecar. The latter is what every production deployment does:

```cpp
#include <httplib.h>
#include <nlohmann/json.hpp>

httplib::Client client("http://vllm-host:8000");
nlohmann::json req = {
    {"model", "meta-llama/Llama-3.3-70B-Instruct"},
    {"messages", {{{"role", "user"}, {"content", "Hello"}}}},
    {"stream", true},
    {"max_tokens", 256}
};
auto res = client.Post("/v1/chat/completions",
                       req.dump(), "application/json",
                       [&](const char* data, size_t len) {
                           // SSE streaming chunks
                           handle_stream_chunk(std::string_view(data, len));
                           return true;
                       });
```

vLLM in 2025-2026 underwent a "v1" engine rewrite that moved more scheduling and KV management into C++ for performance. The Python is still the API surface, the hot path is increasingly C++.

### TensorRT-LLM

NVIDIA's full-stack LLM runtime, built on TensorRT. Includes:

- A Python builder DSL for converting HuggingFace / PyTorch models into TRT engines with paged attention, FP8, INT4, in-flight batching, and tensor parallel.
- A C++ runtime (`tensorrt_llm::executor`) that hosts the engine and exposes async submit / response.
- A Triton backend for production deployment.

Build pipeline:

```bash
# Convert HF model -> intermediate -> TRT engine
trtllm-build \
    --checkpoint_dir llama3-checkpoint \
    --output_dir engine \
    --gemm_plugin float16 \
    --use_paged_context_fmha enable \
    --max_batch_size 32 \
    --max_input_len 8192 \
    --max_seq_len 16384 \
    --tp_size 8
```

C++ runtime usage was shown in section 4. The pattern: deserialize the engine directory into an `Executor`, submit `Request` objects, await streaming `Response` objects.

For NVIDIA-only deployments where peak performance matters, TensorRT-LLM is typically the fastest option, often 10-30% faster than vLLM on the same hardware.

### Building a C++ Serving Wrapper

Real services often have a thin C++ HTTP server in front of a TRT-LLM or vLLM backend. Reasons: custom auth, rate limiting, request transformation, logging integration with internal observability, multi-tenancy.

A minimal C++ wrapper around TRT-LLM:

```cpp
#include <drogon/drogon.h>
#include <tensorrt_llm/executor/executor.h>
namespace tle = tensorrt_llm::executor;

class GenerationController : public drogon::HttpController<GenerationController> {
public:
    METHOD_LIST_BEGIN
    ADD_METHOD_TO(GenerationController::generate, "/v1/completions", drogon::Post);
    METHOD_LIST_END

    void generate(const drogon::HttpRequestPtr& req,
                  std::function<void(const drogon::HttpResponsePtr&)>&& cb) {
        auto json = req->getJsonObject();
        if (!json) return cb(error_response("invalid json"));

        auto prompt = (*json)["prompt"].asString();
        auto max_tokens = (*json).get("max_tokens", 256).asInt();

        // Tokenize (assume tokenizer_ is initialized)
        auto token_ids = tokenizer_->encode(prompt);

        tle::Request tle_req(std::move(token_ids), max_tokens,
                              /*streaming=*/true,
                              tle::SamplingConfig{1});
        auto rid = executor_->enqueueRequest(std::move(tle_req));

        // Streaming SSE response
        auto resp = drogon::HttpResponse::newStreamResponse(...);
        std::thread([this, rid, resp]() mutable {
            while (true) {
                auto responses = executor_->awaitResponses(rid,
                    std::chrono::milliseconds(100));
                for (auto& r : responses) {
                    if (r.hasError()) {
                        resp->writeChunk(error_chunk(r.getErrorMsg()));
                        return;
                    }
                    auto& res = r.getResult();
                    auto piece = tokenizer_->decode_incremental(res.outputTokenIds[0]);
                    resp->writeChunk(make_sse_chunk(piece));
                    if (res.isFinal) {
                        resp->endStream();
                        return;
                    }
                }
            }
        }).detach();

        cb(resp);
    }

private:
    std::shared_ptr<tle::Executor> executor_;
    std::shared_ptr<Tokenizer> tokenizer_;
};
```

This sketch elides authentication, rate limiting, request validation, and metrics, all of which are non-optional in production.

### Request Routing

For multi-replica deployments, a router fronts the engines. Consistent-hash routing on `request_id` keeps follow-up turns of a conversation on the same replica (so the prefix cache hits). Random routing maximizes load balance but loses cache locality.

Production routers:

- **Triton with model ensembles** for chained models.
- **NVIDIA Dynamo** (released 2024-2025) for cluster-level routing across GPU pools, including disaggregated prefill / decode.
- **Custom Envoy filters** at FAANG scale.

A consistent-hash router in C++:

```cpp
class ConsistentHashRouter {
public:
    ConsistentHashRouter(std::vector<std::string> backends) {
        for (const auto& b : backends) {
            for (int v = 0; v < 256; ++v) {  // virtual nodes
                uint64_t h = hash(b + ":" + std::to_string(v));
                ring_[h] = b;
            }
        }
    }

    const std::string& route(const std::string& key) {
        uint64_t h = hash(key);
        auto it = ring_.lower_bound(h);
        if (it == ring_.end()) it = ring_.begin();
        return it->second;
    }

private:
    static uint64_t hash(const std::string& s) {
        // xxhash or city hash
        return std::hash<std::string>{}(s);
    }
    std::map<uint64_t, std::string> ring_;
};
```

### Model Versioning and Hot Reload

In production you ship multiple versions of a model concurrently for A/B testing and canary deploys. The serving framework needs:

1. Per-version load on disk.
2. Routing by version (header, URL path, or model alias).
3. Atomic swap when promoting a canary to production.
4. Reference counting on engines so in-flight requests finish before old version unloads.

Triton handles this with the model repository's directory layout (`model_name/1/`, `model_name/2/`, etc.) plus a model control mode. A custom server replicates the same logic:

```cpp
class ModelRegistry {
public:
    void load(const std::string& name, int version, std::shared_ptr<Engine> e) {
        std::unique_lock lk(mu_);
        engines_[{name, version}] = std::move(e);
    }

    std::shared_ptr<Engine> get(const std::string& name, int version) {
        std::shared_lock lk(mu_);
        auto it = engines_.find({name, version});
        return it == engines_.end() ? nullptr : it->second;
    }

    void unload(const std::string& name, int version) {
        // shared_ptr keeps it alive for in-flight requests
        std::unique_lock lk(mu_);
        engines_.erase({name, version});
    }

private:
    std::shared_mutex mu_;
    std::map<std::pair<std::string, int>, std::shared_ptr<Engine>> engines_;
};
```

The shared_ptr means the actual engine destruction happens when the last in-flight request finishes, regardless of when `unload` was called.

### Senior at FAANG: Build vs Buy

The honest take: in 2026, you almost never write a serving framework from scratch. Triton + TensorRT-LLM, vLLM, or NVIDIA Dynamo cover 95% of cases. The C++ work is in:

1. The wrapper that adapts the framework to your internal RPC system (not REST, but Stubby at Google, Thrift at Meta, gRPC at most others).
2. The kernels you want that the framework does not have (fused custom op).
3. The dispatcher that routes between models, between hardware tiers, between cloud regions.
4. The observability glue (metrics, logs, tracing).

Write the framework yourself only if you have a workload the open-source tools genuinely cannot handle (a research model with a novel architecture, an extreme latency target, a regulatory constraint). Otherwise, contribute back upstream and ship.

The next section covers observability for inference clusters.

---
