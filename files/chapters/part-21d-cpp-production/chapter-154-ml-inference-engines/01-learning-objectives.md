## Learning Objectives

By the end of this chapter you will be able to:

1. **Design a tensor abstraction in modern C++** that handles strides, broadcasting, contiguity checks, and memory ownership using `std::mdspan` and concepts, matching the semantic model used in ATen and TensorFlow's `Tensor` class.

2. **Build and ship an inference service against ONNX Runtime's C++ API**, choosing the right execution provider (CPU, CUDA, TensorRT, DirectML) for the deployment target, configuring IO bindings to skip host-device copies, and registering custom operators when a model has an op that is not in the default opset.

3. **Convert a PyTorch model to a TensorRT engine and serve it from C++**, including FP16 / INT8 quantization with calibration, optimization profiles for dynamic shapes, plugin layer authoring, and fusing pre/post-processing into the engine.

4. **Load a TorchScript or AOTI-compiled model with LibTorch** and integrate it into a production C++ server, understanding when LibTorch is the right choice vs ONNX Runtime or TensorRT.

5. **Reason about quantization tradeoffs** across PTQ, QAT, weight-only (W4A16 / GPTQ / AWQ), KV cache quantization, FP8 (E4M3 / E5M2), and MX formats (MXFP4 / MXFP6), and pick the right format for a given accuracy / latency / memory budget.

6. **Write and tune CUDA C++ kernels for inference**, including GEMM via cuBLASLt, conv via cuDNN, fused MLP and RMSNorm, fused RoPE, and runtime-compiled kernels via NVRTC.

7. **Implement and explain the FlashAttention v1 / v2 / v3 algorithm**, the differences between standard, multi-query (MQA), and grouped-query (GQA) attention, and PagedAttention as used in vLLM. Write a paged attention kernel skeleton in CUDA C++.

8. **Architect an LLM inference engine** with continuous batching, a PagedAttention block manager, a prefill / decode scheduler, KV cache management, token streaming, and speculative decoding via draft model or Medusa heads.

9. **Distribute inference across GPUs** using tensor parallel (Megatron-style row / column splits), pipeline parallel (1F1B schedule), and expert parallel (MoE). Pick the right NCCL collective for each communication pattern and reason about the bandwidth budget across NVLink, PCIe, and InfiniBand.

10. **Disaggregate prefill and decode** into separate GPU pools (DistServe, Mooncake patterns), implement KV cache transfer between pools, and measure the latency / cost benefit.

11. **Use CUDA Graphs to eliminate kernel launch overhead** for the decode loop, including stream capture, conditional graph nodes, and the cases where graphs hurt rather than help.

12. **Operate an inference cluster in production**: define the right SLOs (TTFT, TPOT, throughput at p99), instrument GPU use and SM occupancy via DCGM and NSight Systems, and run the cost-engineering math that converts GPU-hour pricing into \$/1k-tokens.

These objectives map roughly to the chapter sections in order. Treat them as the checklist for self-evaluation before an interview or before owning an inference service.

---
