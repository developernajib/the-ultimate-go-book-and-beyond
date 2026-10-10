## Interview Questions

These questions appear in GPU engineer and ML systems engineer interviews at companies where GPU performance matters: NVIDIA, Meta AI, Google DeepMind, OpenAI, Anthropic, AMD, Qualcomm, and hardware-adjacent ML teams.

---

**Q1: What is warp divergence and how do you avoid it?**

A warp is 32 threads that execute in lockstep, all 32 run the same instruction on each clock cycle. **Warp divergence** occurs when threads in the same warp take different paths through an `if`/`else` branch. The GPU handles this by executing both paths: threads taking one branch are masked off (disabled) while the other branch runs, then vice versa. A fully divergent warp (half threads take each branch) effectively halves throughput.

**How to avoid it:**

1. **Predicated execution**: For short branches, compilers often convert `if (cond) x = a. else x = b;` into a conditional move instruction without branching. This is automatic but works only for simple cases.

2. **Warp-uniform conditions**: Conditions that are always the same within a warp, based on `blockIdx` rather than `threadIdx`, or on data known to be uniform per warp, cause no divergence. `if (blockIdx.x == 0)` diverges at most across blocks, never within a warp.

3. **Sort by divergence-causing value**: If you're processing a mixed workload (e.g., some elements require expensive computation, some don't), sort the input so similar elements are grouped into the same warps. `thrust::sort_by_key` on the divergence predicate before kernel launch.

4. **Restructure the algorithm**: Use lookup tables or separate kernels for fundamentally different work items. It is often better to launch two kernels (one for each branch) than to have one divergent kernel.

The performance cost of divergence is measurable in Nsight Compute via the "Thread Divergence" metric and "Warp State: Divergence/Predication Off" stall reason.

---

**Q2: Explain shared memory bank conflicts, what causes them and how do you eliminate them?**

Shared memory is organized into **32 banks** of 4 bytes each (on current NVIDIA GPUs). Bank `k` contains bytes at addresses `[4k, 4k+3]`, then wraps around at 128 bytes. When two threads in the same warp access different addresses in the same bank, the accesses **serialize**, a bank conflict. An N-way conflict means N sequential accesses instead of 1 parallel access.

**Causes**: Strided access patterns. If thread `i` accesses `smem[i * stride]`, threads 0, 1, 2, ... hit banks 0, `stride % 32`, `2*stride % 32`, .... When `stride` is a power of 2 and ≥ 2, multiple threads share banks.

**Classic example**: Transposing a 32×32 shared memory tile. Reading column `j` of `smem[j][threadIdx.x]` means all threads access `bank j % 32`, a 32-way conflict.

**Solutions:**

1. **Padding**: Add 1 extra element per row, `__shared__ float smem[32][33]`. Row `r` now starts at offset `33r`, so column accesses rotate bank assignments. All 32 threads hit distinct banks.

2. **Access pattern redesign**: Instead of reading by column, transpose the access pattern so threads read rows (consecutive banks).

3. **Vectorized loads**: Load `float4` instead of `float`, each warp reads 128 contiguous bytes in one transaction, and float4 accesses naturally align to reduce conflicts.

**Detection**: Nsight Compute shows `l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_ld.sum` and `..._op_st.sum` metrics. Any nonzero value means bank conflicts. Divide by warp count to get conflicts per warp access.

---

**Q3: What are the rules for memory coalescing in CUDA?**

For a warp of 32 threads to generate a single 128-byte global memory transaction (fully coalesced access):

1. All 32 threads must access the same 128-byte aligned cache line
2. Thread `i` accesses address `base + i * sizeof(T)` (stride-1 access)
3. The base address should be 128-byte aligned for maximum efficiency (though L1 cache handles misalignment with only modest penalty on Ampere+)

**What breaks coalescing:**
- **Strided access**: Thread `i` accesses element `i * 2` → 32 cache lines needed instead of 1
- **Random access**: Hash table lookups, sparse matrix rows, gather/scatter operations
- **AoS with field-level access**: Reading only the `.x` field of `struct{float x,y,z,w;}` has stride 4 → 4× overhead

**What doesn't help**: Making threads access elements in a non-sequential order within the same 128-byte region does not hurt coalescing, the hardware checks whether all accesses fall within the same cache line, not whether they are strictly sequential.

**Diagnosis tool**: Nsight Compute `gpc__cycles_elapsed.avg` plus `l1tex__average_t_sectors_per_request_pipe_lsu_mem_global_op_ld.ratio`, this ratio should be close to 1.0 for well-coalesced access. A ratio of 32 means every access fetches 32× more data than needed.

---

**Q4: Explain the roofline model. How do you determine whether a kernel is memory-bound or compute-bound?**

The roofline model places kernels on a performance space defined by two axes:

- **Y-axis**: Achieved performance (FLOPS/s or TOPS/s)
- **X-axis**: Arithmetic intensity (FLOPS per byte of DRAM traffic)

Two hardware limits form a "roof":
- **Memory bandwidth roof**: performance = bandwidth × arithmetic_intensity (diagonal line)
- **Compute roof**: performance = peak_FLOPS (horizontal line)

The **ridge point** is where the two roofs intersect: `arithmetic_intensity = peak_FLOPS / bandwidth`.

For an A100: peak FP32 = 19.5 TFLOPS, bandwidth = 2 TB/s → ridge = 9.75 FLOP/byte.

**Memory-bound kernel** (AI < ridge): Increasing compute won't help. Solutions: improve coalescing, reduce redundant loads, use shared memory to increase data reuse, reduce precision to move more elements per byte.

**Compute-bound kernel** (AI > ridge): Increasing memory bandwidth won't help. Solutions: use tensor cores, reduce register pressure to increase occupancy, exploit FP16/BF16/INT8 precision.

**Measuring AI**: `ncu --metrics smsp__sass_thread_inst_executed_op_fadd_pred_on.sum,smsp__sass_thread_inst_executed_op_fmul_pred_on.sum,dram__bytes.sum ./kernel` gives FLOPs and bytes. Divide to get AI.

---

**Q5: What data format do tensor cores require, and what is TF32?**

NVIDIA tensor cores perform a `D = A×B + C` operation on small matrix tiles in one clock cycle. The required formats vary by generation:

| Generation | GPUs | Input | Accumulator | Tile size |
|---|---|---|---|---|
| Volta | V100 | FP16 | FP16/FP32 | 16×16×16 |
| Turing | T4, RTX 2000 | FP16, INT8, INT4 | FP32 | 16×16×16 |
| Ampere | A100, RTX 3000 | FP16, BF16, TF32, INT8 | FP32 | 16×16×16 |
| Hopper | H100 | FP8, FP16, BF16 | FP32 | 16×16×16 |

**TF32 (TensorFloat-32)** is Ampere's default tensor core format: 10 mantissa bits (like FP16) but the full 8-bit exponent of FP32. It offers 10× the FP32 scalar throughput with negligible accuracy loss for most ML workloads, and importantly, it is transparent, cuBLAS uses TF32 automatically for FP32 inputs when `CUBLAS_TENSOR_OP_MATH` is set.

**Requirements for tensor core use:**
1. Matrix dimensions must be multiples of 8 (FP16/BF16) or 16 (INT8/FP8)
2. Pointers must be 128-bit aligned
3. Use cuBLAS `cublasGemmEx` with `CUBLAS_COMPUTE_32F_FAST_16F` or `CUBLAS_TENSOR_OP_MATH`

Custom tensor core code uses the `nvcuda::wmma` API (from `<mma.h>`).

---

**Q6: What is TensorRT INT8 calibration and why is it necessary?**

INT8 uses 8 bits to represent values, mapping the float range [-max, max] to integers [-127, 127] via `q = round(x / scale)`. The scale factor determines the mapping. If the scale is too small, large values saturate (clip). If too large, small values lose precision (underflow to zero).

Different layers have wildly different activation ranges, a BatchNorm output typically spans [-3, 3] while an embedding lookup might span [-50, 50]. Using one global scale factor wastes precision in layers with narrow range and clips layers with wide range.

**Calibration** determines the per-tensor (or per-channel) scale factors by:

1. Running a representative calibration dataset (500-1000 samples) through the FP32 network
2. Collecting activation histograms at each tensor
3. Applying a calibration algorithm to find the optimal threshold that minimizes information loss when quantizing to INT8:
   - `IInt8MinMaxCalibrator`: uses min/max of observed values, simple but suboptimal for outliers
   - `IInt8EntropyCalibrator2`: minimizes KL divergence between FP32 and INT8 distributions, recommended for most models
   - `IInt8PercentileCalibrator`: clips at a percentile (e.g., 99.99%) to handle outlier activations

The calibration cache stores the computed scale factors so you don't re-calibrate on every engine build.

**Why it matters**: Uncalibrated INT8 (guessed scales) can lose >10% accuracy. Properly calibrated INT8 typically loses <0.5% top-1 accuracy on ImageNet while delivering 3-4× speedup over FP32 on tensor cores.

---

**Q7: How do CUDA streams enable compute-transfer overlap, and what hardware constraint limits it?**

A CUDA stream is a sequential queue of operations (memcpy, kernel launch, events). Operations in different streams can run concurrently if the hardware supports it.

Modern NVIDIA GPUs have two **copy engines** (one for H2D, one for D2H) that are independent of the **compute engine**. With multiple streams:
- Stream A can run an H2D `cudaMemcpyAsync` while
- Stream B runs a kernel, while
- Stream C runs a D2H `cudaMemcpyAsync`

All three proceed simultaneously on separate hardware units.

**The critical requirement**: All transfers must use **pinned (page-locked) host memory** allocated with `cudaMallocHost`. Pageable memory requires the CUDA driver to stage through an internal pinned buffer, which serializes the transfer and prevents overlap.

**Typical pipeline** (double-buffered):
```
Time:      ──┬────────────┬────────────┬────────────
H2D A:     ══════│
Compute A:        ══════════│
D2H A:                      ══════│
H2D B:         ══════│
Compute B:              ══════════│
D2H B:                       ══════│
```

With 4 streams and sufficient work, you can hide nearly all PCIe transfer overhead behind compute.

**Hardware limit**: Each device has a fixed number of hardware copy queues (typically 2 on PCIe systems, one H2D, one D2H). More than 2 concurrent memcpy streams don't increase transfer bandwidth. They share the same physical queue.

---

**Q8: Compare SYCL and CUDA. When would you choose one over the other?**

| Dimension | CUDA | SYCL |
|---|---|---|
| Hardware target | NVIDIA only | AMD, Intel, NVIDIA, CPU, FPGA |
| Compiler | nvcc (NVIDIA) | dpcpp (Intel), acpp (AMD), nvcpp (NVIDIA) |
| Language | C++ with CUDA extensions, separate compilation | Standard C++17/20, single source |
| Ecosystem | cuDNN, TensorRT, NCCL, Nsight | MKL-DNN (Intel), rocBLAS (AMD) |
| Performance (NVIDIA) | Optimal | 5-15% overhead vs CUDA on NVIDIA |
| Performance (Intel GPU) | Not supported | Optimal via DPC++ |
| Debugging | Nsight, cuda-gdb | Intel VTune, AMD ROCm debugger |
| Industry adoption | Dominant in ML | Growing, Intel hardware ecosystem |

**Choose CUDA when**: You target NVIDIA hardware, performance is critical, you need cuDNN/TensorRT, or you're working in an ML research/production context where the entire ecosystem assumes CUDA.

**Choose SYCL when**: You need to support Intel Gaudi accelerators or Intel GPU clusters (common in supercomputing), you want code that runs on AMD and NVIDIA without maintaining two codebases, you're doing HPC work where portability to upcoming hardware matters, or you're doing FPGA acceleration (Intel's DPC++ targets FPGAs).

**In practice**: Most production ML systems are CUDA. SYCL is a credible choice for systems software that needs to outlive a single GPU vendor's dominance, or for workloads targeting Intel's data center GPUs (Arc, Gaudi, future Falcon Shores).

---

**Q9: What is FlashAttention and why is it important for large language models?**

Standard transformer self-attention computes:
```
Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) * V
```

The `QK^T` matrix has shape `[batch, heads, seq_len, seq_len]`. For `seq_len = 32768` (32K context), `batch = 1`, `heads = 32`, FP16: `1 × 32 × 32768 × 32768 × 2 bytes = 64 GB`. This doesn't fit in GPU HBM. Even at `seq_len = 4096`, it's 1GB per forward pass, significant overhead for just one layer in a 96-layer model.

**FlashAttention** (Dao et al., 2022) avoids materializing the full `QK^T` matrix by tiling Q, K, V and computing the softmax incrementally:

1. Load a tile of Q, K, V into shared memory (on-chip, 19 TB/s)
2. Compute the partial `QK^T` tile and the running softmax numerator/denominator
3. Accumulate the partial `softmax(QK^T) * V` contribution
4. Loop over all K, V tiles
5. Apply the final normalization

**Result**: The large intermediate matrices never leave the SM's L1/shared memory. Memory footprint of attention drops from `O(n²)` to `O(n)` in sequence length. Speed improves 2-4× because the bottleneck shifts from HBM bandwidth to tensor core compute.

FlashAttention v2 further improved GPU use to ~70% of peak FP16 throughput. FlashAttention v3 (for H100) targets ~75% of peak FP8 throughput. It is now the standard attention implementation in all major frameworks and is the reason 128K+ context windows are computationally feasible.

---
