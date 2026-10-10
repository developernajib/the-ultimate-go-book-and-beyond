# Chapter 154: ML Inference Engines in C++

> "The model is Python. The serving system is C++.", every infra engineer at every frontier lab

A research engineer trains a model in PyTorch with a Jupyter notebook, a few `torch.compile` calls, and a wandb dashboard. That model never reaches production in that form. Between the checkpoint on disk and the user receiving a token, a C++ inference engine does the actual work: loading weights into GPU memory, dispatching CUDA kernels, managing the KV cache, batching requests, scheduling prefill and decode phases, and serializing tokens onto the wire.

This chapter is about that engine. It is the layer that keeps GPT-class models, Bard, Llama, Mistral, Claude, and every other production LLM running at sub-100ms first-token latency under hundreds of thousands of concurrent requests.

## Why C++ Owns the Inference Hot Path

Python is fine for the training loop because the GIL is released inside `torch.matmul`, the framework code is C++, and the iteration count is small (a million steps, each one minutes long). Inference inverts every one of those properties. A serving cluster does ten thousand decode iterations per second per GPU, each iteration is microseconds long, and the host code runs once per request rather than once per training run. The cost of every Python frame, every reference count update, every GIL acquisition, dominates.

The reasons C++ wins on the inference path:

1. **Latency floor**. A token is generated every 10 to 30 ms on a fast model. Python interpreter overhead alone (function call, dict lookup, GIL acquire) eats 1 to 5 ms. That is 10 to 50% of your TPOT (time per output token) burned before any real work happens.

2. **Memory footprint**. A 70B parameter model in FP16 takes 140 GB of VRAM. The KV cache for a single 8K-context request adds another 2 to 4 GB. Python objects wrapping every tensor add hundreds of MB of overhead per process. C++ runs the same workload with single-digit MB of host overhead.

3. **GPU control**. CUDA stream management, graph capture, peer-to-peer transfers, pinned memory allocation, and NCCL collective scheduling all have C/C++ APIs. Python wrappers exist but each call crosses the FFI boundary. On the hot path that is unacceptable.

4. **No GIL**. C++ threads run truly concurrent. You can have one thread doing CUDA dispatch, one thread doing tokenizer work, one thread doing network I/O, and one thread doing telemetry, all on the same process without contention. Python emulates this with multiprocessing, paying the cost of inter-process queues.

5. **Predictable destruction**. RAII destroys CUDA streams, NCCL communicators, and tensor memory at deterministic points. Python's GC can stall a 100ms decode loop with a generational sweep at the wrong moment.

## The Python + C++ Split in Practice

Every major inference stack uses the same architecture: a thin Python or REST control plane wraps a heavy C++ runtime.

| Stack | Python surface | C++ runtime |
|-------|---------------|-------------|
| PyTorch | `torch.nn.Module`, `torch.compile` | ATen, c10, cuDNN bindings, NCCL, Inductor codegen |
| TensorFlow | `tf.keras` | XLA runtime, TF Lite kernels, libtensorflow_cc |
| ONNX Runtime | `onnxruntime` Python binding | Session, execution providers, kernel library |
| TensorRT | `tensorrt` Python | Builder, engine, plugin runtime, all C++ |
| TensorRT-LLM | Python builder | C++ inflight batching runtime |
| vLLM | Python scheduler / API | PagedAttention CUDA kernels, C++ block manager (since 2025) |
| TGI (HuggingFace) | Python router | Rust + C++ kernel bindings |
| llama.cpp | None (pure C++) | ggml, GGUF loader, custom kernels |
| MLC LLM | Python compile-time | TVM-generated C++ runtime |

The pattern is consistent. Python does the things that change often (request schema, business logic, API surface). C++ does the things that must be fast (tensor math, scheduling, memory).

## What An Inference Engine Actually Does

A simplified call path for a single token generation in a vLLM-style engine looks like this:

```
HTTP request
    -> Tokenizer (C++ via SentencePiece or Tokenizers crate)
    -> Scheduler (decides which requests run in this iteration)
    -> Block manager (assigns KV cache pages)
    -> Model executor
        -> Embedding lookup (CUDA kernel)
        -> For each layer:
            -> Attention (PagedAttention CUDA kernel)
            -> RMSNorm (fused CUDA kernel)
            -> MLP / GeGLU (cuBLASLt GEMM + activation kernel)
            -> Residual add (fused with next op)
        -> LM head (cuBLASLt GEMM)
        -> Sampler (top-k / top-p / temperature, CUDA kernel)
    -> Detokenizer (incremental, C++)
    -> Stream chunk to network
```

Every step in that pipeline is C++ or CUDA C++. The fast path never enters the Python interpreter once the request is dispatched.

## What This Chapter Covers

The chapter walks the full stack from the foundation to the cutting edge. It begins with tensor abstractions and the C++23 `std::mdspan` class that finally gives the language a first-class multidimensional array view. It covers the two production runtime giants (ONNX Runtime and TensorRT) in depth, then the LibTorch C++ frontend for teams who want to ship a PyTorch model without leaving the framework.

The middle of the chapter is GPU-centric. Quantization (INT8, INT4, FP8, MXFP4), CUDA kernel patterns, the FlashAttention v3 algorithm and its predecessors, PagedAttention, continuous batching, speculative decoding with Medusa heads, prefill / decode disaggregation as pioneered by DistServe and Mooncake, and KV cache management across cluster pools.

The later chapters cover the system layer: distributed inference (tensor / pipeline / expert parallel), CUDA Graphs for launch overhead elimination, multi-GPU host orchestration, CPU inference with oneDNN and AVX-512 / AMX tile matmul, mobile and edge inference, and the production serving frameworks (Triton, TensorRT-LLM, vLLM) that wrap all of this into a deployable artifact.

The chapter closes with observability (the right SLOs and hardware counters to watch), cost engineering (the math that turns \$/GPU-hour into \$/1k-tokens), and a forward-looking section on speculative decoding variants, MoE inference, and test-time compute (the o1 / o3 / R1 reasoning paradigm).

## Junior to FAANG / Senior at FAANG

A junior engineer joining a Bard or Llama serving team will be given small, contained kernels to optimize: a sampler, a fused norm, a tokenizer fast path. Their first three months are about understanding the codebase. The senior engineer on the same team owns the scheduler, the KV cache layout, or the multi-GPU communication pattern. The staff engineer owns the engine architecture itself: when to disaggregate prefill and decode, when to enable speculative decoding, what the cost / latency / throughput Pareto frontier looks like for a given model size. This chapter targets the senior level. By the end, you should be able to read the vLLM or TensorRT-LLM source code without confusion, identify the bottleneck in a production trace, and propose an architectural change that moves the cost curve.

## The Hardware You Will Be Targeting in 2026

The relevant fleet has consolidated. NVIDIA H100 (80 GB HBM3, 700W) is the workhorse. H200 (141 GB HBM3e) is the memory-expanded variant for larger models or higher KV cache budgets. B200 (Blackwell, 192 GB HBM3e, FP4 native, NVL72 rack-scale fabric) is shipping in volume now and is the target for new code in 2026. AMD MI300X (192 GB HBM3, ROCm 6+) is the production AMD path with growing software support. Intel Gaudi 3 and Apple silicon (M3 / M4 with unified memory) hold smaller niches. Google TPU v5e and v5p are the in-house Google path with a separate XLA toolchain.

The code in this chapter targets NVIDIA H100 / H200 / B200 first, with notes on AMD ROCm equivalents. AMD's HIPify path means most CUDA C++ patterns translate directly.

## What You Need Before Starting

Comfort with C++17 (a few examples use C++20 / C++23 features and they are flagged). Familiarity with basic linear algebra (matrix multiplication, softmax, layer norm). A working knowledge of transformer architecture (attention, MLP, residual stream). CUDA experience helps but is not required. The CUDA chapter (chapter 148) is a prerequisite for the kernel sections, if you have not read it, skim it first.

The next section lists the explicit learning objectives.

---
