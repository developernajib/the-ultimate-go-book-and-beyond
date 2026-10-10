## Vulkan Fundamentals

Vulkan is the explicit graphics API of the Khronos Group, designed as the successor to OpenGL with no compatibility constraint. It exposes the GPU at the level of abstraction the driver actually operates on. Where OpenGL has 200 calls that mean "draw something", Vulkan has 5000 calls that each map to one or two GPU commands. This is harder to use and dramatically faster when used correctly.

This section walks through the core objects you must know cold for a senior Vulkan interview. The full Vulkan 1.3 specification is 2,800 pages. This is the 30 pages you cannot ship without.

### VkInstance

The instance is the application's connection to the Vulkan loader. It is the first object you create and the last you destroy.

```cpp
#define VK_USE_PLATFORM_WIN32_KHR
#include <vulkan/vulkan.h>
#include <vector>
#include <stdexcept>

VkInstance create_instance() {
    VkApplicationInfo app{
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "renderer",
        .applicationVersion = VK_MAKE_API_VERSION(0, 1, 0, 0),
        .pEngineName = "custom",
        .engineVersion = VK_MAKE_API_VERSION(0, 1, 0, 0),
        .apiVersion = VK_API_VERSION_1_3,
    };

    std::vector<const char*> extensions{
        VK_KHR_SURFACE_EXTENSION_NAME,
        VK_KHR_WIN32_SURFACE_EXTENSION_NAME,
        VK_EXT_DEBUG_UTILS_EXTENSION_NAME,
    };
    std::vector<const char*> layers{
        "VK_LAYER_KHRONOS_validation",
    };

    VkInstanceCreateInfo info{
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .pApplicationInfo = &app,
        .enabledLayerCount = static_cast<uint32_t>(layers.size()),
        .ppEnabledLayerNames = layers.data(),
        .enabledExtensionCount = static_cast<uint32_t>(extensions.size()),
        .ppEnabledExtensionNames = extensions.data(),
    };

    VkInstance instance;
    if (vkCreateInstance(&info, nullptr, &instance) != VK_SUCCESS) {
        throw std::runtime_error("vkCreateInstance failed");
    }
    return instance;
}
```

The `VK_LAYER_KHRONOS_validation` layer is the validation layer. Always run with it during development. It catches roughly 95 percent of Vulkan misuse before it manifests as a GPU hang or driver crash.

### VkPhysicalDevice and VkDevice

A `VkPhysicalDevice` represents a GPU. A `VkDevice` is your application's logical handle to it. You enumerate physical devices, pick one based on properties and features, then create a logical device with the queues and extensions you need.

```cpp
struct DeviceContext {
    VkPhysicalDevice physical;
    VkDevice device;
    uint32_t graphics_family;
    VkQueue graphics_queue;
};

DeviceContext create_device(VkInstance instance, VkSurfaceKHR surface) {
    uint32_t count = 0;
    vkEnumeratePhysicalDevices(instance, &count, nullptr);
    std::vector<VkPhysicalDevice> devices(count);
    vkEnumeratePhysicalDevices(instance, &count, devices.data());

    VkPhysicalDevice picked = VK_NULL_HANDLE;
    uint32_t graphics_family = UINT32_MAX;

    for (auto pd : devices) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(pd, &props);
        if (props.deviceType != VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) continue;

        uint32_t qcount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(pd, &qcount, nullptr);
        std::vector<VkQueueFamilyProperties> qfams(qcount);
        vkGetPhysicalDeviceQueueFamilyProperties(pd, &qcount, qfams.data());

        for (uint32_t i = 0; i < qcount; ++i) {
            VkBool32 present = VK_FALSE;
            vkGetPhysicalDeviceSurfaceSupportKHR(pd, i, surface, &present);
            if ((qfams[i].queueFlags & VK_QUEUE_GRAPHICS_BIT) && present) {
                picked = pd;
                graphics_family = i;
                goto found;
            }
        }
    }
found:
    if (picked == VK_NULL_HANDLE) throw std::runtime_error("no suitable GPU");

    float prio = 1.0f;
    VkDeviceQueueCreateInfo qinfo{
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = graphics_family,
        .queueCount = 1,
        .pQueuePriorities = &prio,
    };

    std::vector<const char*> exts{ VK_KHR_SWAPCHAIN_EXTENSION_NAME };

    VkPhysicalDeviceVulkan13Features f13{
        .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES,
        .synchronization2 = VK_TRUE,
        .dynamicRendering = VK_TRUE,
    };

    VkDeviceCreateInfo dinfo{
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .pNext = &f13,
        .queueCreateInfoCount = 1,
        .pQueueCreateInfos = &qinfo,
        .enabledExtensionCount = static_cast<uint32_t>(exts.size()),
        .ppEnabledExtensionNames = exts.data(),
    };

    DeviceContext ctx{ .physical = picked, .graphics_family = graphics_family };
    vkCreateDevice(picked, &dinfo, nullptr, &ctx.device);
    vkGetDeviceQueue(ctx.device, graphics_family, 0, &ctx.graphics_queue);
    return ctx;
}
```

### Queue Families

A queue family is a category of work the GPU can execute. The standard ones are graphics, compute, transfer, and sparse binding. Most desktop GPUs expose at least three families:

- A universal family that supports graphics, compute, and transfer.
- A compute-only family (often called "async compute") that runs on a different hardware scheduler and can execute concurrently with graphics work.
- A transfer-only family (DMA engine) that copies between host and device memory without occupying the main shader cores.

A senior renderer uses all three. Long-running compute (light culling, GPU particle simulation, BVH refit) goes on the async compute queue and overlaps with the graphics queue. Texture uploads and buffer copies go on the transfer queue. The graphics queue stays focused on draw calls.

### Command Buffers

In Vulkan, every GPU operation is recorded into a `VkCommandBuffer` allocated from a `VkCommandPool`. Command pools are not thread-safe. Each thread that records commands needs its own pool.

```cpp
VkCommandPool make_pool(VkDevice device, uint32_t family) {
    VkCommandPoolCreateInfo info{
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
        .queueFamilyIndex = family,
    };
    VkCommandPool pool;
    vkCreateCommandPool(device, &info, nullptr, &pool);
    return pool;
}

VkCommandBuffer record_clear(VkDevice device, VkCommandPool pool,
                             VkImage image) {
    VkCommandBufferAllocateInfo ainfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = pool,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1,
    };
    VkCommandBuffer cb;
    vkAllocateCommandBuffers(device, &ainfo, &cb);

    VkCommandBufferBeginInfo binfo{
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO,
        .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT,
    };
    vkBeginCommandBuffer(cb, &binfo);

    VkClearColorValue color{ .float32 = { 0.1f, 0.2f, 0.3f, 1.0f } };
    VkImageSubresourceRange range{
        .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
        .levelCount = 1,
        .layerCount = 1,
    };
    vkCmdClearColorImage(cb, image, VK_IMAGE_LAYOUT_GENERAL,
                         &color, 1, &range);
    vkEndCommandBuffer(cb);
    return cb;
}
```

Primary command buffers are submitted to queues. Secondary command buffers are recorded inside a render pass and called from primary command buffers. Secondary command buffers exist for parallel render-pass recording: thread 1 records the first half of a render pass into a secondary, thread 2 records the second half, and the primary executes both with `vkCmdExecuteCommands`.

### Render Passes and Dynamic Rendering

A `VkRenderPass` describes the attachments (color, depth, stencil), the subpasses that read and write them, and the dependencies between subpasses. The driver uses this information on tile-based GPUs to keep attachment data in tile memory across subpasses.

```cpp
VkAttachmentDescription color{
    .format = VK_FORMAT_B8G8R8A8_SRGB,
    .samples = VK_SAMPLE_COUNT_1_BIT,
    .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
    .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
    .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
    .finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
};
VkAttachmentReference color_ref{ 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
VkSubpassDescription sub{
    .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
    .colorAttachmentCount = 1,
    .pColorAttachments = &color_ref,
};
VkRenderPassCreateInfo rpci{
    .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
    .attachmentCount = 1,
    .pAttachments = &color,
    .subpassCount = 1,
    .pSubpasses = &sub,
};
```

Vulkan 1.3 introduced **dynamic rendering** (`VK_KHR_dynamic_rendering`), which removes the need for `VkRenderPass` and `VkFramebuffer` objects on most code paths. You begin rendering with `vkCmdBeginRendering` and pass attachment info inline. This is the modern style and the one Khronos recommends for new code on desktop GPUs.

```cpp
VkRenderingAttachmentInfo color_att{
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO,
    .imageView = view,
    .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
    .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
    .clearValue = { .color = { 0.1f, 0.2f, 0.3f, 1.0f } },
};
VkRenderingInfo ri{
    .sType = VK_STRUCTURE_TYPE_RENDERING_INFO,
    .renderArea = { {0,0}, {width, height} },
    .layerCount = 1,
    .colorAttachmentCount = 1,
    .pColorAttachments = &color_att,
};
vkCmdBeginRendering(cb, &ri);
// draw calls
vkCmdEndRendering(cb);
```

On tile-based GPUs (mobile, Apple via MoltenVK), legacy render passes still beat dynamic rendering for performance because the explicit subpass dependencies let the driver keep data on-tile. On desktop, the difference is negligible.

### Pipelines

A `VkPipeline` is a frozen, fully compiled state object. It bundles shader stages, vertex input layout, rasterization state, blend state, depth/stencil state, and the descriptor set layouts. Pipeline creation can take milliseconds and triggers shader compilation. You always create pipelines at load time, never per-frame, and you cache them on disk via `VkPipelineCache`.

```cpp
VkPipelineShaderStageCreateInfo stages[2] = {
    { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
      .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vs, .pName = "main" },
    { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
      .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fs, .pName = "main" },
};
// ... vertex input, input assembly, viewport, raster, multisample, blend ...
VkGraphicsPipelineCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
    .stageCount = 2, .pStages = stages,
    // ...
    .layout = pipeline_layout,
    .renderPass = render_pass,
};
VkPipeline pipeline;
vkCreateGraphicsPipelines(device, cache, 1, &info, nullptr, &pipeline);
```

### Descriptor Sets

A descriptor set is a bag of resource bindings: textures, buffers, samplers. The shader references them by `(set, binding)`. The application creates a `VkDescriptorSetLayout` describing the bindings, allocates sets from a `VkDescriptorPool`, writes resources into them with `vkUpdateDescriptorSets`, and binds them to a command buffer with `vkCmdBindDescriptorSets`.

```cpp
VkDescriptorSetLayoutBinding bindings[2] = {
    { 0, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, 1, VK_SHADER_STAGE_VERTEX_BIT },
    { 1, VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER, 1,
      VK_SHADER_STAGE_FRAGMENT_BIT },
};
VkDescriptorSetLayoutCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
    .bindingCount = 2, .pBindings = bindings,
};
VkDescriptorSetLayout layout;
vkCreateDescriptorSetLayout(device, &info, nullptr, &layout);
```

Modern renderers do not bind descriptor sets per-draw. They bind a few large sets once per frame containing all resources, and the shader indexes into them by ID passed via push constants. This is bindless rendering, covered in section 08.

### The Big Picture

A frame in Vulkan looks like this.

1. Wait on the previous frame's fence.
2. Acquire a swapchain image.
3. Record one or more command buffers across worker threads.
4. Submit them to the graphics queue, signaling a semaphore on completion.
5. Present the swapchain image, waiting on the same semaphore.

Everything else, descriptor management, pipeline caching, memory allocation, synchronization, is in service of making that loop run in 8 milliseconds.

---
