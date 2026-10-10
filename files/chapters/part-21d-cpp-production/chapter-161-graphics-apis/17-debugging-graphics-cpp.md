## Debugging Graphics C++

Graphics bugs are the worst kind of bugs. The CPU code looks fine, the validation layer says nothing, the GPU produces garbage or hangs the system. This section covers the tools and techniques that turn unknowable graphics bugs into debuggable ones.

### RenderDoc

RenderDoc (Baldur Karlsson, originally at Crytek, now at Valve) is the open-source frame debugger every graphics programmer uses. It captures a frame, replays it on the GPU, and lets you step through every command, inspect every resource at every point, and re-run any draw with modified state.

Captures work on Vulkan, D3D11, D3D12, OpenGL, OpenGL ES. RenderDoc is the first tool you reach for when "the screen is black" or "this triangle is missing".

What RenderDoc shows:

- The full event tree of the frame, every API call.
- Per-event resource state. The contents of every render target, depth buffer, texture, vertex buffer, uniform buffer, descriptor set.
- Pixel history: for any pixel, what writes touched it and in what order.
- Shader debugging: step through a vertex or fragment shader for a specific invocation, watch values at each instruction.
- Mesh viewer: vertex input, post-VS positions, post-clipping triangles.
- Pipeline state at every draw, fully expanded (root signature, descriptor sets, samplers, blend, rasterizer).

When you have a bug, capture, find the broken pixel, click "history". RenderDoc shows you every fragment that wrote that pixel. Usually one of them is wrong, and clicking it takes you to the draw call that issued it.

### PIX for Windows

Microsoft's D3D12 frame analyzer. Three modes:

1. **Timing capture**: per-event timing without replay. Lightweight.
2. **GPU capture**: full frame with replay, like RenderDoc but D3D12 only.
3. **Memory capture**: tracks allocations, residency, descriptor heap pressure.

PIX has a few features RenderDoc lacks: full root signature view including bind values, shader instruction-level cycle counts on AMD and NVIDIA, GPU-based validation integration showing exactly which draw triggered which GBV error.

PIX is required for D3D12 production debugging. RenderDoc is required for Vulkan. Most engineers use both.

### Xcode GPU Frame Capture

Apple's Metal frame analyzer. Built into Xcode (Cmd+Shift+M during debugging or via the running-app overlay). Shows:

- Per-encoder timeline with GPU time.
- Per-draw resource state.
- Tile memory usage and bandwidth.
- Counter sample buffers if instrumented.
- Texture and buffer contents.
- Shader debugging via the Metal source debugger.

Apple's profiler is uniquely good at tile-based GPU diagnostics. The "Show Tile Memory" view shows how much tile memory each render encoder uses and whether attachments are being correctly retained on-tile across subpasses.

### Validation Layers

The validation layer (Khronos for Vulkan, the D3D12 debug layer for D3D12) is your first line of defense. It catches API misuse: invalid parameters, wrong handle types, missing barriers, descriptor binding errors.

```cpp
// Vulkan: enable VK_LAYER_KHRONOS_validation
// Configure via VkValidationFeaturesEXT to enable specific checks:
VkValidationFeaturesEXT vfeatures{
    .sType = VK_STRUCTURE_TYPE_VALIDATION_FEATURES_EXT,
};
VkValidationFeatureEnableEXT enables[] = {
    VK_VALIDATION_FEATURE_ENABLE_GPU_ASSISTED_EXT,
    VK_VALIDATION_FEATURE_ENABLE_BEST_PRACTICES_EXT,
    VK_VALIDATION_FEATURE_ENABLE_SYNCHRONIZATION_VALIDATION_EXT,
};
vfeatures.enabledValidationFeatureCount = 3;
vfeatures.pEnabledValidationFeatures = enables;
```

Best-practices validation catches sub-optimal patterns: redundant barriers, suboptimal layout transitions, descriptor over-allocation. It is per-vendor (NVIDIA, AMD, ARM, Intel best-practices each).

GPU-assisted validation rebuilds shaders with bounds checks and validates resource access at GPU runtime. Catches:

- Out-of-bounds reads/writes in storage buffers.
- Out-of-bounds descriptor indexing (bindless).
- Use of unbound descriptors.
- Mismatched format access.

Costs 5x to 20x in frame time. Run during bringup, not always.

### Breadcrumbs and DRED

When the GPU hangs hard, validation cannot help. The driver TDRs (timeout detection and recovery), Windows recreates the device, and you are left with nothing but "device removed".

Breadcrumbs solve this. The application writes a known value to a host-visible buffer at the start of each draw. If the GPU hangs, the buffer's last written value tells you which draw was running.

D3D12's DRED (Device Removed Extended Data) does this automatically. Enable it at startup:

```cpp
ComPtr<ID3D12DeviceRemovedExtendedDataSettings1> dred;
D3D12GetDebugInterface(IID_PPV_ARGS(&dred));
dred->SetAutoBreadcrumbsEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);
dred->SetPageFaultEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);
```

After a TDR, query the data:

```cpp
HRESULT hr = device->GetDeviceRemovedReason();
if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_HUNG) {
    ComPtr<ID3D12DeviceRemovedExtendedData2> data;
    device->QueryInterface(IID_PPV_ARGS(&data));

    D3D12_DRED_AUTO_BREADCRUMBS_OUTPUT1 ab{};
    data->GetAutoBreadcrumbsOutput1(&ab);
    for (auto* node = ab.pHeadAutoBreadcrumbNode; node; node = node->pNext) {
        printf("List '%S' at op %u of %u: %s\n",
               node->pCommandListDebugNameW,
               *node->pLastBreadcrumbValue,
               node->BreadcrumbCount,
               op_name(node->pCommandHistory[*node->pLastBreadcrumbValue]));
    }

    D3D12_DRED_PAGE_FAULT_OUTPUT2 pf{};
    data->GetPageFaultAllocationOutput2(&pf);
    printf("Page fault at GPU address 0x%llx\n", pf.PageFaultVA);
}
```

This survives the TDR. Your error reporter can ship this to your telemetry, and you know exactly which draw call hung in your customer's GPU.

NVIDIA exposes equivalent breadcrumb data on Vulkan via `VK_NV_device_diagnostic_checkpoints`. AMD has `VK_AMD_buffer_marker`.

### Manual Breadcrumbs

For finer granularity than automatic, write breadcrumbs yourself.

```cpp
class BreadcrumbBuffer {
    VkBuffer buffer_;
    uint32_t* mapped_;
    uint32_t next_id_ = 0;
    std::vector<std::string> tags_;

public:
    uint32_t mark(VkCommandBuffer cb, std::string tag) {
        uint32_t id = next_id_++;
        tags_.push_back(std::move(tag));
        // Write 'id' into mapped_[0] via host-visible buffer
        vkCmdFillBuffer(cb, buffer_, 0, sizeof(uint32_t), id);
        // Or: vkCmdWriteBufferMarkerAMD on AMD
        return id;
    }

    void on_hang() {
        uint32_t last = mapped_[0];
        printf("hang after breadcrumb %u: %s\n", last, tags_[last].c_str());
    }
};
```

Mark before each major pass, before complex compute, around suspect operations.

### Shader Printf

Vulkan supports printf in shaders via `VK_KHR_shader_non_semantic_info` plus the validation layer's `debugPrintfEXT`. Enable it in the validation layer config and use:

```glsl
#extension GL_EXT_debug_printf : enable
void main() {
    debugPrintfEXT("vertex %u pos = %v3f", gl_VertexIndex, vertex.pos);
}
```

The output goes to the validation layer's debug callback. Slow as molasses (5x to 50x frame time) but invaluable for "what does this shader actually compute".

D3D12 supports printf via PIX with `printf` in HLSL when Shader Model 6.6+ is targeted.

### Aftermath

NVIDIA Aftermath is a library for crash diagnostics on NVIDIA GPUs. Integrate the SDK into your app, and on a GPU crash it produces a `.nv-gpudmp` file with the failing shader, register values, last GPU instructions, and a callstack from your auto-marker history.

Aftermath catches:

- Page faults: GPU dereferenced an invalid pointer.
- Memory access errors: out-of-bounds in shaders.
- Hang timeouts: which shader was looping.

Ship Aftermath in production with crash uploads. When a customer reports a GPU crash, you get the dump and can replay it.

### Common Bug Patterns

**Black screen, no errors**: depth state misconfiguration. Reverse-Z but writing 1.0 cleared. Check depth clear value, depth compare op.

**Some triangles missing**: face culling wrong winding, or backface culling on. Verify `frontFace` matches your convention.

**Flickering pixels**: missing barrier between consecutive passes that read each other. Sync validation will catch.

**Random corruption every N frames**: descriptor set lifetime bug. Set freed while in flight. Use `UPDATE_AFTER_BIND` and never recycle descriptor sets across frames.

**Crash on `vkQueueSubmit`**: command buffer was reset while in flight. Wait on the per-frame fence first.

**GPU hang in compute**: infinite loop in shader, often from a `while` that never converges. Add a max iteration count.

**Hang only on AMD**: GCN/RDNA has different scheduler. Probably a missing barrier that NVIDIA hides via wider OoO. Run sync validation, fix the barrier.

### Junior to FAANG

A junior debugs a black screen by adding `printf` to the application code, sees nothing wrong, gives up and rewrites the renderer. A senior captures the frame in RenderDoc, sees that `Draw` event 47 has the right vertex buffer but wrong root constants because the bind happened on the wrong command list, fixes it in 3 minutes.

---
