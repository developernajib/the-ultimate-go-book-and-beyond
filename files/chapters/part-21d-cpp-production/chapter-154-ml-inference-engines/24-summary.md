## Summary

The C++ inference engine is the layer that turns a research checkpoint into a product. Every frontier lab, every hyperscaler, every serious AI infra team owns or extends one. The chapter walked the full stack:

The foundation is a tensor library that handles strides, contiguity, broadcasting, and refcounted storage. C++23 `std::mdspan` plus a `shared_ptr<Storage>` is the modern realization. ATen, ORT's `Ort::Value`, and TensorRT's `ITensor` all fit this template.

The runtime layer has three production options. ONNX Runtime gives you a heterogeneous backend with execution providers (CPU, CUDA, TensorRT, Core ML, NNAPI). TensorRT compiles graphs to architecture-specific engines for the fastest NVIDIA path. LibTorch carries the full PyTorch C++ API and is the shortest path from research to production when conversion is too costly.

The kernel layer is GPU-centric. cuBLASLt and CUTLASS for GEMM. cuDNN for convolution. FlashAttention v2 / v3 for attention (or PagedAttention for the LLM variant). Custom kernels for fused RMSNorm, RoPE, sampling, and FP4 / FP8 dequant-on-the-fly. NVRTC for runtime-compiled specialization.

The LLM engine layer adds continuous batching, paged KV cache, prefix caching, chunked prefill, speculative decoding (draft model, EAGLE, Medusa), and MoE expert routing. The architecture is a scheduler + block manager + executor, with all-reduce-based tensor parallel within a node and pipeline or expert parallel across nodes for the largest models.

Disaggregating prefill and decode into separate GPU pools (DistServe, Mooncake) addresses the fact that the two phases have opposite bottlenecks (compute vs memory). KV cache transfer protocols over NVLink or RDMA make this practical at sub-millisecond cost.

CUDA Graphs eliminate kernel launch overhead in the decode loop, capturing one graph per common batch size. Multi-GPU host orchestration uses one thread per device with a per-device CUDA stream, NCCL for collectives, pinned host buffers, and topology-aware NCCL communicators.

CPU inference (oneDNN, AVX-512, AMX, ARM NEON, llama.cpp / ggml) covers small models and edge deployments. Mobile inference (TFLite, Core ML, NNAPI, ONNX Runtime mobile) targets phones and microcontrollers with platform-specific NPUs.

Serving frameworks (Triton, vLLM, TensorRT-LLM, TGI) wrap the engine for production. Custom C++ wrappers handle internal RPC adaptation, authentication, request routing, and observability. Distributed tracing, GPU telemetry via DCGM, NSight Systems profiling, and a goodput-based capacity metric give you the operational view.

Cost engineering converts GPU pricing to \$/M tokens. Quantization (FP8, MXFP4) and continuous batching are the two biggest cost levers. Speculative decoding, prefix caching, and disaggregation each give 1.2-3x improvements. The right operating point on the throughput / latency / cost surface is the cheapest one that meets the SLO.

The 2026 frontier: EAGLE-3 / Medusa speculative decoding, MoE inference at hundreds of experts (DeepEP), test-time compute (o1 / o3 reasoning), tree-search inference, agent serving, and the hardware refresh cycle (B300, MI355X, GH200, Vera Rubin).

A senior C++ inference engineer at a frontier lab in 2026 should be able to read the vLLM and TensorRT-LLM source, identify the bottleneck in a production trace, propose architectural changes that move the cost curve, write a CUDA kernel that beats cuBLASLt for an unusual shape, debug a multi-GPU NCCL deadlock, and run a load test that finds the goodput knee on a new model. This chapter is the map from junior to that bar. The exercises are the path.

The decisions you make in the engine compound. A 10% kernel improvement saves \$10M / year on a \$100M serving budget. A scheduling change that lifts goodput 20% pays for the team. The work is high-use. Be careful with it, do the validation, and ship.

---

| [◀ Chapter 153: Kernel-Bypass and Userspace Networking in C++](../chapter-153-kernel-bypass-networking/00-introduction.md) | [Chapter 154: ML Inference Engines in C++](00-introduction.md) | [Chapter 155: NUMA, Cache Coherence, and Hardware-Aware C++](../chapter-155-numa-cache-coherence/00-introduction.md) ▶ |

