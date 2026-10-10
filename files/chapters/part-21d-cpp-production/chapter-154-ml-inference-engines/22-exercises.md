## Exercises

Six hands-on exercises. They build on each other, finishing all six gives you a small but functional inference toolkit. Estimated total time: 40 to 80 hours, depending on starting fluency.

### Exercise 1: Build a Tensor Class with `std::mdspan`

Build the `mlc::Tensor<Rank>` class from section 2 in a real codebase. Requirements:

1. Constructor that allocates contiguous storage of the right size.
2. View constructor that shares storage with another tensor (different shape / strides).
3. `is_contiguous()` and `contiguous()`.
4. `reshape()` that returns a view if the new shape is compatible with current strides, otherwise calls `contiguous()` first and then a no-copy reshape.
5. `transpose(d1, d2)` that swaps strides and shapes (no copy).
6. `slice(dim, start, end, step)` that returns a strided view.
7. `expand(new_shape)` for broadcasting.

Test cases:

- A `[4, 3, 224, 224]` tensor of float, slice to `[4, 3, 32, 32]`, verify it shares memory.
- Transpose a `[2, 3, 4]` tensor to `[2, 4, 3]`, verify `is_contiguous() == false`.
- `expand([1, 5, 1, 5], [3, 5, 4, 5])`, verify the strides on the broadcasted dims are zero.
- A reshape that requires a contiguous copy.

Bonus: implement a CPU `add` op that handles broadcasting and strided inputs.

### Exercise 2: ONNX Runtime + IO Bindings

Take a public ONNX model (ResNet-50 or BERT-base from the ONNX Model Zoo). Build a C++ program that:

1. Loads the model with the CUDA execution provider.
2. Allocates input and output buffers on GPU using `Ort::Value` with `cuda` memory info.
3. Runs 1000 iterations using `IoBinding`, measuring TTFT (first iteration) and steady-state latency.
4. Compares against running 1000 iterations *without* IO bindings (CPU input/output).
5. Reports the speedup.

Bonus: write a custom op (e.g., a fused `LeakyReLU + Sigmoid`) that ONNX does not natively have, register it via `Ort::CustomOpDomain`, and verify it produces the same numerical output as the unfused version.

### Exercise 3: Build a Block Manager with Prefix Caching

Implement the `BlockManager` from section 9 plus the `PrefixCache` from section 13. Requirements:

1. Allocate / release blocks per request, track refcounts.
2. Hash incoming prompts in 16-token chunks, look up in the prefix cache, reuse blocks on hit.
3. LRU eviction when free pool is empty but evictable cached blocks exist.
4. On block-full event (a block becomes immutable), insert into prefix cache.

Test:

- Allocate 1000 sequences of 100 tokens each. Verify total blocks used.
- Run 100 sequences with the same 50-token prefix, then 50 different suffixes. Verify the prefix is cached and ref-counted, and the cache hit ratio is 50%.
- Stress test: alternate allocations / releases for 1M operations. Verify no leaks (`refcount.sum() == sum(req.block_table.size())`).

Bonus: add metrics (cache hits, evictions, allocation latency) and expose via a Prometheus-like text format.

### Exercise 4: Implement Continuous Batching Around an ONNX Model

Take any small autoregressive model in ONNX (TinyLlama, GPT-2 small). Build a C++ engine that:

1. Accepts streaming requests via a simple in-process queue.
2. Runs continuous batching: each iteration combines decode tokens for active requests plus prefill chunks for new ones.
3. Tracks per-request output, calls a callback when a token is ready, calls another when finished.
4. Implements a basic sampler (greedy + temperature top-k).

Constraints: max_batched_tokens = 1024, max running requests = 32, chunked prefill chunk size = 256.

Test:

- 100 concurrent requests, prompts 100 to 2000 tokens, max output 100 tokens. Measure throughput.
- Compare against running each request sequentially. Verify the throughput improvement.
- Plot p50 / p99 TTFT and TPOT.

Bonus: add prefix caching using exercise 3's BlockManager.

### Exercise 5: TensorRT Engine Build Pipeline

Take a vision model (YOLOv8 ONNX, or any segmentation model). Build a C++ pipeline that:

1. Parses the ONNX with `nvonnxparser`.
2. Builds a TRT engine with FP16 enabled, optimization profile for batch in [1, 8].
3. Builds a separate engine with INT8 + entropy calibration on a 100-image set.
4. Saves both engines to disk.
5. At inference time, loads the engine, runs 1000 batches of size 4, reports latency and throughput.

Verify accuracy: pick 50 images, run them through both engines and through the original PyTorch model, compute IoU on the segmentation outputs. INT8 should be within 1% of FP16 IoU.

Bonus: write a TRT plugin for one custom op (e.g., a non-standard NMS or post-processing) and integrate it into the engine.

### Exercise 6: CUDA Kernel for Fused RMSNorm

Write a CUDA C++ kernel that fuses RMSNorm with the residual add and the next layer's input multiplication by a weight broadcast.

```
y = (x + residual) / sqrt(mean((x + residual)^2)) * gamma
```

Requirements:

1. Single kernel launch.
2. Use shared memory for the row reduction.
3. Vectorized loads (`half2` or `__nv_bfloat162`).
4. Support `[B, S, H]` input with arbitrary batch / sequence sizes.
5. Numerical equivalence with the unfused PyTorch reference (within 1e-3 relative).

Benchmark:

- 1000 forward calls on `[8, 4096, 8192]` FP16 inputs.
- Compare against: separate add kernel + RMSNorm kernel + multiply.
- Report the speedup. Expect 2-3x.

Bonus: add an FP8 (E4M3) quantization step at the end (output to FP8 with per-row scale), useful for FP8 next-layer GEMM.

### Submission and Self-Check

For each exercise:

- A working implementation in a single repo under `inference-exercises/exN/`.
- A README with build instructions and benchmark numbers.
- Unit tests for correctness.
- A short writeup (one paragraph) on what you learned.

These exercises are how a junior engineer ramps to L4 / L5 on an inference team in three to six months. Going through them yourself, then re-reading the chapter, then doing them again with the new understanding, is the path. The next section closes the chapter.

---
