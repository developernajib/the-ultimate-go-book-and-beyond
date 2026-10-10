## GPU Compute: CUDA, Vulkan, OpenCL, SYCL, HIP

GPU compute outside of graphics is its own ecosystem. The choice of API depends on your hardware target, performance ceiling, and tooling needs. This section gives the senior-engineer view of when to pick which.

### CUDA

CUDA is NVIDIA's proprietary GPU compute platform. It is C++ with extensions: kernels are functions marked `__global__`, called with `<<<grid, block>>>` launch syntax.

```cpp
#include <cuda_runtime.h>

__global__ void saxpy(int n, float a, const float* x, float* y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) y[i] = a * x[i] + y[i];
}

int main() {
    int n = 1 << 20;
    float *dx, *dy;
    cudaMalloc(&dx, n * sizeof(float));
    cudaMalloc(&dy, n * sizeof(float));
    // upload x, y...
    saxpy<<<(n + 255) / 256, 256>>>(n, 2.0f, dx, dy);
    cudaDeviceSynchronize();
}
```

Why CUDA dominates compute:

- The most mature ecosystem. cuBLAS, cuDNN, cuSPARSE, NCCL, Thrust, CUB. Decades of tuning.
- Best tooling. Nsight Compute, Nsight Systems, the CUDA debugger. Better than anything in the open ecosystem.
- Direct access to NVIDIA-specific hardware. Tensor cores via `wmma`. Hopper's TMA. Blackwell's FP4 transformer engine. PTX inline assembly.
- Cooperative groups (CUDA 9+) for cross-block synchronization.
- CUDA C++ supports modern C++20 in device code: lambdas, constexpr if, concepts (in CUDA 12).

The cost: NVIDIA only. CUDA does not run on AMD, Intel, or Apple. If you need cross-vendor, you do not pick CUDA.

### Vulkan Compute

Vulkan exposes compute via the same pipeline model as graphics. A `VkPipeline` with stage `VK_SHADER_STAGE_COMPUTE_BIT`, dispatched with `vkCmdDispatch`. Shaders are GLSL or HLSL compiled to SPIR-V.

```glsl
#version 460
layout(local_size_x = 256) in;

layout(set = 0, binding = 0) readonly buffer X { float x[]; };
layout(set = 0, binding = 1) buffer Y { float y[]; };
layout(push_constant) uniform Push { float a; uint n; };

void main() {
    uint i = gl_GlobalInvocationID.x;
    if (i < n) y[i] = a * x[i] + y[i];
}
```

Vulkan compute is the cross-vendor option. The same SPIR-V runs on NVIDIA, AMD, Intel, ARM Mali, Qualcomm Adreno, Apple via MoltenVK. It is the de facto choice for compute embedded inside a graphics pipeline (particle systems, light culling, post-process).

Tradeoffs vs CUDA:

- Cross-vendor. Same code, all GPUs.
- Tight integration with graphics. Same memory, same descriptors, same command buffers.
- Lower ceiling on raw compute throughput. Vulkan compute does not expose tensor cores natively (only via vendor extensions). No equivalent of CUDA streams' fine-grained scheduling.
- Worse tooling. Nsight Graphics shows compute, but Nsight Compute does not work on Vulkan.

For graphics-adjacent compute, Vulkan wins. For dedicated ML or HPC, CUDA wins.

### OpenCL

OpenCL is the legacy Khronos compute API, predating Vulkan. C99-derived shading language, runtime compilation, host API in C.

```c
__kernel void saxpy(int n, float a, __global const float* x, __global float* y) {
    int i = get_global_id(0);
    if (i < n) y[i] = a * x[i] + y[i];
}
```

OpenCL is in maintenance mode. Apple deprecated it. NVIDIA implements it but does not invest in it. AMD has shifted focus to ROCm/HIP. New code does not start in OpenCL. Existing OpenCL code is being ported to Vulkan compute, SYCL, or HIP.

### SYCL and oneAPI

SYCL is a Khronos standard for single-source C++ heterogeneous compute. Intel's oneAPI is the most prominent implementation, with backends for CPU, Intel GPU, NVIDIA (via PTX), and AMD (via HIP).

```cpp
#include <sycl/sycl.hpp>

void saxpy(sycl::queue q, int n, float a,
           sycl::buffer<float>& x, sycl::buffer<float>& y) {
    q.submit([&](sycl::handler& h) {
        sycl::accessor X(x, h, sycl::read_only);
        sycl::accessor Y(y, h, sycl::read_write);
        h.parallel_for(n, [=](sycl::id<1> i) {
            Y[i] = a * X[i] + Y[i];
        });
    });
}
```

SYCL is the closest thing to portable C++ on the GPU. Pros: real C++17/20, single source, works on multiple vendors. Cons: tooling is less mature than CUDA, performance can be 10 to 30 percent below hand-tuned CUDA, vendor support varies.

Adopters: Intel itself (Aurora supercomputer), Codeplay, some scientific computing groups. It is the right answer for a portable HPC code that needs C++ semantics, not graphics.

### ROCm and HIP

AMD's ROCm stack with HIP as the source-level CUDA-compatible API. HIP code is `__global__` kernels with `hipLaunchKernelGGL`, syntactically near-identical to CUDA, and `hipify` translates CUDA source.

```cpp
#include <hip/hip_runtime.h>

__global__ void saxpy(int n, float a, const float* x, float* y) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) y[i] = a * x[i] + y[i];
}

// Host
hipLaunchKernelGGL(saxpy, dim3((n+255)/256), dim3(256), 0, 0, n, 2.0f, dx, dy);
```

HIP runs on AMD via ROCm and on NVIDIA via a CUDA backend. The promise: write once, run on AMD or NVIDIA. The reality: ROCm has historically been Linux-only, has gaps in feature parity (some CUDA libraries lack HIP equivalents), and AMD's tooling lags. ROCm 6+ improved Windows support and library coverage. PyTorch ROCm builds and Frontier supercomputer use HIP at scale.

If you target AMD GPUs for HPC, HIP is the path. If you target NVIDIA only, CUDA is faster to develop.

### Metal Compute

On Apple, compute is integrated into Metal. Same `MTLDevice`, same command queue, same buffers. Compute pipelines use `MTLComputePipelineState` with kernels written in MSL.

```msl
kernel void saxpy(device const float* x [[buffer(0)]],
                  device float* y [[buffer(1)]],
                  constant float& a [[buffer(2)]],
                  uint i [[thread_position_in_grid]]) {
    y[i] = a * x[i] + y[i];
}
```

Metal compute integrates with the Apple ML stack: MPS (Metal Performance Shaders), Core ML conversions, MetalFX. It is the only choice on Apple Silicon for non-trivial compute.

### When to Choose What

| Scenario | Pick | Why |
|---|---|---|
| Deep learning training | CUDA | Ecosystem, cuDNN, NCCL, tooling |
| Inference on NVIDIA | CUDA or TensorRT | Performance |
| Inference on Apple | Metal + MPS | Hardware integration |
| Inference on AMD | HIP or Vulkan compute | ROCm path |
| Cross-vendor inference | Vulkan compute or SYCL | Portability |
| GPU compute inside a renderer | Vulkan/D3D12/Metal compute | Same API as graphics |
| HPC scientific code, AMD target | HIP or SYCL | Vendor stack |
| HPC scientific code, NVIDIA | CUDA | Best tooling, performance |
| New cross-platform game | Vulkan + Metal + D3D12 compute | Native to each platform |
| Mobile GPU compute | Vulkan compute | Universal mobile support |

### A Senior Engineer's Take

Today, in 2026, the realistic stack looks like this.

For graphics-integrated compute, write Vulkan compute on Windows/Linux, D3D12 compute on Xbox/Windows, Metal compute on Apple. Keep one HLSL or Slang source and cross-compile.

For ML inference deployed cross-platform, write CUDA for NVIDIA, MPS or Core ML for Apple, ROCm for AMD, OpenVINO for Intel. The lowest-common-denominator portable option is ONNX Runtime which abstracts these.

For ML training, CUDA is still the only realistic choice unless you are at MI300X scale and willing to invest in ROCm.

For general HPC, the answer increasingly depends on what supercomputer you are running on: ORNL Frontier means HIP, ALCF Aurora means SYCL, Riken Fugaku means OpenMP on ARM, anything on Perlmutter / Eos / Leonardo means CUDA.

### Junior to FAANG

A junior writes OpenCL because it is "portable" and ships at half the speed of equivalent CUDA on every platform. A senior at NVIDIA, AMD, or Intel picks the right tool per target, abstracts the kernel source via Slang or SYCL where it pays off, and ships at native performance everywhere.

---
