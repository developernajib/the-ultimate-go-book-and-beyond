## OpenCL and SYCL: Cross-Platform GPU Programming

CUDA runs only on NVIDIA hardware. The moment your target platform includes AMD GPUs, Intel integrated graphics, Apple Silicon, FPGAs, or mobile GPUs, you need a different approach. OpenCL and SYCL are the two main cross-platform compute standards, one is the original open standard, the other is the modern C++ replacement.

### OpenCL: The Original Open Standard

OpenCL (Open Computing Language) is a Khronos Group standard that defines a portable compute API for CPUs, GPUs, FPGAs, and DSPs from any vendor. An OpenCL program runs on AMD RX 7900, Intel Iris Xe, Apple M3, Qualcomm Adreno, and NVIDIA RTX (though NVIDIA's OpenCL driver is deliberately under-invested).

OpenCL separates host code (C++ API) from device code (OpenCL C, compiled at runtime from source strings). This runtime compilation is one of OpenCL's major inconveniences, you ship kernel source code as strings and compile it for the target device at startup.

```cpp
#include <CL/cl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <stdexcept>
#include <string>

// The kernel is OpenCL C, a C99 dialect with GPU extensions
const char* VECTOR_ADD_KERNEL = R"(
__kernel void vector_add(__global const float* a,
                         __global const float* b,
                         __global float* c,
                         int n) {
    int idx = get_global_id(0);
    if (idx < n) c[idx] = a[idx] + b[idx];
}
)";

void opencl_vector_add(int n) {
    // 1. Discover platform and device
    cl_platform_id platform;
    cl_device_id   device;
    clGetPlatformIDs(1, &platform, nullptr);
    clGetDeviceIDs(platform, CL_DEVICE_TYPE_GPU, 1, &device, nullptr);

    char device_name[128];
    clGetDeviceInfo(device, CL_DEVICE_NAME, sizeof(device_name), device_name, nullptr);
    printf("Using device: %s\n", device_name);

    // 2. Create context and command queue
    cl_int err;
    cl_context context = clCreateContext(nullptr, 1, &device, nullptr, nullptr, &err);
    cl_command_queue queue = clCreateCommandQueueWithProperties(
        context, device, nullptr, &err);

    // 3. Compile kernel at runtime
    cl_program program = clCreateProgramWithSource(
        context, 1, &VECTOR_ADD_KERNEL, nullptr, &err);
    err = clBuildProgram(program, 1, &device, "-cl-fast-relaxed-math", nullptr, nullptr);

    if (err != CL_SUCCESS) {
        // Retrieve build log on failure
        size_t log_size;
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG,
                              0, nullptr, &log_size);
        std::string log(log_size, '\0');
        clGetProgramBuildInfo(program, device, CL_PROGRAM_BUILD_LOG,
                              log_size, log.data(), nullptr);
        throw std::runtime_error("Build failed: " + log);
    }

    cl_kernel kernel = clCreateKernel(program, "vector_add", &err);

    // 4. Allocate and initialize host data
    std::vector<float> h_a(n), h_b(n), h_c(n);
    for (int i = 0; i < n; ++i) { h_a[i] = i; h_b[i] = i * 2.0f; }

    // 5. Create device buffers
    size_t bytes = n * sizeof(float);
    cl_mem d_a = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                                bytes, h_a.data(), &err);
    cl_mem d_b = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR,
                                bytes, h_b.data(), &err);
    cl_mem d_c = clCreateBuffer(context, CL_MEM_WRITE_ONLY, bytes, nullptr, &err);

    // 6. Set kernel arguments
    clSetKernelArg(kernel, 0, sizeof(cl_mem), &d_a);
    clSetKernelArg(kernel, 1, sizeof(cl_mem), &d_b);
    clSetKernelArg(kernel, 2, sizeof(cl_mem), &d_c);
    clSetKernelArg(kernel, 3, sizeof(int), &n);

    // 7. Launch kernel
    size_t global_size = (n + 255) & ~255;  // Round up to multiple of 256
    size_t local_size  = 256;
    clEnqueueNDRangeKernel(queue, kernel, 1, nullptr,
                           &global_size, &local_size, 0, nullptr, nullptr);

    // 8. Read results back
    clEnqueueReadBuffer(queue, d_c, CL_TRUE, 0, bytes, h_c.data(),
                        0, nullptr, nullptr);

    printf("c[0]=%.1f c[1]=%.1f c[2]=%.1f\n", h_c[0], h_c[1], h_c[2]);

    // 9. Cleanup
    clReleaseMemObject(d_a); clReleaseMemObject(d_b); clReleaseMemObject(d_c);
    clReleaseKernel(kernel); clReleaseProgram(program);
    clReleaseCommandQueue(queue); clReleaseContext(context);
}
// Build: g++ -O2 opencl_add.cpp -lOpenCL -o opencl_add
```

The boilerplate is significant: 9 distinct steps to run a trivial kernel. This verbosity, combined with CUDA's richer ecosystem (cuDNN, TensorRT, NCCL for multi-GPU), is why OpenCL lost the ML compute race despite being technically portable.

### Why OpenCL Lost the ML Race

OpenCL's portability is genuine but its ecosystem is thin. CUDA has:
- cuDNN (deep learning primitives)
- TensorRT (inference optimization)
- NCCL (multi-GPU collective communication)
- Nsight (high-precision GPU profiler)
- Thousands of CUDA-specific research papers with reference code

OpenCL has none of these. AMD responded with ROCm (see HIP below). Intel doubled down on SYCL. But for pure ML training and inference, CUDA's ecosystem advantage is insurmountable in practice.

### SYCL: Modern C++ for Cross-Platform GPU

SYCL (pronounced "sickle") is a modern C++ abstraction layer over low-level GPU APIs. It is a Khronos standard, but Intel's implementation (DPC++, Data Parallel C++) is the most mature. SYCL enables **single-source** programming: host and device code live in the same `.cpp` file, sharing types and lambdas.

```cpp
#include <sycl/sycl.hpp>
#include <vector>
#include <numeric>
#include <cstdio>

// SYCL vector addition, single source, runs on GPU or CPU
void sycl_vector_add(int n) {
    std::vector<float> h_a(n), h_b(n), h_c(n);
    for (int i = 0; i < n; ++i) { h_a[i] = i; h_b[i] = i * 2.0f; }

    // Queue selects default GPU (pass sycl::cpu_selector_v for CPU fallback)
    sycl::queue q{sycl::gpu_selector_v};
    printf("Running on: %s\n",
           q.get_device().get_info<sycl::info::device::name>().c_str());

    // SYCL buffers manage data movement automatically
    sycl::buffer<float> buf_a{h_a};
    sycl::buffer<float> buf_b{h_b};
    sycl::buffer<float> buf_c{h_c};

    // Submit a command group to the queue
    q.submit([&](sycl::handler& h) {
        // Accessors declare how the kernel uses each buffer
        auto a = buf_a.get_access<sycl::access::mode::read>(h);
        auto b = buf_b.get_access<sycl::access::mode::read>(h);
        auto c = buf_c.get_access<sycl::access::mode::write>(h);

        // parallel_for launches one work-item per element
        h.parallel_for(sycl::range{static_cast<size_t>(n)},
                       [=](sycl::id<1> i) {
            c[i] = a[i] + b[i];
        });
    });

    // buf_c going out of scope synchronizes and copies back to h_c
    // (SYCL accessors outside a submit trigger implicit synchronization)
    auto result = buf_c.get_host_access();
    printf("c[0]=%.1f c[1]=%.1f c[2]=%.1f\n",
           result[0], result[1], result[2]);
}
// Build with Intel DPC++: dpcpp -O2 sycl_add.cpp -o sycl_add
// Build with AdaptiveCpp (AMD/NVIDIA): acpp --acpp-targets=omp,cuda:sm_80 sycl_add.cpp
```

### SYCL GEMM with Local Memory (Equivalent to CUDA Shared Memory)

GPU kernels execute thousands of lightweight threads in parallel across the graphics processor's streaming multiprocessors, making them highly effective for data-parallel workloads. The kernel below follows the SIMT (Single Instruction, Multiple Threads) programming model, where each thread computes on an independent element of the data set.
```cpp
#include <sycl/sycl.hpp>

constexpr int TILE = 16;

void sycl_tiled_gemm(sycl::queue& q,
                     const float* A, const float* B, float* C,
                     int M, int N, int K) {
    sycl::buffer<float, 2> buf_A{A, sycl::range<2>{(size_t)M, (size_t)K}};
    sycl::buffer<float, 2> buf_B{B, sycl::range<2>{(size_t)K, (size_t)N}};
    sycl::buffer<float, 2> buf_C{C, sycl::range<2>{(size_t)M, (size_t)N}};

    q.submit([&](sycl::handler& h) {
        auto a = buf_A.get_access<sycl::access::mode::read>(h);
        auto b = buf_B.get_access<sycl::access::mode::read>(h);
        auto c = buf_C.get_access<sycl::access::mode::read_write>(h);

        // Local memory (equivalent to CUDA __shared__)
        sycl::local_accessor<float, 2> local_a{{TILE, TILE}, h};
        sycl::local_accessor<float, 2> local_b{{TILE, TILE}, h};

        auto global_range = sycl::range<2>{(size_t)M, (size_t)N};
        auto local_range  = sycl::range<2>{TILE, TILE};

        h.parallel_for(sycl::nd_range<2>{global_range, local_range},
                       [=](sycl::nd_item<2> item) {
            int row = item.get_global_id(0);
            int col = item.get_global_id(1);
            int ly  = item.get_local_id(0);
            int lx  = item.get_local_id(1);

            float acc = 0.0f;
            int num_tiles = (K + TILE - 1) / TILE;

            for (int t = 0; t < num_tiles; ++t) {
                int a_col = t * TILE + lx;
                int b_row = t * TILE + ly;

                local_a[ly][lx] = (row < M && a_col < K) ? a[row][a_col] : 0.0f;
                local_b[ly][lx] = (b_row < K && col < N) ? b[b_row][col] : 0.0f;

                item.barrier(sycl::access::fence_space::local_space);

                for (int k = 0; k < TILE; ++k)
                    acc += local_a[ly][k] * local_b[k][lx];

                item.barrier(sycl::access::fence_space::local_space);
            }

            if (row < M && col < N) c[row][col] = acc;
        });
    });
}
```

The structural similarity to CUDA tiled GEMM is intentional, SYCL maps directly to the same GPU concepts but with standard C++ syntax.

### HIP: CUDA Portability to AMD

AMD's HIP (Heterogeneous-Compute Interface for Portability) provides a near-identical API to CUDA, targeting AMD GPUs:

```cpp
// HIP code, nearly identical to CUDA
#include <hip/hip_runtime.h>

__global__ void hip_vector_add(const float* a, const float* b,
                                float* c, int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < n) c[i] = a[i] + b[i];
}

// hipMalloc, hipMemcpy, hipFree mirror cudaMalloc, cudaMemcpy, cudaFree
// hipcc compiler mirrors nvcc
// hipify-perl converts CUDA source to HIP source automatically
```

AMD provides `hipify-perl` and `hipify-clang` to mechanically translate CUDA code to HIP. For well-written CUDA that avoids CUDA-specific extensions, translation is often fully automated.

### When to Choose What

| Technology | Target hardware | Ecosystem | Code complexity |
|---|---|---|---|
| CUDA | NVIDIA only | Excellent (cuDNN, TRT) | Medium |
| HIP | AMD (+ NVIDIA via ROCm) | Good (MIOpen, rocBLAS) | Medium |
| OpenCL | Any GPU/FPGA/CPU | Minimal | High |
| SYCL/DPC++ | Intel + others | Growing | Low-Medium |
| WebGPU/WGSL | Browser, any GPU | Emerging | Medium |

For pure NVIDIA ML inference: CUDA + TensorRT. For AMD hardware with a CUDA codebase: HIP + hipify. For Intel GPU (Gaudi, Arc): SYCL/DPC++. For truly portable compute that must run on unknown hardware: SYCL or OpenCL.

### Go Comparison

Go has limited GPU library bindings regardless of platform. `go-opencl` (`github.com/samuel/go-opencl`) provides OpenCL 1.1 bindings but is unmaintained. There are no production-quality Go bindings for SYCL or HIP. For cross-platform GPU compute from a Go service, the standard approach is a microservice boundary: a C++ or Python process owns the GPU regardless of which API it uses, and Go communicates via gRPC or shared memory IPC.

---
