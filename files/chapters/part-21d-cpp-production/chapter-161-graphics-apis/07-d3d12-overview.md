## D3D12 Overview

Direct3D 12 is Microsoft's explicit graphics API, the successor to D3D11. Like Vulkan, it exposes the GPU at the level the driver actually operates on. Unlike Vulkan, it ships only on Windows and Xbox, and has tight integration with the Windows display stack and the Xbox console runtime.

D3D12 is a COM API. Every interface inherits from `ID3D12Object` which inherits from `IUnknown`. You manage object lifetimes with `Microsoft::WRL::ComPtr<T>` (a smart pointer that calls `AddRef` / `Release`).

### Device Creation

```cpp
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
using Microsoft::WRL::ComPtr;

ComPtr<ID3D12Device12> create_device() {
    ComPtr<IDXGIFactory7> factory;
    CreateDXGIFactory2(DXGI_CREATE_FACTORY_DEBUG, IID_PPV_ARGS(&factory));

    ComPtr<IDXGIAdapter4> adapter;
    factory->EnumAdapterByGpuPreference(
        0, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE, IID_PPV_ARGS(&adapter));

    ComPtr<ID3D12Device12> device;
    D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_12_2,
                     IID_PPV_ARGS(&device));

    // Enable the debug layer
    ComPtr<ID3D12Debug6> debug;
    if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
        debug->EnableDebugLayer();
        debug->SetEnableGPUBasedValidation(TRUE);
    }
    return device;
}
```

Feature level 12_2 corresponds to DirectX 12 Ultimate, which mandates ray tracing tier 1.1, mesh shaders, variable rate shading tier 2, and sampler feedback. Hardware that ships this is RTX 20 series and later, RX 6000 series and later, Arc, and Xbox Series X/S.

### Command Queue, Allocator, List

D3D12's command model has three objects where Vulkan has two.

- `ID3D12CommandQueue`: like a Vulkan queue. Submits work.
- `ID3D12CommandAllocator`: backing memory for command lists. Like a Vulkan command pool.
- `ID3D12GraphicsCommandList`: the recorded commands. Like a Vulkan command buffer.

```cpp
D3D12_COMMAND_QUEUE_DESC qdesc{
    .Type = D3D12_COMMAND_LIST_TYPE_DIRECT,
    .Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL,
    .Flags = D3D12_COMMAND_QUEUE_FLAG_NONE,
};
ComPtr<ID3D12CommandQueue> queue;
device->CreateCommandQueue(&qdesc, IID_PPV_ARGS(&queue));

ComPtr<ID3D12CommandAllocator> allocator;
device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                              IID_PPV_ARGS(&allocator));

ComPtr<ID3D12GraphicsCommandList9> cmd;
device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT,
                         allocator.Get(), nullptr, IID_PPV_ARGS(&cmd));
cmd->Close();  // Created in recording state, close it for now
```

Three queue types correspond to three queue families in Vulkan:

- `DIRECT`: graphics, compute, copy. Like Vulkan's universal queue.
- `COMPUTE`: async compute. Runs on the GPU's compute scheduler.
- `COPY`: DMA engine. Host-to-device, device-to-device, async.

There are also `BUNDLE`, `VIDEO_DECODE`, `VIDEO_PROCESS`, and `VIDEO_ENCODE` types.

### Root Signature

The root signature is D3D12's analogue of Vulkan's pipeline layout, but stricter and more performance-sensitive. It declares the layout of resource bindings the shader will see.

```cpp
CD3DX12_ROOT_PARAMETER1 params[3];
params[0].InitAsConstantBufferView(0);  // root CBV at b0
params[1].InitAsDescriptorTable(1, &range);  // table of SRVs
params[2].InitAsConstants(4, 1);  // 4 root constants at b1

CD3DX12_VERSIONED_ROOT_SIGNATURE_DESC desc;
desc.Init_1_1(_countof(params), params, 0, nullptr,
             D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT);

ComPtr<ID3DBlob> blob;
ComPtr<ID3DBlob> err;
D3DX12SerializeVersionedRootSignature(&desc,
    D3D_ROOT_SIGNATURE_VERSION_1_1, &blob, &err);

ComPtr<ID3D12RootSignature> rs;
device->CreateRootSignature(0, blob->GetBufferPointer(),
                           blob->GetBufferSize(), IID_PPV_ARGS(&rs));
```

Root parameters come in three flavors:

1. **Root constants**: 32-bit values inlined into the command buffer. Up to 64 DWORDs total. Fastest binding.
2. **Root descriptors** (CBV/SRV/UAV): a single resource pointer inlined into the root signature. One indirection.
3. **Descriptor tables**: a pointer into a descriptor heap. One indirection plus a heap lookup.

The root signature has a 64-DWORD budget across all parameters. Root constants cost 1 DWORD each, root descriptors cost 2, descriptor tables cost 1. Going over the budget spills the root signature to a hidden buffer, costing performance. A senior D3D12 programmer designs the root signature carefully and uses `D3D12_ROOT_SIGNATURE_FLAGS` like `DENY_VERTEX_SHADER_ROOT_ACCESS` to free up budget.

### Descriptor Heaps

D3D12 has two GPU-visible descriptor heap types: `CBV_SRV_UAV` and `SAMPLER`. The application creates them, places descriptors into them, and the root signature's descriptor tables index into them.

```cpp
D3D12_DESCRIPTOR_HEAP_DESC hd{
    .Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV,
    .NumDescriptors = 1024,
    .Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE,
};
ComPtr<ID3D12DescriptorHeap> heap;
device->CreateDescriptorHeap(&hd, IID_PPV_ARGS(&heap));

UINT inc = device->GetDescriptorHandleIncrementSize(
    D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
D3D12_CPU_DESCRIPTOR_HANDLE cpu = heap->GetCPUDescriptorHandleForHeapStart();
D3D12_GPU_DESCRIPTOR_HANDLE gpu = heap->GetGPUDescriptorHandleForHeapStart();

D3D12_SHADER_RESOURCE_VIEW_DESC srv{
    .Format = DXGI_FORMAT_R8G8B8A8_UNORM,
    .ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D,
    .Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING,
    .Texture2D = { .MipLevels = 1 },
};
device->CreateShaderResourceView(texture, &srv, cpu);
```

You can only have one CBV/SRV/UAV heap and one sampler heap bound at a time. This drives the bindless model: one giant heap with all resources, indexed by ID. NVIDIA hardware handles up to 1,000,000 descriptors per heap on D3D12. AMD allows similar.

### Resource States and Barriers

Every D3D12 resource is in a state. Common states: `COMMON`, `RENDER_TARGET`, `DEPTH_WRITE`, `PIXEL_SHADER_RESOURCE`, `UNORDERED_ACCESS`, `COPY_DEST`, `COPY_SOURCE`, `PRESENT`. Transitions are explicit.

```cpp
D3D12_RESOURCE_BARRIER barrier{
    .Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
    .Flags = D3D12_RESOURCE_BARRIER_FLAG_NONE,
    .Transition = {
        .pResource = backbuffer,
        .Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
        .StateBefore = D3D12_RESOURCE_STATE_PRESENT,
        .StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET,
    },
};
cmd->ResourceBarrier(1, &barrier);
```

D3D12 1.7 introduced **enhanced barriers** which split execution and access dependencies (like Vulkan synchronization2). They are more efficient and easier to reason about.

```cpp
D3D12_TEXTURE_BARRIER tb{
    .SyncBefore = D3D12_BARRIER_SYNC_NONE,
    .SyncAfter = D3D12_BARRIER_SYNC_RENDER_TARGET,
    .AccessBefore = D3D12_BARRIER_ACCESS_NO_ACCESS,
    .AccessAfter = D3D12_BARRIER_ACCESS_RENDER_TARGET,
    .LayoutBefore = D3D12_BARRIER_LAYOUT_PRESENT,
    .LayoutAfter = D3D12_BARRIER_LAYOUT_RENDER_TARGET,
    .pResource = backbuffer,
    .Subresources = { 0, 1, 0, 1, 0, 1 },
};
D3D12_BARRIER_GROUP bg{ .Type = D3D12_BARRIER_TYPE_TEXTURE,
                       .NumBarriers = 1, .pTextureBarriers = &tb };
cmd7->Barrier(1, &bg);
```

Use enhanced barriers for new code.

### GPU-Based Validation

`SetEnableGPUBasedValidation(TRUE)` rebuilds shaders with bounds checks, validates resource state transitions on the GPU, and catches descriptor mismatches. It costs 5x to 20x in frame time and finds bugs that the standard debug layer cannot. Run it during bringup of new render passes, not on every build.

### DRED: Device Removed Extended Data

When the GPU TDRs (resets due to a hang), DRED captures the auto-breadcrumbs and page fault context.

```cpp
ComPtr<ID3D12DeviceRemovedExtendedDataSettings1> dred;
D3D12GetDebugInterface(IID_PPV_ARGS(&dred));
dred->SetAutoBreadcrumbsEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);
dred->SetPageFaultEnablement(D3D12_DRED_ENABLEMENT_FORCED_ON);

// On TDR, after device removal
ComPtr<ID3D12DeviceRemovedExtendedData2> data;
device->QueryInterface(IID_PPV_ARGS(&data));
D3D12_DRED_AUTO_BREADCRUMBS_OUTPUT1 out;
data->GetAutoBreadcrumbsOutput1(&out);
// Walk out.pHeadAutoBreadcrumbNode to find the failing op
```

Auto-breadcrumbs let you find the exact `Draw` call or `Dispatch` that hung the GPU. Without DRED you get "GPU device removed" with no further information. DRED is the single most important production tool for shipping D3D12 applications.

### Work Graphs

D3D12 1.8 (DirectX 12 Ultimate update, 2024) added work graphs. A work graph is a GPU-driven dispatch model where shaders launch other shaders without CPU round trips. The classic example is a particle system where collision shaders spawn debris shaders which spawn smoke shaders, all on the GPU, with the scheduler picking up nodes as inputs become available.

```hlsl
[Shader("node")]
[NodeLaunch("broadcasting")]
[NumThreads(64, 1, 1)]
[NodeDispatchGrid(1, 1, 1)]
void cull_node(
    DispatchNodeInputRecord<CullInput> in,
    [MaxRecords(64)] NodeOutput<DrawRecord> draws) {
    if (visible(in.Get())) {
        ThreadNodeOutputRecords<DrawRecord> r = draws.GetThreadNodeOutputRecords(1);
        r.Get().instance = in.Get().instance;
        r.OutputComplete();
    }
}
```

This replaces the previous indirect-dispatch chains with a programmable scheduler. NVIDIA Ada and AMD RDNA 3 have hardware support. Use cases: GPU culling pipelines, deferred-shading material classification, hierarchical scene processing.

### Junior to FAANG

A junior writes a D3D12 renderer with one descriptor heap rebuilt per draw, a 32-DWORD root signature with everything as a descriptor table, no DRED, and ships an app that hangs in customer environments with "GPU device removed" reports they cannot diagnose. A senior at Microsoft's DirectX team designs a 12-DWORD root signature with hot constants as root constants, uses one persistent SRV heap with bindless indexing, ships with DRED enabled, and when a customer reports a hang the breadcrumb tells them exactly which compute dispatch in which frame failed.

---
