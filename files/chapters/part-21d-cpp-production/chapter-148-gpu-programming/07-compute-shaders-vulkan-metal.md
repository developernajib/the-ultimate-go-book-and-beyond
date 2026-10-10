## Compute Shaders: Vulkan and Metal

CUDA is the dominant GPU compute API for data center ML, but it is not the only path to GPU computation. Vulkan compute shaders run on every GPU from mobile to server across Windows, Linux, and Android, without requiring the CUDA toolkit. Metal compute runs on every Apple Silicon device with access to 400 GB/s of unified memory. For applications that already use graphics APIs, or that need true cross-platform GPU support including mobile and Apple, compute shaders are the right tool.

### Vulkan Compute: Explicit, Cross-Platform

Vulkan is a low-level graphics and compute API from Khronos. "Low-level" is not an understatement, Vulkan requires explicit management of command buffers, memory allocation, synchronization barriers, and pipeline state. This verbosity exists because Vulkan eliminates the hidden overhead of older APIs (OpenGL, DirectX 11) and exposes exactly what the hardware does.

A Vulkan compute pipeline has no rasterizer, no vertex shader, no fragment shader, just a compute stage dispatching threads to a compute shader written in GLSL (compiled to SPIR-V intermediate representation at build time).

**GLSL Compute Shader** (`vector_add.comp`):

```glsl
#version 450

layout(local_size_x = 256) in;  // Equivalent to CUDA blockDim.x = 256

// Binding 0: input A
layout(std430, binding = 0) readonly buffer BufferA {
    float data[];
} buf_a;

// Binding 1: input B
layout(std430, binding = 1) readonly buffer BufferB {
    float data[];
} buf_b;

// Binding 2: output C
layout(std430, binding = 2) writeonly buffer BufferC {
    float data[];
} buf_c;

// Push constant for the array size
layout(push_constant) uniform PushConstants {
    uint n;
} pc;

void main() {
    uint idx = gl_GlobalInvocationID.x;  // Equivalent to CUDA's global thread index
    if (idx < pc.n) {
        buf_c.data[idx] = buf_a.data[idx] + buf_b.data[idx];
    }
}
// Compile to SPIR-V: glslc vector_add.comp -o vector_add.spv
```

**Vulkan C++ Host Code** (abbreviated, full Vulkan is 300+ lines of boilerplate):

```cpp
#include <vulkan/vulkan.h>
#include <vector>
#include <fstream>
#include <stdexcept>
#include <cstring>

// Helper to load SPIR-V bytecode
std::vector<uint32_t> load_spirv(const char* path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    size_t size = f.tellg();
    f.seekg(0);
    std::vector<uint32_t> code(size / 4);
    f.read(reinterpret_cast<char*>(code.data()), size);
    return code;
}

// Find a memory type index that satisfies the required properties
uint32_t find_memory_type(VkPhysicalDevice phys_dev, uint32_t type_filter,
                           VkMemoryPropertyFlags props) {
    VkPhysicalDeviceMemoryProperties mem_props;
    vkGetPhysicalDeviceMemoryProperties(phys_dev, &mem_props);
    for (uint32_t i = 0; i < mem_props.memoryTypeCount; ++i) {
        if ((type_filter & (1 << i)) &&
            (mem_props.memoryTypes[i].propertyFlags & props) == props) {
            return i;
        }
    }
    throw std::runtime_error("No suitable memory type");
}

// Allocate a Vulkan buffer and its backing device memory
void create_buffer(VkDevice device, VkPhysicalDevice phys_dev,
                   VkDeviceSize size, VkBufferUsageFlags usage,
                   VkMemoryPropertyFlags mem_props,
                   VkBuffer& buffer, VkDeviceMemory& memory) {
    VkBufferCreateInfo info{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};
    info.size  = size;
    info.usage = usage;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    vkCreateBuffer(device, &info, nullptr, &buffer);

    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, buffer, &req);

    VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};
    alloc.allocationSize  = req.size;
    alloc.memoryTypeIndex = find_memory_type(phys_dev, req.memoryTypeBits, mem_props);
    vkAllocateMemory(device, &alloc, nullptr, &memory);
    vkBindBufferMemory(device, buffer, memory, 0);
}

// Launch a compute dispatch (assumes pipeline/descriptor set already created)
void dispatch_compute(VkDevice device, VkCommandPool cmd_pool,
                      VkQueue compute_queue,
                      VkPipeline pipeline, VkPipelineLayout layout,
                      VkDescriptorSet desc_set,
                      uint32_t n) {
    VkCommandBufferAllocateInfo cmd_info{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};
    cmd_info.commandPool        = cmd_pool;
    cmd_info.level              = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cmd_info.commandBufferCount = 1;

    VkCommandBuffer cmd;
    vkAllocateCommandBuffers(device, &cmd_info, &cmd);

    VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    begin.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &begin);

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE,
                            layout, 0, 1, &desc_set, 0, nullptr);

    // Push constants: pass n to shader
    vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(n), &n);

    // Dispatch: (n + 255) / 256 groups × 1 × 1, each with 256 threads
    vkCmdDispatch(cmd, (n + 255) / 256, 1, 1);

    // Memory barrier: ensure compute writes are visible before transfer
    VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(cmd,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
        0, 1, &barrier, 0, nullptr, 0, nullptr);

    vkEndCommandBuffer(cmd);

    VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};
    submit.commandBufferCount = 1;
    submit.pCommandBuffers    = &cmd;

    VkFence fence;
    VkFenceCreateInfo fence_info{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    vkCreateFence(device, &fence_info, nullptr, &fence);
    vkQueueSubmit(compute_queue, 1, &submit, fence);
    vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);

    vkDestroyFence(device, fence, nullptr);
    vkFreeCommandBuffers(device, cmd_pool, 1, &cmd);
}
```

The full Vulkan setup (instance, physical device selection, logical device, queue family discovery, descriptor pool, descriptor set layout, pipeline layout, compute pipeline creation from SPIR-V) typically runs 200-400 lines before you can dispatch a single kernel. Libraries like `vk-bootstrap` and `VulkanMemoryAllocator` (VMA) reduce this substantially.

### Metal Compute: Apple Silicon's Unified Memory Advantage

Metal is Apple's graphics and compute API for iOS, macOS, and visionOS. The Metal Shading Language (MSL) is a C++14 dialect with GPU extensions, syntactically closer to standard C++ than GLSL.

Apple Silicon's defining advantage for compute: **unified memory**. The CPU and GPU share the same physical DRAM. There is no PCIe bus, no DMA copy, no host-device transfer. An `MTLBuffer` is accessible from both CPU code and GPU shaders simultaneously. This changes the performance model fundamentally.

**Metal Kernel** (MSL, saved as part of a `.metal` file):

```cpp
// vector_add.metal, compiled by Xcode or xcrun -sdk macosx metal
#include <metal_stdlib>
using namespace metal;

// [[kernel]]: marks a compute kernel (like CUDA __global__)
// [[buffer(N)]]: binds to the Nth buffer in the argument table
// [[thread_position_in_grid]]: equivalent to CUDA's global thread index
kernel void vector_add(
    device const float* a [[ buffer(0) ]],
    device const float* b [[ buffer(1) ]],
    device float*       c [[ buffer(2) ]],
    constant uint&      n [[ buffer(3) ]],
    uint idx              [[ thread_position_in_grid ]])
{
    if (idx < n) {
        c[idx] = a[idx] + b[idx];
    }
}

// Tiled matrix multiply in MSL using threadgroup memory (= CUDA shared memory)
kernel void tiled_gemm(
    device const float* A    [[ buffer(0) ]],
    device const float* B    [[ buffer(1) ]],
    device float*       C    [[ buffer(2) ]],
    constant uint3&     dims [[ buffer(3) ]],  // dims.x=M, dims.y=N, dims.z=K
    threadgroup float* tA    [[ threadgroup(0) ]],  // dynamic threadgroup memory
    threadgroup float* tB    [[ threadgroup(1) ]],
    uint2 gid  [[ thread_position_in_grid ]],
    uint2 tid  [[ thread_position_in_threadgroup ]],
    uint2 tsz  [[ threads_per_threadgroup ]])
{
    uint M = dims.x, N = dims.y, K = dims.z;
    uint TILE = tsz.x;

    float acc = 0.0f;
    uint num_tiles = (K + TILE - 1) / TILE;

    for (uint t = 0; t < num_tiles; ++t) {
        uint a_col = t * TILE + tid.x;
        uint b_row = t * TILE + tid.y;

        tA[tid.y * TILE + tid.x] = (gid.y < M && a_col < K)
            ? A[gid.y * K + a_col] : 0.0f;
        tB[tid.y * TILE + tid.x] = (b_row < K && gid.x < N)
            ? B[b_row * N + gid.x] : 0.0f;

        threadgroup_barrier(mem_flags::mem_threadgroup);

        for (uint k = 0; k < TILE; ++k)
            acc += tA[tid.y * TILE + k] * tB[k * TILE + tid.x];

        threadgroup_barrier(mem_flags::mem_threadgroup);
    }

    if (gid.y < M && gid.x < N) C[gid.y * N + gid.x] = acc;
}
```

**Metal Host Code (Objective-C++ or C++):**

```objc
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>

void metal_vector_add(int n) {
    // 1. Create device (GPU)
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();

    // 2. Load compiled shader library
    id<MTLLibrary> library = [device newDefaultLibrary];
    id<MTLFunction> func = [library newFunctionWithName:@"vector_add"];
    id<MTLComputePipelineState> pso =
        [device newComputePipelineStateWithFunction:func error:nil];

    // 3. Create command queue
    id<MTLCommandQueue> queue = [device newCommandQueue];

    // 4. Allocate buffers (zero-copy: CPU and GPU share the same physical memory)
    size_t bytes = n * sizeof(float);
    id<MTLBuffer> buf_a = [device newBufferWithLength:bytes
                                              options:MTLResourceStorageModeShared];
    id<MTLBuffer> buf_b = [device newBufferWithLength:bytes
                                              options:MTLResourceStorageModeShared];
    id<MTLBuffer> buf_c = [device newBufferWithLength:bytes
                                              options:MTLResourceStorageModeShared];

    // 5. Initialize data, directly via CPU pointer, no copy needed
    float* a = static_cast<float*>(buf_a.contents);
    float* b = static_cast<float*>(buf_b.contents);
    for (int i = 0; i < n; ++i) { a[i] = i; b[i] = i * 2.0f; }
    uint32_t n_u = n;

    // 6. Encode and dispatch compute
    id<MTLCommandBuffer> cmd = [queue commandBuffer];
    id<MTLComputeCommandEncoder> encoder = [cmd computeCommandEncoder];
    [encoder setComputePipelineState:pso];
    [encoder setBuffer:buf_a offset:0 atIndex:0];
    [encoder setBuffer:buf_b offset:0 atIndex:1];
    [encoder setBuffer:buf_c offset:0 atIndex:2];
    [encoder setBytes:&n_u length:sizeof(n_u) atIndex:3];

    MTLSize threads_per_group = {256, 1, 1};
    MTLSize num_groups = {((NSUInteger)n + 255) / 256, 1, 1};
    [encoder dispatchThreadgroups:num_groups threadsPerThreadgroup:threads_per_group];
    [encoder endEncoding];

    // 7. Commit and wait
    [cmd commit];
    [cmd waitUntilCompleted];

    // 8. Read results, directly, no copy needed (unified memory!)
    float* c = static_cast<float*>(buf_c.contents);
    NSLog(@"c[0]=%.1f c[1]=%.1f c[2]=%.1f", c[0], c[1], c[2]);
}
```

### Apple Silicon Memory Bandwidth

The Apple M3 Ultra has 800 GB/s of unified memory bandwidth, 400× higher than PCIe 4.0 x16 (64 GB/s peak H2D). For memory-bound GPU kernels like transformers and attention, the absence of the CPU-GPU transfer bottleneck is a significant architectural advantage. A 70B parameter model that barely fits in 192GB of M3 Ultra unified memory can run without any PCIe transfer overhead that would be unavoidable on a discrete GPU system.

### WebGPU: Compute in the Browser

WebGPU is the successor to WebGL, providing compute shader support via WGSL (WebGPU Shading Language):

```wgsl
// WGSL compute shader, runs in browser via WebGPU API
@group(0) @binding(0) var<storage, read>       a : array<f32>;
@group(0) @binding(1) var<storage, read>       b : array<f32>;
@group(0) @binding(2) var<storage, read_write> c : array<f32>;

@compute @workgroup_size(256)
fn vector_add(@builtin(global_invocation_id) gid : vec3<u32>) {
    let i = gid.x;
    if (i < arrayLength(&a)) {
        c[i] = a[i] + b[i];
    }
}
```

WebGPU is available in Chrome 113+ and Firefox Nightly. It translates to Metal on macOS, Vulkan on Linux/Windows, and Direct3D 12 on Windows. The abstraction layer adds ~10-20% overhead vs native Vulkan but enables GPU compute in untrusted browser environments.

### Go Comparison

Go has no production bindings for Vulkan compute or Metal. `github.com/vulkan-go/vulkan` provides Vulkan bindings but is primarily focused on graphics, not compute. There are no Go Metal bindings. For Apple Silicon GPU work from Go, the only practical approaches are CGo wrapping Objective-C++ Metal code, or calling a C++ subprocess that owns the Metal pipeline. This is a legitimate use case, for example, a Go inference server on Mac mini M3 cluster nodes, where the GPU work is in Metal C++ and the serving logic is in Go.

---
