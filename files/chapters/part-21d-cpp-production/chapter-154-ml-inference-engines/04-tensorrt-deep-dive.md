## TensorRT Deep Dive

TensorRT is NVIDIA's inference compiler and runtime. It takes a network description (built directly via API, parsed from ONNX, or imported from TensorFlow / PyTorch) and produces a serialized engine that runs on a specific GPU architecture, at a specific batch / shape range, with a specific precision policy. The engine is faster than running the same graph through PyTorch eager, ORT CUDA EP, or any other generic runtime, because TensorRT does aggressive kernel fusion, quantization, and architecture-specific kernel auto-tuning at build time.

### The Five Core Objects

TensorRT's C++ API is built on five interfaces. Master these and the rest of the API falls out.

| Interface | Role |
|-----------|------|
| `IBuilder` | Compiles a network into an engine. Used once, offline or at startup. |
| `INetworkDefinition` | The graph being built. Layers and tensors. |
| `IBuilderConfig` | Build settings: precision, workspace size, optimization profiles, tactic sources. |
| `ICudaEngine` | The compiled, serializable artifact. Architecture-specific. |
| `IExecutionContext` | Per-stream execution state, including dynamic shape settings. Multiple contexts can share one engine. |

A typical build flow:

```cpp
#include <NvInfer.h>
#include <NvOnnxParser.h>
#include <fstream>
#include <vector>
#include <memory>

class Logger : public nvinfer1::ILogger {
public:
    void log(Severity s, const char* msg) noexcept override {
        if (s <= Severity::kWARNING) std::fprintf(stderr, "[TRT] %s\n", msg);
    }
};

std::vector<char> build_engine(const std::string& onnx_path) {
    Logger logger;
    auto builder = std::unique_ptr<nvinfer1::IBuilder>(
        nvinfer1::createInferBuilder(logger));

    auto network = std::unique_ptr<nvinfer1::INetworkDefinition>(
        builder->createNetworkV2(
            1U << static_cast<uint32_t>(
                nvinfer1::NetworkDefinitionCreationFlag::kEXPLICIT_BATCH)));

    auto parser = std::unique_ptr<nvonnxparser::IParser>(
        nvonnxparser::createParser(*network, logger));
    if (!parser->parseFromFile(onnx_path.c_str(),
                               static_cast<int>(nvinfer1::ILogger::Severity::kWARNING))) {
        for (int i = 0; i < parser->getNbErrors(); ++i) {
            std::fprintf(stderr, "%s\n", parser->getError(i)->desc());
        }
        return {};
    }

    auto config = std::unique_ptr<nvinfer1::IBuilderConfig>(
        builder->createBuilderConfig());
    config->setMemoryPoolLimit(
        nvinfer1::MemoryPoolType::kWORKSPACE, 2ULL << 30);  // 2 GB
    config->setFlag(nvinfer1::BuilderFlag::kFP16);

    // Dynamic shape profile: batch in [1, 32], seq in [128, 4096]
    auto profile = builder->createOptimizationProfile();
    profile->setDimensions("input_ids",
        nvinfer1::OptProfileSelector::kMIN, nvinfer1::Dims2{1, 128});
    profile->setDimensions("input_ids",
        nvinfer1::OptProfileSelector::kOPT, nvinfer1::Dims2{8, 1024});
    profile->setDimensions("input_ids",
        nvinfer1::OptProfileSelector::kMAX, nvinfer1::Dims2{32, 4096});
    config->addOptimizationProfile(profile);

    auto plan = std::unique_ptr<nvinfer1::IHostMemory>(
        builder->buildSerializedNetwork(*network, *config));

    return std::vector<char>(
        static_cast<char*>(plan->data()),
        static_cast<char*>(plan->data()) + plan->size());
}
```

The serialized plan is what you save to disk. You ship it with your binary or download it at startup. You should never ship a model that requires building on the production node, because TensorRT engine builds take minutes to hours.

### Inference Path

```cpp
class Engine {
public:
    Engine(const std::vector<char>& plan) {
        runtime_ = std::unique_ptr<nvinfer1::IRuntime>(
            nvinfer1::createInferRuntime(logger_));
        engine_ = std::unique_ptr<nvinfer1::ICudaEngine>(
            runtime_->deserializeCudaEngine(plan.data(), plan.size()));
        context_ = std::unique_ptr<nvinfer1::IExecutionContext>(
            engine_->createExecutionContext());
    }

    void infer(int batch, int seq,
               int32_t* input_ids_dev,
               float* output_dev,
               cudaStream_t stream) {
        // Set the dynamic shape for this call
        context_->setInputShape("input_ids", nvinfer1::Dims2{batch, seq});

        context_->setTensorAddress("input_ids", input_ids_dev);
        context_->setTensorAddress("output", output_dev);

        context_->enqueueV3(stream);
    }

private:
    Logger logger_;
    std::unique_ptr<nvinfer1::IRuntime> runtime_;
    std::unique_ptr<nvinfer1::ICudaEngine> engine_;
    std::unique_ptr<nvinfer1::IExecutionContext> context_;
};
```

Note `enqueueV3`. The older `enqueueV2` and `execute` APIs are deprecated. `enqueueV3` is async, takes a stream, and reads bindings from `setTensorAddress`.

### Precision and Quantization

TensorRT supports FP32, FP16, BF16, INT8, FP8 (E4M3 / E5M2 on Hopper / Blackwell), and INT4 (Blackwell, weight-only). You enable each with builder flags:

```cpp
config->setFlag(nvinfer1::BuilderFlag::kFP16);
config->setFlag(nvinfer1::BuilderFlag::kBF16);
config->setFlag(nvinfer1::BuilderFlag::kINT8);
config->setFlag(nvinfer1::BuilderFlag::kFP8);
config->setFlag(nvinfer1::BuilderFlag::kSTRICT_TYPES);  // disallow auto-fallback
```

Setting a flag *allows* the precision, the builder picks per-layer. To force a layer's precision:

```cpp
network->getLayer(i)->setPrecision(nvinfer1::DataType::kHALF);
network->getLayer(i)->setOutputType(0, nvinfer1::DataType::kHALF);
```

For INT8 you must provide a calibration cache or use explicit Q/DQ nodes in the ONNX graph (recommended approach in 2026):

```cpp
class Calibrator : public nvinfer1::IInt8EntropyCalibrator2 {
public:
    int getBatchSize() const noexcept override { return 32; }
    bool getBatch(void* bindings[], const char* names[], int n) noexcept override {
        if (current_ >= num_batches_) return false;
        cudaMemcpy(input_dev_,
                   &calib_data_[current_ * 32 * 3 * 224 * 224],
                   32 * 3 * 224 * 224 * sizeof(float),
                   cudaMemcpyHostToDevice);
        bindings[0] = input_dev_;
        ++current_;
        return true;
    }
    const void* readCalibrationCache(size_t& length) noexcept override {
        if (cache_.empty()) return nullptr;
        length = cache_.size();
        return cache_.data();
    }
    void writeCalibrationCache(const void* p, size_t n) noexcept override {
        cache_.assign(static_cast<const char*>(p),
                      static_cast<const char*>(p) + n);
    }
private:
    int current_ = 0, num_batches_ = 100;
    void* input_dev_ = nullptr;
    std::vector<float> calib_data_;
    std::vector<char> cache_;
};
```

The cache is a few KB. Save it. Rebuilding calibration on every engine build is wasted GPU time.

### Optimization Profiles for Dynamic Shapes

A single engine can carry multiple optimization profiles. Each profile defines `(min, opt, max)` dimensions for every dynamic input. The builder generates separate kernels for each profile and the execution context picks one before each run.

For an LLM you typically want:

- Profile 0: prefill (large `seq`, small `batch`).
- Profile 1: decode (`seq=1`, large `batch`).

These two regimes hit different kernels. Prefill is GEMM-heavy and benefits from large CTA tiles. Decode is GEMV-heavy and benefits from grid-stride loops. Splitting the profile lets TensorRT auto-tune each separately.

To switch profile at runtime:

```cpp
context_->setOptimizationProfileAsync(profile_index, stream);
```

### Plugin Layers

A plugin is a C++ class that extends TensorRT with a custom kernel. The 2026 plugin API is `IPluginV3` (older `IPluginV2` is deprecated).

```cpp
class RoPEPlugin : public nvinfer1::IPluginV3,
                   public nvinfer1::IPluginV3OneCore,
                   public nvinfer1::IPluginV3OneBuild,
                   public nvinfer1::IPluginV3OneRuntime {
public:
    int32_t enqueue(const nvinfer1::PluginTensorDesc* in_desc,
                    const nvinfer1::PluginTensorDesc* out_desc,
                    const void* const* inputs,
                    void* const* outputs,
                    void* /*workspace*/,
                    cudaStream_t stream) noexcept override {
        const half* x = static_cast<const half*>(inputs[0]);
        const half* freqs = static_cast<const half*>(inputs[1]);
        half* y = static_cast<half*>(outputs[0]);

        int B = in_desc[0].dims.d[0];
        int H = in_desc[0].dims.d[1];
        int S = in_desc[0].dims.d[2];
        int D = in_desc[0].dims.d[3];

        // Launch the RoPE kernel - full kernel in chapter section 7
        launch_rope_kernel(x, freqs, y, B, H, S, D, stream);
        return 0;
    }
    // GetCapabilityInterface, configure, getOutputDataTypes, etc...
};
```

You register the plugin with a `IPluginCreator` and then reference it from the network builder. Plugin layers are how you ship a kernel that TensorRT's built-in fusion does not produce, like a fused RoPE on a non-standard frequency table or a custom sampling kernel.

### Graph Fusion and Auto-Tuning

When the builder runs, it does dozens of passes:

- **MyConv -> BatchNorm -> ReLU** fuses to a single CUDNN call with the BN folded into the conv weights.
- **Linear -> GeLU** fuses to a CUBLAS-LT epilogue.
- **MatMul -> Add (bias) -> ReLU** fuses to a single epilogue.
- **Self-attention** (Q/K/V projection + scaled dot product + softmax + V projection) fuses to a FlashAttention-class kernel (TensorRT's `MHA` kernel for Hopper, `MHA_v3` for Blackwell).
- **LayerNorm / RMSNorm** fuse from their composite ops.

For each fusion candidate, TensorRT tries every kernel implementation it has (the "tactic sources": cuDNN, cuBLAS, cuBLASLt, JIT-generated, hand-tuned), runs each on the build GPU, and picks the fastest. This is the auto-tuning step. It is why builds take minutes. The result is an engine that is hand-optimized for *your* GPU, *your* shapes, *your* precision.

You can restrict tactic sources:

```cpp
config->setTacticSources(
    1U << static_cast<uint32_t>(nvinfer1::TacticSource::kCUBLAS_LT) |
    1U << static_cast<uint32_t>(nvinfer1::TacticSource::kCUDNN));
```

This is useful when you want reproducible builds across machines (limit tactics to deterministic ones) or when you want to disable a backend that you have measured to be slow on your shapes.

### Production Deploy Pattern

A real C++ TensorRT inference service has this structure:

```
loader thread
    -> reads engine plan from disk (or from S3 / object storage)
    -> deserializes into ICudaEngine (one per model)

worker thread pool
    -> N workers, each holding:
        -> IExecutionContext (cheap to create, ~ms)
        -> dedicated cudaStream_t
        -> dedicated input / output GPU buffers (allocated once)
    -> request queue feeds work to workers
    -> worker calls enqueueV3, waits on cudaEvent, returns response
```

The execution context is per-thread, the engine is shared. Streams are 1:1 with worker threads to avoid lock contention on the CUDA driver. GPU buffer pool sizing is an art, under-allocating causes per-request `cudaMalloc` (slow), over-allocating leaves VRAM on the table that could hold KV cache.

### Senior at FAANG: TensorRT-LLM

For LLMs specifically, NVIDIA ships TensorRT-LLM, a layer above TensorRT that knows about KV cache, paged attention, in-flight batching, speculative decoding, and tensor parallel. The C++ runtime is the production interface, the Python API is a builder DSL.

TensorRT-LLM has its own `Executor` class that wraps an engine and exposes async submit / response semantics with continuous batching built in:

```cpp
#include <tensorrt_llm/executor/executor.h>
namespace tle = tensorrt_llm::executor;

tle::Executor exec("llama3-70b-engine-dir", tle::ModelType::kDECODER_ONLY,
                   tle::ExecutorConfig{tle::SchedulerConfig{}, ...});

tle::Request req(input_token_ids,
                 /*max_new_tokens=*/256,
                 /*streaming=*/true,
                 tle::SamplingConfig{tle::SizeType32{1}});
auto rid = exec.enqueueRequest(std::move(req));

while (true) {
    auto responses = exec.awaitResponses(rid, std::chrono::milliseconds{50});
    for (auto& r : responses) {
        if (r.hasError()) break;
        auto& result = r.getResult();
        for (auto tok : result.outputTokenIds[0]) {
            std::cout << tok << ' ';
        }
        if (result.isFinal) break;
    }
}
```

This is the API path you use at the top of an LLM serving system at any NVIDIA shop. Internally it does PagedAttention, in-flight batching, and chunk prefill. Section 09 covers the engine design that produces this API, section 18 covers the serving wrappers.

The next section steps back to LibTorch, which is the right answer when you need to ship a PyTorch model without converting to ONNX or TensorRT.

---
