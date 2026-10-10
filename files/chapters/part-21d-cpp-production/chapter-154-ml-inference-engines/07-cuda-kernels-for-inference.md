## CUDA Kernels for Inference

The kernels that run inside an inference engine fall into a small set of categories: GEMM (matmul), GEMV (matrix-vector for decode), attention, normalization, activation, embedding, sampling, KV cache I/O. Each has a canonical implementation backed by NVIDIA libraries, and each has a hand-written variant that you might write to fuse with neighbors. This section covers what each kernel does, which library to call, and when to write your own.

### cuBLAS, cuBLASLt, and CUTLASS for GEMM

A linear layer in a transformer (Q/K/V projection, MLP up / down) is a GEMM: `Y = alpha * X @ W^T + beta * Y`. You should never write this from scratch. Three NVIDIA-provided options:

**cuBLAS.** Classic API. Good for FP32 / FP16 / BF16, simple GEMMs. No fused epilogues (bias add, activation function done in a separate kernel).

**cuBLASLt.** Modern API. Supports fused epilogues, FP8, INT8, mixed precision, batched GEMM with stride tricks, and the heuristics engine to pick the best algorithm at runtime. Use this for any new code.

**CUTLASS.** Header-only template library. Same hardware paths as cuBLASLt but you can compile-time-specialize, fuse arbitrary epilogues, and write custom GEMM-shaped kernels (FlashAttention is built on top of CUTLASS). Use this when you need a fused op cuBLASLt does not provide.

A cuBLASLt FP16 GEMM with bias add and GeLU epilogue:

```cpp
#include <cublasLt.h>

void gemm_bias_gelu_fp16(
    cublasLtHandle_t lt, cudaStream_t stream,
    const half* A, int A_ld,    // [M, K]
    const half* B, int B_ld,    // [K, N]
    const half* bias,           // [N]
    half* C, int C_ld,          // [M, N]
    int M, int N, int K,
    void* workspace, size_t workspace_size) {

    cublasLtMatmulDesc_t op_desc = nullptr;
    cublasLtMatmulDescCreate(&op_desc, CUBLAS_COMPUTE_16F, CUDA_R_16F);

    cublasOperation_t op_n = CUBLAS_OP_N;
    cublasLtMatmulDescSetAttribute(op_desc,
        CUBLASLT_MATMUL_DESC_TRANSA, &op_n, sizeof(op_n));
    cublasLtMatmulDescSetAttribute(op_desc,
        CUBLASLT_MATMUL_DESC_TRANSB, &op_n, sizeof(op_n));

    cublasLtEpilogue_t epi = CUBLASLT_EPILOGUE_GELU_BIAS;
    cublasLtMatmulDescSetAttribute(op_desc,
        CUBLASLT_MATMUL_DESC_EPILOGUE, &epi, sizeof(epi));
    cublasLtMatmulDescSetAttribute(op_desc,
        CUBLASLT_MATMUL_DESC_BIAS_POINTER, &bias, sizeof(bias));

    cublasLtMatrixLayout_t a_layout, b_layout, c_layout;
    cublasLtMatrixLayoutCreate(&a_layout, CUDA_R_16F, M, K, A_ld);
    cublasLtMatrixLayoutCreate(&b_layout, CUDA_R_16F, K, N, B_ld);
    cublasLtMatrixLayoutCreate(&c_layout, CUDA_R_16F, M, N, C_ld);

    cublasLtMatmulPreference_t pref = nullptr;
    cublasLtMatmulPreferenceCreate(&pref);
    cublasLtMatmulPreferenceSetAttribute(pref,
        CUBLASLT_MATMUL_PREF_MAX_WORKSPACE_BYTES,
        &workspace_size, sizeof(workspace_size));

    cublasLtMatmulHeuristicResult_t heuristic{};
    int returned = 0;
    cublasLtMatmulAlgoGetHeuristic(lt, op_desc,
        a_layout, b_layout, c_layout, c_layout,
        pref, 1, &heuristic, &returned);

    half alpha = __float2half(1.0f), beta = __float2half(0.0f);
    cublasLtMatmul(lt, op_desc,
        &alpha, A, a_layout, B, b_layout,
        &beta,  C, c_layout, C, c_layout,
        &heuristic.algo, workspace, workspace_size, stream);

    cublasLtMatmulPreferenceDestroy(pref);
    cublasLtMatrixLayoutDestroy(a_layout);
    cublasLtMatrixLayoutDestroy(b_layout);
    cublasLtMatrixLayoutDestroy(c_layout);
    cublasLtMatmulDescDestroy(op_desc);
}
```

The heuristic call is the expensive part. Cache the resulting `algo` per shape and reuse it. Most engines build a `(M, N, K, dtype) -> algo` lookup table at startup or first-use.

For decode (M=batch, K=hidden, N=hidden), M is small (1 to 32), so this is really a GEMV. cuBLASLt does pick GEMV-shaped kernels here, but custom split-K kernels (Marlin, Machete, exllama) often beat it for very small M. This is a place where writing your own kernel still pays off.

### cuDNN for Convolution

For ConvNets, cuDNN is the call. It does Winograd, FFT-based, GEMM-based, and direct convolution algorithms. The frontend API (cuDNN 8+):

```cpp
#include <cudnn_frontend.h>
namespace fe = cudnn_frontend;

auto graph = std::make_shared<fe::graph::Graph>();
graph->set_io_data_type(fe::DataType_t::HALF)
      .set_intermediate_data_type(fe::DataType_t::FLOAT)
      .set_compute_data_type(fe::DataType_t::FLOAT);

auto X = graph->tensor(fe::graph::Tensor_attributes()
    .set_name("X").set_dim({N, C, H, W}).set_stride({C*H*W, 1, C*W, C}));
auto W = graph->tensor(fe::graph::Tensor_attributes()
    .set_name("W").set_dim({K, C, R, S}).set_stride({C*R*S, 1, C*S, C}));
auto conv_attr = fe::graph::Conv_fprop_attributes()
    .set_padding({1, 1}).set_stride({1, 1}).set_dilation({1, 1});
auto Y = graph->conv_fprop(X, W, conv_attr);
Y->set_output(true);

graph->validate();
graph->build_operation_graph(handle);
graph->create_execution_plans({fe::HeurMode_t::A});
graph->build_plans(handle);
graph->execute(handle, var_pack, workspace);
```

For LLMs, cuDNN is mostly irrelevant (no convolution). For vision and speech models, it is the foundation.

### FlashAttention v3

The attention computation is `softmax(Q @ K^T / sqrt(d)) @ V`. The naive implementation materializes the `[S, S]` attention matrix, which is `O(S^2)` memory. For S=8192 and FP16 that is 128 MB per head per layer. A 32-head 32-layer model materializes 128 GB of intermediate. Unworkable.

FlashAttention does not materialize. It tiles Q and K, computes partial softmax statistics (running max, running sum) per tile, and accumulates the output without ever writing the attention matrix to HBM. Memory is `O(S)` instead of `O(S^2)`. Speed is 2 to 5x because no HBM I/O for the intermediate.

FlashAttention v3 (Hopper-specific, 2024) added:

1. **Asynchronous warpgroup matmul (WGMMA).** Launch the matmul async, do softmax statistics in parallel, sync at the end. Hides softmax latency.
2. **FP8 (E4M3) attention.** Native E4M3 matmuls in the inner loop, descale to FP16 for the softmax.
3. **Persistent kernels.** One kernel launch covers the whole attention op, no host round-trip.

In production C++ you do not write FlashAttention from scratch. You link against:

- `flash-attn` (the official open-source CUTLASS-based implementation).
- TensorRT-LLM's `gpt_attention` plugin (FlashAttention v3 + paged KV).
- vLLM's `flash_attn` integration plus its PagedAttention kernels.
- cuDNN 9's fused attention API (newer, native NVIDIA path).

The cuDNN 9 fused attention is the simplest from the C++ side:

```cpp
auto Q = graph->tensor(...);
auto K = graph->tensor(...);
auto V = graph->tensor(...);
auto sdpa_attr = fe::graph::SDPA_attributes()
    .set_is_inference(true)
    .set_causal_mask(true)
    .set_attn_scale(1.0f / std::sqrt(head_dim));
auto [O, stats] = graph->sdpa(Q, K, V, sdpa_attr);
O->set_output(true);
```

This produces a kernel that is FlashAttention-3 grade on Hopper / Blackwell.

### Fused MLP: GeGLU Pattern

Llama-class models use SwiGLU (or GeGLU): `MLP(x) = down_proj(silu(gate_proj(x)) * up_proj(x))`. Three GEMMs and an elementwise op. The standard fusion: combine `gate_proj` and `up_proj` into a single `[hidden, 2*intermediate]` GEMM (the "fused gate up" trick), then a single elementwise SwiGLU kernel, then the down GEMM.

```cpp
// Custom kernel for the SwiGLU step
__global__ void swiglu_kernel(
    const half* __restrict__ x,  // [B*S, 2*I], gate concat up
    half* __restrict__ y,        // [B*S, I]
    int M, int I) {
    int row = blockIdx.x;
    int col = threadIdx.x + blockIdx.y * blockDim.x;
    if (row >= M || col >= I) return;
    half g = x[row * 2 * I + col];        // gate
    half u = x[row * 2 * I + I + col];    // up
    float gf = __half2float(g);
    float silu_g = gf / (1.0f + expf(-gf));
    y[row * I + col] = __float2half(silu_g * __half2float(u));
}
```

Launch with a grid of `(M, ceil_div(I, 256))` and 256 threads. For best occupancy on H100, use vectorized loads (`half2`) to halve the instruction count, and unroll the inner column loop.

### RoPE Fused into QK Projection

Rotary position embeddings rotate Q and K by a position-dependent angle before attention. Naive: do the QKV projection, then a separate kernel for RoPE, then attention. Better: fuse RoPE into the attention kernel itself (FlashAttention v3 does this) or into the QK projection epilogue.

A standalone RoPE kernel for the case where you cannot fuse:

```cpp
__global__ void rope_kernel(
    half* __restrict__ q,       // [B, H, S, D]
    half* __restrict__ k,       // [B, H, S, D]
    const float* __restrict__ cos,  // [S, D/2]
    const float* __restrict__ sin,  // [S, D/2]
    int B, int H, int S, int D) {
    int b = blockIdx.z;
    int h = blockIdx.y;
    int s = blockIdx.x;
    int d_pair = threadIdx.x;
    if (d_pair >= D / 2) return;

    int idx0 = ((b * H + h) * S + s) * D + d_pair;
    int idx1 = idx0 + D / 2;

    float c = cos[s * (D/2) + d_pair];
    float si = sin[s * (D/2) + d_pair];

    float q0 = __half2float(q[idx0]);
    float q1 = __half2float(q[idx1]);
    q[idx0] = __float2half(q0 * c - q1 * si);
    q[idx1] = __float2half(q0 * si + q1 * c);

    float k0 = __half2float(k[idx0]);
    float k1 = __half2float(k[idx1]);
    k[idx0] = __float2half(k0 * c - k1 * si);
    k[idx1] = __float2half(k0 * si + k1 * c);
}
```

Real implementations vectorize loads to `half2`, handle the GPT-NeoX vs Llama RoPE layout difference (paired vs interleaved), and accept FP8 inputs on Blackwell.

### NVRTC: Runtime Kernel Compilation

For sizes you only learn at runtime (a custom batch size, a model with unusual dimensions), you can JIT-compile a kernel with NVRTC.

```cpp
#include <nvrtc.h>
#include <cuda.h>

const char* src = R"(
extern "C" __global__ void scaled_add(
    const float* a, const float* b, float* c, float s, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + s * b[i];
})";

nvrtcProgram prog;
nvrtcCreateProgram(&prog, src, "scaled_add.cu", 0, nullptr, nullptr);
const char* opts[] = {"-arch=sm_90a", "-default-device"};
nvrtcCompileProgram(prog, 2, opts);

size_t ptx_size;
nvrtcGetPTXSize(prog, &ptx_size);
std::string ptx(ptx_size, 0);
nvrtcGetPTX(prog, ptx.data());

CUmodule module;
cuModuleLoadData(&module, ptx.data());
CUfunction fn;
cuModuleGetFunction(&fn, module, "scaled_add");

void* args[] = {&a_dev, &b_dev, &c_dev, &scale, &n};
cuLaunchKernel(fn, n/256, 1, 1, 256, 1, 1, 0, stream, args, nullptr);
```

This is how OpenAI's Triton compiler operates internally: Python frontend, NVRTC backend, persistent cache of compiled kernels keyed on shape signature.

### When To Write Your Own Kernel

In 2026, most engines that "write CUDA kernels" are really gluing together cuBLASLt, cuDNN, FlashAttention, and a few elementwise / reduction kernels (RMSNorm, RoPE, sampling). The kernels you actually write yourself:

- Sampling (top-k, top-p, temperature, presence penalty).
- Custom losses or activation functions.
- Fused position embedding + cache write.
- Quantized GEMM variants for shapes the libraries miss (split-K small-M).
- Speculative decoding draft logic.

For everything else, link the library. NVIDIA has more engineers tuning cuBLASLt than your team has total.

The next section dives into the attention kernel family in detail.

---
