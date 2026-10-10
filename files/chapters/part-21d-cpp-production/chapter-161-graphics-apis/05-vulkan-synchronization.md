## Vulkan Synchronization

Synchronization is the hardest part of Vulkan. Get it wrong and your renderer corrupts framebuffers, hangs the GPU, or works on NVIDIA but renders garbage on AMD. Get it right and you get the full performance the hardware can offer with multiple queues running in parallel.

There are four primitives. Use the right one for the right scope.

### VkFence: GPU to CPU

A `VkFence` is signaled by the GPU and waited on by the CPU. Use it to know when a command buffer has finished executing so you can safely reuse its resources.

```cpp
VkFenceCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO,
    .flags = VK_FENCE_CREATE_SIGNALED_BIT,
};
VkFence fence;
vkCreateFence(device, &info, nullptr, &fence);

// Submit work, signal fence on completion
VkSubmitInfo si{ /* command buffer */ };
vkQueueSubmit(queue, 1, &si, fence);

// Later, wait
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);
vkResetFences(device, 1, &fence);
```

Pattern: one fence per frame in flight. At frame N start, wait on the fence for frame N - 2 (with double buffering). That guarantees frame N - 2's command buffer, ring allocations, and per-frame descriptor sets are all done.

### VkSemaphore: GPU to GPU

A binary semaphore synchronizes two queue submissions. The classic case is the swapchain handshake.

```cpp
uint32_t image_index;
vkAcquireNextImageKHR(device, swapchain, UINT64_MAX,
                     image_acquired_sem, VK_NULL_HANDLE, &image_index);

VkPipelineStageFlags wait_stage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
VkSubmitInfo si{
    .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
    .waitSemaphoreCount = 1,
    .pWaitSemaphores = &image_acquired_sem,
    .pWaitDstStageMask = &wait_stage,
    .commandBufferCount = 1,
    .pCommandBuffers = &cb,
    .signalSemaphoreCount = 1,
    .pSignalSemaphores = &render_finished_sem,
};
vkQueueSubmit(graphics_queue, 1, &si, in_flight_fence);

VkPresentInfoKHR pi{
    .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
    .waitSemaphoreCount = 1,
    .pWaitSemaphores = &render_finished_sem,
    .swapchainCount = 1,
    .pSwapchains = &swapchain,
    .pImageIndices = &image_index,
};
vkQueuePresentKHR(graphics_queue, &pi);
```

Binary semaphores have a major limitation: they are single-use. Once signaled and waited, they must not be signaled again until the wait completes. This makes complex multi-queue dependency graphs cumbersome.

### Timeline Semaphores

Vulkan 1.2 introduced timeline semaphores. A timeline semaphore holds a monotonically increasing 64-bit counter. You signal value N, you wait for value >= M. They replace fences and binary semaphores in most code paths and they support both CPU and GPU waits / signals.

```cpp
VkSemaphoreTypeCreateInfo type_info{
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
    .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE,
    .initialValue = 0,
};
VkSemaphoreCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO,
    .pNext = &type_info,
};
VkSemaphore timeline;
vkCreateSemaphore(device, &info, nullptr, &timeline);

// Submit signaling value 100
uint64_t signal_value = 100;
VkTimelineSemaphoreSubmitInfo tsi{
    .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
    .signalSemaphoreValueCount = 1,
    .pSignalSemaphoreValues = &signal_value,
};
VkSubmitInfo si{
    .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
    .pNext = &tsi,
    .signalSemaphoreCount = 1,
    .pSignalSemaphores = &timeline,
    /* ... */
};
vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE);

// CPU wait
uint64_t wait_value = 100;
VkSemaphoreWaitInfo wi{
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO,
    .semaphoreCount = 1,
    .pSemaphores = &timeline,
    .pValues = &wait_value,
};
vkWaitSemaphores(device, &wi, UINT64_MAX);
```

A modern Vulkan renderer uses one timeline semaphore per queue. Frame N signals value N. The CPU waits for value N - 2 at the start of frame N. Cross-queue dependencies become "compute queue waits for graphics queue value 99" naturally.

### VkEvent

Events are intra-queue, intra-command-buffer fine-grained sync. They are rarely used in practice and are not supported on all hardware paths efficiently. Skip them unless you have a measured reason.

### Pipeline Barriers

This is the hard one. A pipeline barrier expresses execution and memory dependencies between GPU commands. It tells the driver: "all writes from these stages, with these access types, must be visible to subsequent reads from these other stages, with those access types."

The legacy form:

```cpp
VkImageMemoryBarrier barrier{
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
    .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
    .dstAccessMask = VK_ACCESS_SHADER_READ_BIT,
    .oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
    .image = image,
    .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 },
};
vkCmdPipelineBarrier(cb,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,  // src stage
    VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,          // dst stage
    0, 0, nullptr, 0, nullptr, 1, &barrier);
```

This says: the writes from the color attachment output stage must complete and become visible before the fragment shader stage reads. The image transitions layout from `COLOR_ATTACHMENT_OPTIMAL` (which the GPU may store in a tiled compressed format) to `SHADER_READ_ONLY_OPTIMAL` (which may require a decompression pass).

The hard part is that stage masks and access masks are independent and have to match. The valid combinations are an enormous matrix in the spec. The Khronos sync validation layer catches most mistakes.

### Synchronization2

Vulkan 1.3 promotes `VK_KHR_synchronization2`, which redesigns the API to be saner. Stage and access flags are unified into 64-bit values, barriers are passed as structs in arrays, and the rules around layout transitions are clearer.

```cpp
VkImageMemoryBarrier2 barrier{
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2,
    .srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
    .srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT,
    .dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT,
    .dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT,
    .oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
    .image = image,
    .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 },
};
VkDependencyInfo dep{
    .sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO,
    .imageMemoryBarrierCount = 1,
    .pImageMemoryBarriers = &barrier,
};
vkCmdPipelineBarrier2(cb, &dep);
```

Use `synchronization2` for all new code. The old API is still supported but harder to reason about.

### Image Layouts

A `VkImage` lives in one of about a dozen layouts. The driver uses the layout to pick the optimal tiling, compression, and access pattern.

| Layout | Use |
|---|---|
| `UNDEFINED` | initial, contents undefined |
| `GENERAL` | mappable for compute writes, slowest |
| `COLOR_ATTACHMENT_OPTIMAL` | render target, may be DCC-compressed on AMD |
| `DEPTH_STENCIL_ATTACHMENT_OPTIMAL` | depth target, HiZ-compressed |
| `SHADER_READ_ONLY_OPTIMAL` | sampled texture |
| `TRANSFER_SRC_OPTIMAL` | source of vkCmdCopy |
| `TRANSFER_DST_OPTIMAL` | dest of vkCmdCopy |
| `PRESENT_SRC_KHR` | ready for swapchain present |

The transition from `COLOR_ATTACHMENT_OPTIMAL` to `SHADER_READ_ONLY_OPTIMAL` triggers a decompression on hardware that uses delta color compression (DCC on AMD, similar on Turing). On Ada Lovelace and RDNA 3, hardware can sample directly from compressed images via `VK_EXT_attachment_feedback_loop_layout`, eliminating the decompress.

### Common Synchronization Bugs

**Missing barrier between render pass and sample.** You write a render target in pass A, sample it as a texture in pass B, no barrier between. Driver races, you get last frame's data 50 percent of the time.

**Over-broad pipeline stages.** You barrier with `srcStageMask = ALL_COMMANDS`, `dstStageMask = ALL_COMMANDS`. This works but flushes the entire pipeline. On a tile-based GPU it forces a full tile resolve. Use the narrowest stages that match the actual producer and consumer.

**Wrong access mask direction.** You set `srcAccessMask = SHADER_READ`. Reads do not need to be made visible to anything because reads do not write data. The correct src is the producer's write access.

**Forgotten queue ownership transfer.** A resource that is written on the graphics queue and read on the compute queue with `EXCLUSIVE` sharing requires a release barrier on the source queue and an acquire barrier on the destination queue. If you skip this you get correct results on most drivers and corruption on others.

**Layout mismatch with image view.** You sample from an image while it is in `COLOR_ATTACHMENT_OPTIMAL`. The sample returns garbage on hardware that compresses color attachments differently than read-only textures.

**Frame N depends on frame N-1's render target without proper fence.** Common with split-frame or temporal techniques (TAA, motion vectors). The previous frame's history texture must be either in a state that survives the frame fence, or guarded by an explicit semaphore.

### Sync Validation Layer

Khronos ships a synchronization validation layer that catches missing barriers at runtime. It is slower than the standard validation layer (5x to 10x frame time) so you do not run it always, but it is essential during bringup.

```bash
VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation \
VK_LAYER_ENABLES=VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT \
./your_app
```

It will tell you, for each missing barrier, the source command, the destination command, and the resource involved.

### Junior to FAANG

A junior asks "do I need a barrier here?" and adds them everywhere to be safe, costing 30 percent frame time on tile-based GPUs. A senior at AMD or Apple driver team computes the minimum barriers from a render graph at build time, knows which transitions are free on which architecture, and ships a renderer where adding sync validation produces zero new errors.

---
