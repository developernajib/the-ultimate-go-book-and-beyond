## Shaders and SPIR-V

GPU programs are shaders. Three high-level languages cover everything: HLSL for D3D12 and (via dxc) Vulkan, GLSL for Vulkan and OpenGL, MSL for Metal. The runtime intermediate is SPIR-V on Vulkan and DXIL on D3D12.

### HLSL

HLSL (High-Level Shading Language) is Microsoft's C-derived shader language. It is the dominant authoring language. Unreal, Unity, Frostbite, id Tech, and most studios author in HLSL and cross-compile to other targets when needed.

```hlsl
struct VIn { float3 pos : POSITION; float3 normal : NORMAL; float2 uv : TEXCOORD; };
struct VOut { float4 svpos : SV_Position; float3 normal : NORMAL; float2 uv : TEXCOORD; };

cbuffer Frame : register(b0) {
    float4x4 view_proj;
    float4x4 world;
};

VOut VSMain(VIn v) {
    VOut o;
    o.svpos = mul(view_proj, mul(world, float4(v.pos, 1.0)));
    o.normal = mul((float3x3)world, v.normal);
    o.uv = v.uv;
    return o;
}

Texture2D albedo : register(t0);
SamplerState samp : register(s0);

float4 PSMain(VOut i) : SV_Target {
    float3 N = normalize(i.normal);
    float NdotL = saturate(dot(N, normalize(float3(0.5, 1.0, 0.3))));
    return albedo.Sample(samp, i.uv) * (NdotL + 0.1);
}
```

HLSL Shader Model versions:

- SM 6.0: wave intrinsics (`WaveActiveSum`, `WaveReadLaneAt`).
- SM 6.5: ray query, mesh and amplification shaders.
- SM 6.6: dynamic resources (`ResourceDescriptorHeap`), 8-bit packed types, atomic float ops.
- SM 6.7: advanced texture ops, raytracing tier 1.1.
- SM 6.8: work graphs, expanded comparison sampling.

### DXC and DXIL

`dxc` is the open-source HLSL compiler. It produces DXIL (DirectX Intermediate Language) for D3D12 and SPIR-V for Vulkan. It replaced the old `fxc` compiler for SM 6.0+.

```bash
# HLSL to DXIL for D3D12
dxc -T ps_6_6 -E PSMain shader.hlsl -Fo shader.cso

# HLSL to SPIR-V for Vulkan
dxc -spirv -fspv-target-env=vulkan1.3 -T ps_6_6 -E PSMain shader.hlsl -Fo shader.spv
```

The `-spirv` flag invokes the SPIR-V backend (originally based on Google's translator). Modern dxc handles wave intrinsics, raytracing, mesh shaders, and bindless heap indexing on both targets.

### GLSL and glslang

GLSL is Khronos's shading language. It is the historical Vulkan default. glslang is the reference compiler that produces SPIR-V from GLSL.

```glsl
#version 460
#extension GL_EXT_nonuniform_qualifier : enable

layout(binding = 0) uniform Frame { mat4 view_proj; mat4 world; };
layout(binding = 1) uniform texture2D textures[];
layout(binding = 2) uniform sampler s;
layout(push_constant) uniform Push { uint tex_id; };

layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 out_color;

void main() {
    out_color = texture(sampler2D(textures[nonuniformEXT(tex_id)], s), uv);
}
```

GLSL is still widely used in Khronos-native pipelines and academic graphics. New production code is increasingly HLSL via dxc, because it gives one source for D3D12 and Vulkan.

### MSL

Metal Shading Language is C++14 with extensions. It is the only option for Metal.

```msl
#include <metal_stdlib>
using namespace metal;

struct VIn { float3 pos [[attribute(0)]]; float3 normal [[attribute(1)]]; };
struct VOut { float4 position [[position]]; float3 normal; };

vertex VOut vs_main(VIn v [[stage_in]],
                    constant float4x4& view_proj [[buffer(1)]]) {
    VOut o;
    o.position = view_proj * float4(v.pos, 1.0);
    o.normal = v.normal;
    return o;
}

fragment float4 fs_main(VOut i [[stage_in]]) {
    return float4(normalize(i.normal) * 0.5 + 0.5, 1.0);
}
```

MSL is conceptually closer to C++ than HLSL or GLSL. It supports templates, function pointers, and limited dynamic dispatch.

### SPIR-V

SPIR-V is the Vulkan binary IR. It is a bytecode format with explicit types, control flow, and capabilities. It is not text, it is a stream of 32-bit words. The `spirv-cross` tool can decompile it to GLSL, HLSL, or MSL.

A SPIR-V module looks like this in disassembly:

```
; SPIR-V Version: 1.6
                 OpCapability Shader
                 OpMemoryModel Logical GLSL450
                 OpEntryPoint Fragment %main "main" %out_color %uv
                 OpExecutionMode %main OriginUpperLeft
         %void = OpTypeVoid
            %3 = OpTypeFunction %void
        %float = OpTypeFloat 32
      %v4float = OpTypeVector %float 4
%_ptr_Output_v4float = OpTypePointer Output %v4float
    %out_color = OpVariable %_ptr_Output_v4float Output
         %main = OpFunction %void None %3
            %5 = OpLabel
                 OpStore %out_color %white
                 OpReturn
                 OpFunctionEnd
```

SPIR-V is designed to be loaded directly by drivers without parsing complex text. Drivers do their own backend compilation (SPIR-V to AMDGPU ISA, SPIR-V to NVIDIA SASS).

### Slang

Slang is a newer shading language from NVIDIA, now hosted at Khronos. It extends HLSL with generics, interfaces, and modules, while still compiling to DXIL, SPIR-V, and (via cross-compilation) MSL.

```slang
interface IMaterial {
    float3 evaluate(float3 N, float3 L);
}

struct Lambert : IMaterial {
    float3 albedo;
    float3 evaluate(float3 N, float3 L) {
        return albedo * max(0, dot(N, L)) / 3.14;
    }
}

float3 shade<M : IMaterial>(M mat, float3 N, float3 L) {
    return mat.evaluate(N, L);
}
```

Slang is the basis of many modern shader codebases that want a single language with proper modules and generics. NVIDIA's Falcor, Microsoft's HLSL future, and academic research papers increasingly use it.

### Pipeline State Compilation

Vulkan pipelines and D3D12 PSOs trigger backend shader compilation when created. This can take 50ms to 500ms per pipeline on first run. With thousands of pipeline variants (one per material x rasterizer state x render target combination), the user experiences a multi-second hitch.

Two mitigations:

**Pipeline cache.** Vulkan's `VkPipelineCache` and D3D12's `ID3D12PipelineLibrary` serialize compiled pipelines to disk. Subsequent runs load the cache and skip compilation.

```cpp
VkPipelineCacheCreateInfo info{
    .sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO,
    .initialDataSize = disk_data.size(),
    .pInitialData = disk_data.data(),
};
VkPipelineCache cache;
vkCreatePipelineCache(device, &info, nullptr, &cache);

// ... create pipelines with this cache ...

size_t size;
vkGetPipelineCacheData(device, cache, &size, nullptr);
std::vector<uint8_t> data(size);
vkGetPipelineCacheData(device, cache, &size, data.data());
write_to_disk(data);
```

**Precompilation at install.** Steam, Epic Games Store, and consoles run a precompile pass at install time that walks all pipelines used in the game and warms the cache. The user never hits a compile stutter at runtime.

### Shader Hot Reload

In development, shader changes recompile and reload while the game runs. Implementation: file watcher on shader source, re-invoke dxc, replace the `VkShaderModule` and recreate dependent pipelines. With a pipeline cache, recompilation of unchanged variants is instant.

```cpp
class ShaderHotReload {
    std::filesystem::file_time_type last_check_;
    std::map<std::string, VkShaderModule> modules_;
public:
    bool check_and_reload(VkDevice device) {
        bool changed = false;
        for (auto& [path, mod] : modules_) {
            auto t = std::filesystem::last_write_time(path);
            if (t > last_check_) {
                auto spv = compile_dxc(path);
                vkDestroyShaderModule(device, mod, nullptr);
                mod = create_module(device, spv);
                changed = true;
            }
        }
        last_check_ = std::filesystem::file_time_type::clock::now();
        return changed;
    }
};
```

### Wave Intrinsics

Modern shaders use wave/subgroup intrinsics for cross-lane operations. These replace ad-hoc shared memory reductions with hardware primitives.

```hlsl
// Sum across the wave (32 or 64 lanes)
float sum = WaveActiveSum(value);

// Read lane 0's value into all lanes
float first = WaveReadLaneFirst(value);

// Prefix sum
uint prefix = WavePrefixSum(count);

// Compact list, write only active lanes
uint mask = WaveActiveBallot(visible).x;
uint slot = WavePrefixCountBits(visible);
if (visible) output[base + slot] = value;
```

Wave intrinsics are essential for high-performance compute, especially particle systems, GPU culling, and ray reconstruction. They map directly to NVIDIA `__shfl_sync`, AMD DPP, and Apple SIMD-group functions.

### Junior to FAANG

A junior recompiles shaders from source every time the game starts and ships with 30-second startup hitches. A senior builds a pipeline cache, ships precompiled caches per GPU vendor, hot-reloads in development, and the artists iterate on shader changes in 200 milliseconds.

---
