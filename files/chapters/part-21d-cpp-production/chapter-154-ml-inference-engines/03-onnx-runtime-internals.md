## ONNX Runtime Internals

ONNX Runtime (ORT) is the most widely deployed inference runtime that is not tied to a specific framework. Microsoft built it, open sourced it, and it now powers Office, Windows ML, Azure ML, Bing search ranking, and most third-party deployments that need a single artifact to run on CPU, NVIDIA GPU, AMD GPU, Intel CPU AVX-512, ARM Cortex-A, and mobile NPUs. The C++ API is the production interface. The Python binding is for prototyping.

### Graph IR

ONNX itself is a serialization format. A `.onnx` file is a protobuf containing a `ModelProto`, which contains a `GraphProto`, which contains a list of `NodeProto` (operators) and `TensorProto` (initializers / weights). Each node names an op (Conv, MatMul, Gelu, Attention) by its op type and opset version.

ORT loads the ONNX graph into an internal `Graph` object. The internal IR is similar but mutable, supports subgraph extraction, and tracks shape inference results. The graph goes through several passes:

1. **Shape inference.** Walk the graph, propagating shapes from inputs through every op. Static shapes enable kernel selection, dynamic shapes (-1 dims) are represented symbolically.
2. **Constant folding.** Evaluate any subgraph whose inputs are all initializers. Replace with the result.
3. **Op fusion.** Pattern-match common subgraphs (LayerNorm = ReduceMean + Sub + Pow + ReduceMean + Add + Sqrt + Div + Mul + Add) and replace with a single fused op.
4. **Layout assignment.** Decide NCHW vs NHWC per node, insert transposes where needed, then run another pass to cancel adjacent transposes.
5. **Execution provider partitioning.** Walk the graph, ask each registered provider which nodes it can run, and assign nodes to providers.

The output is an executable `SessionState` containing a kernel table (one CPU or CUDA kernel function per node), a memory plan (which buffer goes where, with reuse), and a sequence of execution steps.

### Execution Providers

An execution provider (EP) is the abstraction for a backend. Each EP implements a fixed C++ interface:

```cpp
class IExecutionProvider {
public:
    virtual std::vector<std::unique_ptr<ComputeCapability>>
        GetCapability(const GraphViewer& graph,
                      const KernelLookup& kernel_lookup) const = 0;

    virtual common::Status Compile(
        const std::vector<FusedNodeAndGraph>& fused_nodes,
        std::vector<NodeComputeInfo>& node_compute_funcs) = 0;

    virtual std::shared_ptr<KernelRegistry> GetKernelRegistry() const = 0;
    virtual const std::string& Type() const = 0;
};
```

The standard EPs that ship with ORT in 2026:

| EP | Target | Notes |
|----|--------|-------|
| CPU | x86, ARM | AVX2 / AVX-512 / AMX / NEON / SVE kernels |
| CUDA | NVIDIA GPU | cuBLAS / cuDNN backed, FP16 / BF16 |
| TensorRT | NVIDIA GPU | Compiles subgraphs to TRT engines, fastest path |
| DirectML | Windows GPU | DX12, vendor-agnostic on Windows |
| CoreML | Apple Silicon | ANE + GPU + CPU |
| ROCm | AMD GPU | hipBLAS / MIOpen |
| OpenVINO | Intel CPU / iGPU / VPU | Intel-specific, very fast on Xeon |
| QNN | Qualcomm Snapdragon | Mobile NPU |
| WebGPU | Browser | Cross-platform GPU |
| MIGraphX | AMD | Alternative AMD path |
| CANN | Huawei Ascend | Chinese hyperscaler hardware |

The partitioner asks each EP, in priority order, which nodes it claims. The TensorRT EP claims as much as it can (TRT is faster than the CUDA EP on most graphs). What it cannot claim falls to CUDA EP. What CUDA cannot claim falls to CPU EP. The result is a hybrid execution plan with explicit memory transfers between providers.

### Session and the C++ API

The minimal C++ usage:

```cpp
#include <onnxruntime_cxx_api.h>
#include <iostream>
#include <vector>
#include <array>

int main() {
    Ort::Env env(ORT_LOGGING_LEVEL_WARNING, "inference");
    Ort::SessionOptions opts;
    opts.SetIntraOpNumThreads(4);
    opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

    // Append providers in priority order (highest first)
    OrtCUDAProviderOptionsV2* cuda_opts = nullptr;
    Ort::GetApi().CreateCUDAProviderOptions(&cuda_opts);
    opts.AppendExecutionProvider_CUDA_V2(*cuda_opts);
    Ort::GetApi().ReleaseCUDAProviderOptions(cuda_opts);

    Ort::Session session(env, "model.onnx", opts);

    Ort::AllocatorWithDefaultOptions allocator;
    Ort::MemoryInfo mem_info = Ort::MemoryInfo::CreateCpu(
        OrtArenaAllocator, OrtMemTypeDefault);

    std::array<int64_t, 4> shape{1, 3, 224, 224};
    std::vector<float> input(1 * 3 * 224 * 224, 0.0f);

    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        mem_info, input.data(), input.size(), shape.data(), shape.size());

    const char* input_names[] = {"input"};
    const char* output_names[] = {"output"};

    auto outputs = session.Run(Ort::RunOptions{nullptr},
                               input_names, &input_tensor, 1,
                               output_names, 1);

    float* out_data = outputs[0].GetTensorMutableData<float>();
    std::cout << "First logit: " << out_data[0] << std::endl;
}
```

The `Ort::Value` is a tagged union: tensor, sparse tensor, sequence, or map. For tensors it owns or borrows a buffer plus shape and dtype. Borrowing avoids copies but you must keep the source alive across `Run`.

### IO Bindings: The Performance Path

The simple `Run` shown above copies the input from CPU to GPU at the start of each call and copies the output back. For a model that runs in 5 ms, those copies can be 2 ms each. Unacceptable on the hot path.

`IoBinding` solves this. You allocate input and output buffers on the GPU once, bind them to the session, and then call `RunWithBinding` repeatedly. The runtime never touches the host.

```cpp
Ort::IoBinding binding(session);

Ort::MemoryInfo cuda_mem("Cuda", OrtArenaAllocator, 0, OrtMemTypeDefault);
Ort::Allocator cuda_alloc(session, cuda_mem);

// Allocate GPU input
auto input_gpu = Ort::Value::CreateTensor<float>(
    cuda_alloc, shape.data(), shape.size());

// Pre-fill via a CUDA memcpy from your existing GPU pipeline
cudaMemcpy(input_gpu.GetTensorMutableData<float>(),
           upstream_gpu_buffer,
           sizeof(float) * 1*3*224*224,
           cudaMemcpyDeviceToDevice);

binding.BindInput("input", input_gpu);

// Output: let ORT allocate on GPU
binding.BindOutput("output", cuda_mem);

session.Run(Ort::RunOptions{}, binding);

auto output_values = binding.GetOutputValues();
// output_values[0] is on GPU - downstream consumes via cudaMemcpy or another binding
```

For an LLM streaming loop you bind once and reuse the buffers across thousands of token iterations.

### Custom Operators

When a model has an op the runtime does not implement, you write a custom op in C++:

```cpp
struct ScaledTanhKernel {
    ScaledTanhKernel(const OrtApi& api, const OrtKernelInfo* info) {
        Ort::ConstKernelInfo ki(info);
        scale_ = ki.GetAttribute<float>("scale");
    }

    void Compute(OrtKernelContext* ctx) {
        Ort::KernelContext kc(ctx);
        auto input = kc.GetInput(0);
        const float* x = input.GetTensorData<float>();
        auto shape = input.GetTensorTypeAndShapeInfo().GetShape();
        size_t n = 1;
        for (auto d : shape) n *= d;

        auto output = kc.GetOutput(0, shape.data(), shape.size());
        float* y = output.GetTensorMutableData<float>();
        for (size_t i = 0; i < n; ++i) {
            y[i] = scale_ * std::tanh(x[i]);
        }
    }
private:
    float scale_;
};

struct ScaledTanhOp : Ort::CustomOpBase<ScaledTanhOp, ScaledTanhKernel> {
    void* CreateKernel(const OrtApi& api, const OrtKernelInfo* info) const {
        return new ScaledTanhKernel(api, info);
    }
    const char* GetName() const { return "ScaledTanh"; }
    size_t GetInputTypeCount() const { return 1; }
    ONNXTensorElementDataType GetInputType(size_t) const {
        return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
    }
    size_t GetOutputTypeCount() const { return 1; }
    ONNXTensorElementDataType GetOutputType(size_t) const {
        return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;
    }
};
```

You register it in a custom op domain at session creation:

```cpp
Ort::CustomOpDomain domain("com.mycompany");
ScaledTanhOp op;
domain.Add(&op);
opts.Add(domain);
```

For GPU custom ops you provide a CUDA kernel and use the `Ort::Custom::ComputeFunction` GPU variant, which gives you the CUDA stream the runtime is using.

### Threading Model

ORT has two thread pools.

**Intra-op thread pool.** Parallelism inside a single kernel. A GEMM might split its tiles across these threads. Set with `SetIntraOpNumThreads`.

**Inter-op thread pool.** Parallelism across nodes. If two branches of the graph are independent, they can run on different inter-op threads. Set with `SetInterOpNumThreads`.

For a CPU-bound graph, intra-op = number of physical cores, inter-op = 1 is a typical baseline. For a GPU graph, intra-op is irrelevant (kernels run on GPU streams) and inter-op = 1 is fine. Setting `ExecutionMode::ORT_PARALLEL` with inter-op > 1 gives you parallel branch execution but creates contention with anything else on the box.

For a server with many concurrent sessions, you typically use `ORT_SEQUENTIAL` and rely on multiple Session objects (one per request) sharing the same Env (which owns the thread pools). The Env-level thread pools must be sized for the total concurrency, not per session.

### Senior at FAANG: When ORT Is The Right Choice

ORT is a great default for a heterogeneous fleet. You get one model artifact, one runtime build, and the runtime picks the best EP per machine. It is the right choice when:

- You need to support multiple GPU vendors (NVIDIA + AMD + Intel) from one binary.
- You need CPU fallback for nodes the GPU cannot run (rare ops, or fallback for low-traffic deployments).
- Your model is not strictly an LLM (vision, speech, ranking).
- You need the model to run on Windows + Linux + Mac + mobile from one toolchain.

It is the wrong choice when:

- You are running an LLM at scale. Use TensorRT-LLM or vLLM. ORT's LLM support exists but lags both.
- You need bleeding-edge kernels (FlashAttention v3 day-of-release). TRT and vLLM ship faster.
- You have a single-vendor GPU fleet and want every drop of performance. TensorRT will beat the CUDA EP on most graphs by 10 to 30%.

The next section covers TensorRT, which is the default at NVIDIA-shop production deployments.

---
