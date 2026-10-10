## Quantization: INT8, FP8, FP4, and MX Formats

A 70B-parameter model in FP16 takes 140 GB of weights. On an H100 (80 GB) it does not fit in one GPU. On four H100s with tensor parallel, the weights fit and you have ~50 GB left across the four GPUs for KV cache and activations. Quantize that same model to INT4 weight-only and the weights drop to ~35 GB, so it fits on a single H100 with 45 GB of headroom. The same logic at every model size, with corresponding cost reductions in \$/token.

Quantization is the single highest-use optimization in modern inference. This section covers the formats, the algorithms, and the C++ data types you will be passing to kernels.

### The Goal: Smaller Numbers, Same Output

A weight tensor is a real-valued matrix. FP32 represents each element with 32 bits, FP16 with 16, INT8 with 8, INT4 with 4, FP4 with 4. The math:

- 70B FP16 = 140 GB
- 70B INT8 = 70 GB
- 70B INT4 = 35 GB
- 70B FP4 = 35 GB
- 70B FP8 = 70 GB

Memory bandwidth on H100 is 3.35 TB/s. Reading the full weight tensor once costs:

- FP16: 140e9 / 3.35e12 = 41.8 ms
- INT8: 21 ms
- INT4: 10 ms
- FP4: 10 ms

For decode (which is memory-bound), this number is roughly the per-token latency floor. Quantizing weights from FP16 to INT4 quarters the floor.

### Post-Training Quantization (PTQ)

PTQ takes a trained FP16 model and converts the weights, with no retraining. The key choice is the scaling scheme.

**Symmetric per-tensor.** One scale per tensor: `q = round(x / scale)`, `x_recovered = q * scale`. Crude, large quantization error on tensors with outlier values.

**Asymmetric per-tensor.** One scale and one zero-point per tensor: `q = round(x / scale + zp)`. Better for activations that have non-zero means.

**Per-channel.** One scale per output channel of a weight matrix. Far smaller error because each channel has its own range. Standard for weight quantization since 2020.

**Per-group.** One scale per group of 32 / 64 / 128 elements within a channel. Standard for INT4 weight-only quantization (GPTQ, AWQ).

For inference kernels you need to know two scaling schemes by heart:

```cpp
// Per-channel symmetric, INT8 weights
struct LinearINT8 {
    int8_t* weight;       // [out_features, in_features]
    float* w_scale;       // [out_features]  one per output channel
    float* bias;          // [out_features]  optional
};

// Per-group INT4, weight-only (AWQ / GPTQ format)
struct LinearINT4 {
    uint8_t* weight;      // [out_features, in_features / 2]  packed 2 nibbles per byte
    half* scales;         // [out_features, in_features / group_size]
    int group_size;       // typically 128
};
```

### Quantization-Aware Training (QAT)

QAT inserts fake quantization ops into the forward pass during training. The model learns to be robust to quantization error. Output quality is higher than PTQ at low bit widths (INT4, INT2) at the cost of retraining.

You rarely write QAT inference code, because the deployed artifact looks identical to PTQ output. Just make sure your inference kernel matches the simulated quantizer used in training (rounding mode, clipping range, group size). Mismatches there are silent accuracy killers.

### Weight-Only Quantization: GPTQ and AWQ

The dominant approach for LLM inference in 2024-2026 is W4A16: weights in INT4 (per-group), activations in FP16 (or BF16). The kernel:

1. Loads packed INT4 weights from global memory.
2. Dequantizes to FP16 in registers using the group scale.
3. Performs the GEMM in FP16 against the FP16 activation.

The win is bandwidth: you read 4 bits per weight instead of 16, so the GEMM is 4x faster on the memory bound. The math runs in FP16 so accuracy stays high.

GPTQ and AWQ are two algorithms for picking the per-group scales:

- **GPTQ**: minimizes second-order reconstruction error using the Hessian of the model loss, processed column by column in each weight matrix. Slow to compute (hours for a 70B model). High accuracy.
- **AWQ** (Activation-aware Weight Quantization): observes that some weight channels matter more (those that get multiplied by large activations). Picks scales that protect those channels. Faster to compute, similar accuracy.

In production you grab the AWQ or GPTQ checkpoint from HuggingFace, ship it as-is. The C++ engine just needs the dequantize-and-GEMM kernel. This is `gemm_w4a16` in vLLM, `Marlin` (a popular fast kernel), or the cuBLASLt `mxfp4` epilogue on Blackwell.

```cpp
// Skeleton of a W4A16 GEMM kernel call
void linear_w4a16(
    const half* x,            // [M, K] activations FP16
    const uint8_t* w_packed,  // [N, K/2] packed INT4 weights
    const half* scales,       // [N, K/group_size] FP16 scales
    half* y,                  // [M, N] output FP16
    int M, int N, int K, int group_size,
    cudaStream_t stream);
```

Internally the kernel uses Tensor Cores. The dequantization is done in registers with bit-tricks: extract the 4-bit value, subtract the zero-point (often 8 for symmetric INT4), multiply by the FP16 scale.

### KV Cache Quantization

The KV cache is often larger than the weights for long contexts. A 70B model with 8 GPUs tensor parallel and 100k tokens of context can have a KV cache of 50+ GB.

Quantizing the KV cache to INT8 or FP8 halves it. The accuracy hit is small because attention is robust to noise on K and V (the softmax over many keys averages out per-key quantization error).

```cpp
// FP8 E5M2 KV cache layout (vLLM, TensorRT-LLM in 2026)
struct KVCacheFP8 {
    __nv_fp8_storage_t* k;   // [num_blocks, num_heads, block_size, head_dim]
    __nv_fp8_storage_t* v;   // [num_blocks, num_heads, head_dim, block_size]
    half* k_scales;          // [num_blocks, num_heads]
    half* v_scales;          // [num_blocks, num_heads]
};
```

E5M2 (5 exponent, 2 mantissa) has high dynamic range but low precision, good for KV. E4M3 (4 exponent, 3 mantissa) has higher precision, used for activations. Hopper FP8 hardware supports both.

### FP8 (E4M3 and E5M2)

NVIDIA Hopper added native FP8 Tensor Cores. Two formats:

| Format | Exp | Mantissa | Range | Precision | Used for |
|--------|-----|----------|-------|-----------|----------|
| E4M3 | 4 | 3 | ~ +/- 448 | 1 / 8 step | Activations, weights for inference |
| E5M2 | 5 | 2 | ~ +/- 57344 | 1 / 4 step | Gradients (in training), KV cache |

The C++ types are `__nv_fp8_e4m3` and `__nv_fp8_e5m2` from `cuda_fp8.h`.

```cpp
#include <cuda_fp8.h>

__nv_fp8_e4m3 a(0.5f);
float a_back = static_cast<float>(a);

// Tensor Core FP8 GEMM via cuBLASLt
cublasLtMatmul(handle, op_desc,
               &alpha,
               weights, w_layout,    // E4M3
               input,   in_layout,   // E4M3
               &beta,
               output_fp16, out_layout,
               output_fp16, out_layout,
               nullptr, workspace, workspace_size, stream);
```

The H100 hits 2 PFLOPS at FP8. Twice the FP16 rate. For a model in FP8, you get half the memory and twice the compute. The accuracy is close to FP16 for most LLMs after a brief calibration, especially with per-tensor or per-channel scaling factors.

### MX Formats: MXFP4, MXFP6, MXFP8

Microscaling formats are the OCP-standardized successor to per-group INT4. Each group of 32 elements has one shared 8-bit scale, and the elements themselves are 4, 6, or 8 bits. Blackwell GPUs have native MXFP4 and MXFP6 Tensor Cores, hitting 5+ PFLOPS at MXFP4.

| Format | Element bits | Block size | Throughput on B200 |
|--------|--------------|------------|-------------------|
| MXFP8 (E4M3) | 8 | 32 | 4.5 PFLOPS dense |
| MXFP6 (E2M3 / E3M2) | 6 | 32 | ~9 PFLOPS dense |
| MXFP4 (E2M1) | 4 | 32 | 18 PFLOPS dense |
| MXINT8 | 8 | 32 | similar to FP8 |

The packing for MXFP4: 32 4-bit elements (16 bytes) plus one E8M0 scale (1 byte). 17 bytes for 32 elements = 4.25 bits per element on average.

In CUDA C++ on Blackwell, you use the `wgmma.mma_async` PTX instruction with the `e2m1` qualifier:

```cpp
// Pseudo-PTX, real syntax in Blackwell PTX guide:
// wgmma.mma_async.sync.aligned.m64n128k64.f16.e2m1.e2m1
```

The dominant production format for FP4 LLM inference in 2026 is MXFP4 with grouped scales, because the hardware does the dequant-on-the-fly step inside the Tensor Core, with no register pressure cost.

### Bias Correction

After PTQ, the per-tensor mean of the output activations can drift from the FP16 baseline. Bias correction fixes this with one statistic-pass over a calibration set:

```python
# pseudo
for layer in model.linear_layers:
    delta = activations_fp16.mean(dim=0) - activations_quantized.mean(dim=0)
    layer.bias += delta
```

This is a free accuracy boost. Most production quantization tools (TensorRT, AIMET, llm-compressor) include it.

### What To Quantize To, In 2026

The current production matrix:

| Use case | Format | Why |
|----------|--------|-----|
| LLM weights, single GPU fits | INT4 W4A16 (AWQ / GPTQ) | Fits more model in less VRAM, kernel is fast |
| LLM weights, Hopper / Blackwell | FP8 W8A8 or MXFP4 W4A4 | Native tensor core support, full speedup |
| KV cache | FP8 E5M2 | Halves cache, minor accuracy cost |
| Vision models | INT8 PTQ per-channel | Standard, well-understood |
| Speech models | INT8 PTQ + bias correction | Good accuracy |
| Mobile / edge | INT8 or INT4 + ARM dotprod | Hardware support, battery |

### Senior at FAANG: Numerical Validation

When you ship a quantized model, you must run a quality regression suite. The bare minimum:

1. **Perplexity on a held-out corpus.** Compare quantized vs FP16. Acceptable: <0.1 absolute degradation for INT8, <0.3 for INT4.
2. **Task accuracy on benchmark suites.** MMLU, HellaSwag, HumanEval, GSM8K (for LLMs). ImageNet top-1 (for vision).
3. **Production traffic shadow.** Run quantized model on 1% of traffic, log outputs, compare to baseline. Catch the regressions that benchmarks do not.
4. **Per-layer numerical diff.** For each layer, output cosine similarity vs FP16. A single bad layer can poison the model. Bisect.

Skipping any of these has burned every team that has shipped a quantized model. Do not be the next.

The next section drops into the CUDA kernels themselves.

---
