## Exercises

These exercises are designed to build practical GPU programming skill. The first two can be completed with any CUDA-capable NVIDIA GPU (even a free Colab T4). Exercises 3-5 require either hardware access or the use of CUDA's profiling and analysis tools in emulation mode.

---

### Exercise 1: Parallel Prefix Sum (Scan) with Shared Memory

Implement an inclusive parallel prefix sum (scan) for an array of floats using shared memory. The inclusive prefix sum of `[1, 2, 3, 4]` is `[1, 3, 6, 10]`.

**Requirements:**
- Use the Blelloch work-efficient scan algorithm (up-sweep then down-sweep)
- Handle arrays larger than a single block using a multi-pass approach: scan each block, collect block sums into a separate array, scan the block sums, then add each block sum to the next block's result
- Verify correctness against a CPU reference implementation
- Measure and report throughput in GB/s

**Hints:**
- The up-sweep builds a reduction tree in shared memory in O(n log n) work but O(log n) steps
- The down-sweep distributes partial sums back down the tree
- Bank conflicts are a significant risk, use the `+1` padding technique from Section 2

**Expected performance**: For N = 32M floats on an A100, target > 800 GB/s (approaching peak bandwidth, since scan is memory-bound).

---

### Exercise 2: Tiled Matrix Multiplication with Double Buffering

Extend the tiled GEMM from Section 2 with **double buffering** (also called software pipelining): while the GPU is computing on tile `t`, load tile `t+1` into the other half of a double-buffered shared memory region.

**Requirements:**
- Implement two shared memory buffers: `tileA[2][TILE][TILE]` and `tileB[2][TILE][TILE]`
- Overlap the load of the next tile with the compute of the current tile using `__syncthreads()` carefully
- Use `TILE = 32` and block size `32×32`
- Compare performance (TFLOPS) against the non-pipelined version from Section 2
- Test correctness for M=N=K=1024 against cuBLAS output

**Expected improvement**: 10-25% throughput increase over the non-pipelined version on Ampere, because global memory latency is hidden behind compute.

**Bonus**: Add `#pragma unroll 4` to the inner loop and measure the effect on register usage (`--ptxas-options=-v`) and throughput.

---

### Exercise 3: Profile a Bank-Conflicted Kernel and Fix It

Write a kernel that deliberately introduces shared memory bank conflicts, profile it with Nsight Compute, and then fix the conflicts.

**Part A, Write the conflicted kernel:**
```cuda
__global__ void matrix_transpose_bad(const float* input, float* output,
                                      int n) {
    __shared__ float tile[32][32];
    // Load: coalesced (threads read consecutive columns)
    int x = blockIdx.x * 32 + threadIdx.x;
    int y = blockIdx.y * 32 + threadIdx.y;
    if (x < n && y < n) tile[threadIdx.y][threadIdx.x] = input[y * n + x];
    __syncthreads();
    // Write: uncoalesced AND bank-conflicted
    // Thread (tx, ty) writes tile[tx][ty], this is a 32-way bank conflict!
    int tx = blockIdx.y * 32 + threadIdx.x;
    int ty = blockIdx.x * 32 + threadIdx.y;
    if (tx < n && ty < n) output[ty * n + tx] = tile[threadIdx.x][threadIdx.y];
}
```

**Part B, Profile it**: Using `ncu` (Nsight Compute CLI):
```
ncu --metrics l1tex__data_bank_conflicts_pipe_lsu_mem_shared_op_st.sum \
    ./your_executable
```

Record the bank conflict count per warp.

**Part C, Fix it**: Add a single column of padding to eliminate the conflicts:
```cuda
__shared__ float tile[32][33];  // 33 instead of 32
```

Re-profile and confirm bank conflicts drop to near zero. Report the throughput improvement.

---

### Exercise 4: INT8 Quantization for a Dense Layer

Implement manual per-tensor INT8 quantization of a dense (fully connected) layer forward pass in CUDA.

**Requirements:**

1. Write a CUDA kernel `quantize_fp32_to_int8` that takes FP32 input and a scale factor and outputs INT8:
   ```
   q = clamp(round(x / scale), -127, 127)
   ```

2. Write a CUDA kernel `dequantize_int8_to_fp32` that converts INT8 back to FP32:
   ```
   x = q * scale
   ```

3. Implement the calibration step: find the maximum absolute value of activations over a calibration dataset (use 100 random input vectors) and compute `scale = max_abs / 127.0f`.

4. Use `cublasSgemm` with INT8 inputs via `cublasGemmEx` with `CUDA_R_8I` compute type for the actual matrix multiply.

5. Measure the accuracy loss compared to FP32: compute mean absolute error (MAE) between INT8 and FP32 outputs on 1000 random inputs.

**Expected result**: For a random weight matrix, MAE should be < 0.5% of the activation range. For adversarial inputs (very sparse activations with one large outlier), MAE can be significantly higher, this motivates outlier-aware quantization schemes like SmoothQuant.

---

### Exercise 5: Vulkan Compute Shader for Element-wise Operations

Implement a Vulkan compute pipeline that performs a fused element-wise operation: `output[i] = gelu(a[i] * b[i] + c[i])`, where GELU (Gaussian Error Linear Unit) is defined as:

```
gelu(x) = 0.5 * x * (1 + tanh(sqrt(2/π) * (x + 0.044715 * x³)))
```

**Requirements:**

1. Write the GLSL compute shader with `local_size_x = 256`
2. Set up the complete Vulkan pipeline: instance, device, command pool, descriptor set layout, pipeline layout, compute pipeline
3. Use `VulkanMemoryAllocator` (VMA) for buffer allocation
4. Implement timing via `VK_KHR_timeline_semaphore` or CPU-side timing with `vkQueueWaitIdle`
5. Verify output against a CPU reference implementation
6. Test on N = 8M elements and report effective bandwidth in GB/s (4 buffers × 4 bytes × N = 128MB total data movement)

**Bonus**: Compare the throughput of this fused Vulkan kernel against three separate cuDNN/CUDA calls (multiply + add + GELU) and observe the bandwidth savings from fusion.

---
