## CPU Inference and oneDNN

Most serious inference happens on GPUs in 2026. But CPU inference still owns three large niches: small models on commodity servers (where a GPU would be wasted), edge deployments without an accelerator, and large-model inference that uses the CPU as a tier in a heterogeneous system (KV cache offload, expert offload). This section covers the CPU inference stack in C++.

### oneDNN (Intel)

oneDNN (formerly MKL-DNN, then DNNL) is Intel's open-source library of CPU primitives for deep learning. It ships kernels for AVX2, AVX-512, AMX (Sapphire Rapids tile matmul), and ARM SVE. Used by PyTorch CPU, TensorFlow CPU, ONNX Runtime CPU EP, OpenVINO.

The C++ API is built on operator descriptors. A GEMM example:

```cpp
#include <oneapi/dnnl/dnnl.hpp>
namespace dnnl = oneapi::dnnl;

dnnl::engine eng(dnnl::engine::kind::cpu, 0);
dnnl::stream s(eng);

// [M, K] x [K, N] = [M, N] in FP32
dnnl::memory::dims a_dims = {M, K};
dnnl::memory::dims b_dims = {K, N};
dnnl::memory::dims c_dims = {M, N};

auto a_md = dnnl::memory::desc(a_dims, dnnl::memory::data_type::f32,
                                dnnl::memory::format_tag::ab);
auto b_md = dnnl::memory::desc(b_dims, dnnl::memory::data_type::f32,
                                dnnl::memory::format_tag::ab);
auto c_md = dnnl::memory::desc(c_dims, dnnl::memory::data_type::f32,
                                dnnl::memory::format_tag::ab);

auto a_mem = dnnl::memory(a_md, eng, A_data);
auto b_mem = dnnl::memory(b_md, eng, B_data);
auto c_mem = dnnl::memory(c_md, eng, C_data);

auto matmul_pd = dnnl::matmul::primitive_desc(eng, a_md, b_md, c_md);
auto matmul_p  = dnnl::matmul(matmul_pd);

matmul_p.execute(s, {{DNNL_ARG_SRC, a_mem},
                     {DNNL_ARG_WEIGHTS, b_mem},
                     {DNNL_ARG_DST, c_mem}});
s.wait();
```

oneDNN picks the best implementation at primitive creation: AVX-512 BF16 if available, AMX BF16 / INT8 on Sapphire Rapids and later, AVX2 fallback for old CPUs. You write the same code, it dispatches correctly.

For inference, the right pattern is: build all primitives at startup (slow), execute many times (fast). The primitive descriptor caches the optimal kernel choice for the given shapes.

### AVX-512 and AMX

**AVX-512.** 512-bit SIMD, 16 FP32 or 32 FP16 per instruction. Has a `VFMADD` (fused multiply-add) for matmul inner loops. Hits ~50 GFLOPS per core at FP32.

**AMX (Advanced Matrix Extensions).** Sapphire Rapids and later. 8 tile registers, each 16x64 bytes. Hardware INT8 / BF16 matmul: `TDPBSSD` does a 16x16 tile times 16x16 tile in one instruction. Hits ~2 TFLOPS BF16 per core.

A hand-written AMX kernel skeleton (you almost never write this, oneDNN does):

```cpp
#include <immintrin.h>

void amx_bf16_matmul_tile(const __bfloat16* A,   // 16 x K
                          const __bfloat16* B,   // K x 16
                          float* C,              // 16 x 16
                          int K) {
    _tile_zero(0);  // clear C tile
    for (int k = 0; k < K; k += 32) {  // AMX tile K dimension is 32 BF16 = 16 BF16 pairs
        _tile_loadd(1, A + 16 * k, /*stride=*/K * sizeof(__bfloat16));
        _tile_loadd(2, B + k * 16, /*stride=*/16 * sizeof(__bfloat16));
        _tile_dpbf16ps(0, 1, 2);  // C += A * B  (BF16 -> FP32 accum)
    }
    _tile_stored(0, C, /*stride=*/16 * sizeof(float));
}
```

The `_tile_*` intrinsics correspond directly to AMX instructions. You configure tile shapes via `_tile_loadconfig` once before the loop.

Real AMX kernels in production are written by Intel and shipped in oneDNN. For your engine, just call oneDNN.

### ARM NEON, SVE, SME

ARM equivalents.

**NEON.** 128-bit SIMD, on every modern ARM. INT8 / FP16 / FP32 / BF16. Standard.

**SVE / SVE2.** Scalable vector extension, 128 to 2048 bits depending on chip. Used in AWS Graviton 3, Fugaku.

**SME (Scalable Matrix Extension).** ARM's answer to AMX. Tile-based matmul. Apple M4, future Graviton.

The oneDNN ARM port (via Compute Library) covers NEON and SVE. ggml (used by llama.cpp) has hand-written NEON / SVE kernels. Apple's Accelerate framework has BNNS for NEON, MPS for GPU, MLX for unified memory.

### llama.cpp / ggml CPU Kernels

llama.cpp is the reference C++ inference engine for CPU LLM serving. The core data structure is `ggml_tensor`. The compute backends include CPU (NEON, AVX, AVX-512, AMX), Metal, CUDA, Vulkan, ROCm.

The CPU kernels are hand-written. A typical pattern for INT4 W4A16 inference:

```cpp
// Q4_0 quantization: 32 weights packed into 16 bytes (4 bits each) plus one FP16 scale
typedef struct {
    uint16_t scale;       // FP16 scale
    uint8_t qs[16];       // 32 packed 4-bit weights
} block_q4_0;

// Dot product with FP32 activation, AVX2
float vec_dot_q4_0_avx2(int n, const block_q4_0* x, const float* y) {
    __m256 acc = _mm256_setzero_ps();
    int n_blocks = n / 32;
    for (int i = 0; i < n_blocks; ++i) {
        __m128i q = _mm_loadu_si128((const __m128i*)x[i].qs);
        // Unpack 32 INT4 -> 32 INT8 (low and high nibbles)
        __m256i lo = _mm256_and_si256(_mm256_cvtepu8_epi16(q), _mm256_set1_epi16(0x0F));
        __m256i hi = _mm256_and_si256(_mm256_cvtepu8_epi16(_mm_srli_epi16(q, 4)),
                                       _mm256_set1_epi16(0x0F));
        // Convert to FP32, subtract zero point (8 for symmetric Q4_0)
        // Multiply by scale, accumulate dot with y[]
        __m256 scale = _mm256_set1_ps(half_to_float(x[i].scale));
        // ... (full implementation in ggml-quants.c)
    }
    // Horizontal sum of acc
    return reduce_add(acc);
}
```

llama.cpp's strength is portability: same code runs on a Raspberry Pi 5, an M4 Mac, a 128-core Xeon, an AMD EPYC. It loses to GPU on per-token cost for big models but wins on cost-effectiveness for small models on shared infrastructure.

### When CPU Inference Wins

1. **Small models, light traffic.** A 1B model running 5 RPS. A GPU is 95% idle. CPU is 30% used at half the cost.

2. **Fat tail / cold workloads.** A model that gets called rarely, where keeping a GPU warm is wasteful. Run on CPU, accept higher latency.

3. **Embeddings.** Sentence embedding models (all-MiniLM, BGE) are small enough that CPU at AVX-512 BF16 hits hundreds of QPS per core. Often cheaper than GPU.

4. **Edge.** No GPU available. Phone, IoT, on-device. CPU + NPU is the only path.

5. **CPU-only fleet.** Some shops still have huge CPU-only fleets (Cloudflare, some banks). Inference there is "free" capacity.

6. **KV cache offload.** Even on a GPU-primary setup, offloading old KV blocks to CPU RAM (and pulling them back via DMA on demand) extends effective context. Some llama.cpp deployments do hybrid GPU + CPU layer placement.

### The CPU Inference Engine Skeleton

A minimal LLM CPU inference engine (vastly simpler than vLLM):

```cpp
class CpuLlmEngine {
public:
    CpuLlmEngine(const std::string& model_path) {
        // Load weights via mmap (gguf format, like llama.cpp)
        load_gguf(model_path);
        // Prebuild oneDNN primitives for known shapes
        build_primitives();
    }

    std::vector<int> generate(const std::vector<int>& prompt, int max_new) {
        std::vector<int> out = prompt;
        // Prefill
        compute_kv_cache(out);
        // Decode
        for (int i = 0; i < max_new; ++i) {
            int next = decode_one_token(out);
            out.push_back(next);
            if (next == eos_) break;
        }
        return out;
    }

private:
    void compute_kv_cache(const std::vector<int>& tokens) {
        // Run prefill: full forward, fill K/V for all tokens.
    }
    int decode_one_token(const std::vector<int>& tokens) {
        // Forward one token through all layers.
        // Sample from the logits.
        return 0;
    }

    // Per-layer weights (already mmaped, possibly quantized)
    std::vector<dnnl::memory> w_qkv_, w_o_, w_gate_up_, w_down_, w_norm_;
    // KV cache (FP16 or INT8)
    std::vector<float> k_cache_, v_cache_;
    int eos_ = 2;
};
```

For a 7B model with INT4 quantization on a 16-core Xeon, expect ~30 tokens/sec single-batch. A modest GPU does 100x that, so the CPU is right only when GPU is unavailable or wasted.

### Senior at FAANG: When To Even Consider CPU

The honest answer at FAANG scale: rarely. The economics for any model above 7B point to GPU. CPU inference is the right answer for:

- Embedding pipelines where the model is tiny.
- Pre / post-processing (tokenization, detokenization, image decoding) that runs alongside the GPU work and would otherwise idle the CPU.
- Single-tenant on-prem deployments where the customer has no GPU.
- Specialized hardware tiers (Sapphire Rapids with AMX is competitive at small batch INT8 inference).

For everything else, GPU is the answer. Even when the model fits in CPU RAM and would technically run, the energy-per-token and dollars-per-token are wrong.

The next section covers mobile and edge inference, which is where CPU and integrated NPUs really shine.

---
