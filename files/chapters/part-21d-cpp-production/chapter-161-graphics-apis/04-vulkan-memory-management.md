## Vulkan Memory Management

Vulkan exposes GPU memory as raw byte allocations. The driver does not allocate memory for you when you create a buffer or image. You allocate memory separately, query the alignment and size requirements of the resource, and bind them. This is unfamiliar to anyone coming from D3D11 or OpenGL but it is the model the hardware actually uses.

### Memory Heaps and Memory Types

A physical device has one or more memory **heaps**, each backed by a different physical pool (system RAM, dedicated VRAM, BAR-mapped VRAM). Each heap exposes one or more **memory types** with different property flags.

```cpp
VkPhysicalDeviceMemoryProperties props;
vkGetPhysicalDeviceMemoryProperties(physical, &props);
for (uint32_t i = 0; i < props.memoryTypeCount; ++i) {
    auto& t = props.memoryTypes[i];
    printf("type %u heap %u flags 0x%x\n", i, t.heapIndex, t.propertyFlags);
}
```

The flags you care about are:

- `VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT`: physically on the GPU. Fast for shaders.
- `VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT`: mappable from the CPU.
- `VK_MEMORY_PROPERTY_HOST_COHERENT_BIT`: writes are visible to GPU without flushes.
- `VK_MEMORY_PROPERTY_HOST_CACHED_BIT`: cached on CPU side, fast to read back.
- `VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT`: tile memory only, never backed in DRAM. Mobile and Apple only.

A typical desktop GPU exposes:

- Type A: device-local. The bulk of VRAM. For images, textures, vertex buffers.
- Type B: host-visible, host-coherent. Small staging buffers for upload.
- Type C: device-local, host-visible. The "BAR" or "ReBAR" region. Small (256 MB without ReBAR, full VRAM with ReBAR), but lets the CPU write directly to VRAM. Used for per-frame uniform buffers.
- Type D: host-visible, host-cached. For GPU-to-CPU readback (screenshots, query results).

On unified memory architectures (Apple Silicon, integrated GPUs, consoles), all types may be both device-local and host-visible.

### VkDeviceMemory and Resource Binding

```cpp
VkBuffer create_buffer(VkDevice device, VkDeviceSize size, VkBufferUsageFlags usage) {
    VkBufferCreateInfo info{
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
    };
    VkBuffer buffer;
    vkCreateBuffer(device, &info, nullptr, &buffer);
    return buffer;
}

uint32_t find_memory_type(VkPhysicalDevice pd, uint32_t type_bits,
                         VkMemoryPropertyFlags want) {
    VkPhysicalDeviceMemoryProperties props;
    vkGetPhysicalDeviceMemoryProperties(pd, &props);
    for (uint32_t i = 0; i < props.memoryTypeCount; ++i) {
        if ((type_bits & (1 << i)) &&
            (props.memoryTypes[i].propertyFlags & want) == want) {
            return i;
        }
    }
    throw std::runtime_error("no compatible memory type");
}

VkDeviceMemory allocate_for(VkDevice device, VkPhysicalDevice pd,
                            VkBuffer buffer, VkMemoryPropertyFlags props) {
    VkMemoryRequirements req;
    vkGetBufferMemoryRequirements(device, buffer, &req);
    VkMemoryAllocateInfo ai{
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = req.size,
        .memoryTypeIndex = find_memory_type(pd, req.memoryTypeBits, props),
    };
    VkDeviceMemory mem;
    vkAllocateMemory(device, &ai, nullptr, &mem);
    vkBindBufferMemory(device, buffer, mem, 0);
    return mem;
}
```

Calling `vkAllocateMemory` per resource is wrong for production code. Drivers limit the number of allocations (typically 4096), and each allocation has fixed overhead. Real renderers allocate large blocks (64 MB or 256 MB) and sub-allocate.

### Vulkan Memory Allocator (VMA)

AMD's Vulkan Memory Allocator is the de facto standard. It is a single header (`vk_mem_alloc.h`, around 17,000 lines), zero dependencies, and used by Doom Eternal, Cyberpunk 2077, Unreal Engine, Godot, and most other Vulkan applications. You use it.

```cpp
#define VMA_IMPLEMENTATION
#include "vk_mem_alloc.h"

VmaAllocator create_allocator(VkInstance instance, VkPhysicalDevice pd, VkDevice d) {
    VmaAllocatorCreateInfo info{
        .physicalDevice = pd,
        .device = d,
        .instance = instance,
        .vulkanApiVersion = VK_API_VERSION_1_3,
    };
    VmaAllocator a;
    vmaCreateAllocator(&info, &a);
    return a;
}

struct VmaBuffer {
    VkBuffer buffer;
    VmaAllocation allocation;
    VmaAllocationInfo info;
};

VmaBuffer make_vertex_buffer(VmaAllocator a, VkDeviceSize size) {
    VkBufferCreateInfo bci{
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT |
                 VK_BUFFER_USAGE_TRANSFER_DST_BIT,
    };
    VmaAllocationCreateInfo aci{
        .usage = VMA_MEMORY_USAGE_AUTO,
        .requiredFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
    };
    VmaBuffer b;
    vmaCreateBuffer(a, &bci, &aci, &b.buffer, &b.allocation, &b.info);
    return b;
}

VmaBuffer make_persistent_uniform(VmaAllocator a, VkDeviceSize size) {
    VkBufferCreateInfo bci{
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT,
    };
    VmaAllocationCreateInfo aci{
        .flags = VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT |
                 VMA_ALLOCATION_CREATE_MAPPED_BIT,
        .usage = VMA_MEMORY_USAGE_AUTO_PREFER_DEVICE,
    };
    VmaBuffer b;
    vmaCreateBuffer(a, &bci, &aci, &b.buffer, &b.allocation, &b.info);
    return b;  // b.info.pMappedData is a writable CPU pointer
}
```

VMA picks memory types, sub-allocates from large pools, defragments, and reports detailed budget statistics. Its `VMA_ALLOCATION_CREATE_HOST_ACCESS_SEQUENTIAL_WRITE_BIT` flag tells the allocator that the CPU only writes (never reads) to this memory, which lets it pick write-combined memory types and skip CPU caching.

### Sub-Allocation Strategies

When you build your own allocator on top of VMA or VkDeviceMemory, you typically use one of three strategies.

**Free list with first-fit or best-fit.** A doubly-linked list of free regions. Allocation walks the list, finds a region, splits it. Free coalesces with neighbors. Simple and works well for varied sizes.

```cpp
struct Block {
    uint64_t offset;
    uint64_t size;
    bool free;
    Block* next;
    Block* prev;
};

class FreeListAllocator {
public:
    explicit FreeListAllocator(uint64_t capacity)
        : capacity_(capacity) {
        head_ = new Block{ 0, capacity, true, nullptr, nullptr };
    }

    uint64_t allocate(uint64_t size, uint64_t align) {
        for (Block* b = head_; b; b = b->next) {
            if (!b->free) continue;
            uint64_t aligned = (b->offset + align - 1) & ~(align - 1);
            uint64_t end = aligned + size;
            if (end > b->offset + b->size) continue;

            split(b, aligned, size);
            b->free = false;
            return aligned;
        }
        return UINT64_MAX;
    }

    void free(uint64_t offset) {
        for (Block* b = head_; b; b = b->next) {
            if (b->offset == offset) {
                b->free = true;
                coalesce(b);
                return;
            }
        }
    }

private:
    void split(Block* b, uint64_t aligned, uint64_t size);
    void coalesce(Block* b);

    Block* head_;
    uint64_t capacity_;
};
```

**Buddy allocator.** Recursive halving. Allocations and frees are O(log n), no fragmentation across power-of-two sizes, but internal fragmentation up to 50 percent. Good for fixed pool sizes.

**Linear (bump) allocator.** No free list at all. The frontier moves forward, allocations are O(1). Free is only "reset all". Used for transient per-frame allocations: command buffer scratch, dynamic uniform buffers. Reset at frame end.

### Transient Allocations and Per-Frame Rings

A renderer typically maintains a ring of three host-visible buffers, one per in-flight frame. Per-frame uniforms, particle data, GPU-driven indirect buffers go into the current frame's ring buffer with a linear allocator.

```cpp
class FrameRing {
public:
    FrameRing(VmaAllocator a, VkDeviceSize per_frame, uint32_t frames) {
        for (uint32_t i = 0; i < frames; ++i) {
            buffers_.push_back(make_persistent_uniform(a, per_frame));
            offsets_.push_back(0);
        }
    }

    struct Suballoc { VkBuffer buf; VkDeviceSize offset; void* ptr; };

    Suballoc allocate(uint32_t frame, VkDeviceSize size, VkDeviceSize align) {
        VkDeviceSize& off = offsets_[frame];
        off = (off + align - 1) & ~(align - 1);
        VkDeviceSize start = off;
        off += size;
        auto& b = buffers_[frame];
        return { b.buffer, start,
                 static_cast<char*>(b.info.pMappedData) + start };
    }

    void reset(uint32_t frame) { offsets_[frame] = 0; }

private:
    std::vector<VmaBuffer> buffers_;
    std::vector<VkDeviceSize> offsets_;
};
```

The pattern is: at frame N start, wait on the fence for frame N - frames_in_flight, reset its ring, write new data, submit, advance.

### Persistent Mapping

On most desktop GPUs, mapping host-visible memory is essentially free. You map once at creation and keep the pointer for the life of the buffer. The legacy pattern of `vkMapMemory` / `vkUnmapMemory` per write is wasteful. VMA's `VMA_ALLOCATION_CREATE_MAPPED_BIT` returns a pre-mapped pointer.

Watch out for non-coherent memory: if the type lacks `VK_MEMORY_PROPERTY_HOST_COHERENT_BIT`, you must call `vkFlushMappedMemoryRanges` after writes and `vkInvalidateMappedMemoryRanges` before reads. VMA exposes this via `vmaFlushAllocation`.

### Sparse and Tile Memory

For very large resources (sparse virtual textures, terrain, shadow maps that are partially loaded), Vulkan supports sparse binding. A sparse `VkImage` is created without committed memory. Memory is bound to specific tiles (64 KB blocks) on demand, on the sparse binding queue, asynchronously.

This is how megatexture-style virtual texturing works in id Tech and how Unreal's Virtual Shadow Maps stream memory. The complexity is significant, do not use sparse binding unless your problem requires it.

### Memory Budget Tracking

`VK_EXT_memory_budget` exposes how much VRAM is currently in use across all processes. A production renderer monitors this and degrades gracefully (drops texture mip levels, evicts cached shadows) when approaching the budget. VMA integrates this and exposes it via `vmaGetHeapBudgets`.

```cpp
VmaBudget budgets[VK_MAX_MEMORY_HEAPS];
vmaGetHeapBudgets(allocator, budgets);
for (uint32_t i = 0; i < heap_count; ++i) {
    auto& b = budgets[i];
    printf("heap %u: %llu / %llu MB used\n",
           i, b.usage / (1024*1024), b.budget / (1024*1024));
}
```

### Junior to FAANG

A junior writes one `vkAllocateMemory` per resource, hits the 4096-allocation limit during loading, and ships with crashes on AMD drivers. A senior at Epic integrates VMA, builds a frame ring on top of it, instruments with the budget extension, and ships a renderer that holds a steady 60 fps with 8 GB textures resident on a 12 GB card.

---
