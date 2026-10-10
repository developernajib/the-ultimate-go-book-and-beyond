## Color Pipeline and HDR

A renderer's color pipeline is the chain from authored asset values to pixels on the display. Get it wrong and the game looks washed-out, oversaturated, or wrong on HDR displays. Most renderers handle this incorrectly to some degree. Senior engineers at the top studios spend serious time getting it right.

### Color Spaces

A color space is three things: a set of three primaries (the chromaticity of pure red, green, blue), a white point (what RGB = 1, 1, 1 means), and a transfer function (the gamma).

The relevant ones for graphics:

| Space | Primaries | White | Transfer |
|---|---|---|---|
| sRGB | sRGB / Rec.709 | D65 | sRGB curve (~2.2) |
| Linear (scene-referred) | Rec.709 or Rec.2020 | D65 | linear (1.0) |
| Display P3 | DCI-P3 | D65 | sRGB curve |
| BT.2020 | wide gamut | D65 | linear or PQ or HLG |
| scRGB | sRGB primaries | D65 | linear, extended range |
| ACEScg | ACES AP1 | D60 | linear |

The mistake almost every junior makes: shading in sRGB. The textures are sRGB-encoded, the shader treats them as linear, lighting is computed wrong (the gamma curve compresses values non-linearly), the output is non-physical.

### The Correct Pipeline

For an SDR renderer:

1. Author textures in sRGB.
2. Sample them as `_SRGB` formats. The hardware automatically converts to linear on read.
3. Shade in linear space. Lighting math is physically correct.
4. Tone-map the linear HDR result down to displayable range.
5. Encode to sRGB on write to swapchain (use `VK_FORMAT_B8G8R8A8_SRGB`).

```hlsl
// Texture is _SRGB format, hardware does sRGB to linear on sample
Texture2D albedo : register(t0);
SamplerState s;

float4 PSMain(VOut in) : SV_Target {
    float3 albedo_linear = albedo.Sample(s, in.uv).rgb;
    float3 lit = compute_lighting(albedo_linear, ...);  // linear
    float3 tonemapped = tonemap(lit);                   // still linear
    return float4(tonemapped, 1);                       // hardware encodes to sRGB
}
```

Two crucial details:

- Albedo and color textures: sRGB format on disk and at sample time.
- Normal maps, roughness maps, masks: linear (UNORM, not SRGB), they encode data not color.

### Tonemapping

Linear HDR scene values can be 0 to 100,000 (a sun reflection in metal). The display can show 0 to 1 (SDR) or 0 to 10,000 nits (HDR). Tonemapping compresses the HDR range into the display range while preserving perceptual contrast.

Reinhard (the simplest):

```hlsl
float3 reinhard(float3 x) { return x / (1.0 + x); }
```

Maps 0 to 1 perfectly, infinity to 1. Crushes highlights. Simple and shippable for prototypes.

Hable (Uncharted 2's tonemap):

```hlsl
float3 hable(float3 x) {
    const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
    return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;
}
```

ACES (the film industry standard, used by Unreal and Unity):

```hlsl
// ACES filmic approximation by Krzysztof Narkowicz
float3 aces(float3 x) {
    const float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    return saturate((x*(a*x+b))/(x*(c*x+d)+e));
}
```

ACES is the modern default for AAA. It is a curve fit to the more expensive ACES Reference Rendering Transform, accurate enough for real-time.

### ACES Pipeline

Full ACES has four stages:

1. **Input Device Transform (IDT)**: input space to ACES.
2. **Look Modification Transform (LMT)**: artistic look (the "color grade").
3. **Reference Rendering Transform (RRT)**: ACES to display-independent intermediate.
4. **Output Device Transform (ODT)**: display-independent to specific display (sRGB, BT.2020 HDR10, P3 DCI).

In real-time renderers, IDT is "treat scene-linear as ACES AP1", LMT is the artist's grading LUT, RRT+ODT is fused into a single tonemap function or a 3D LUT.

```hlsl
float3 apply_grade(float3 x, Texture3D lut) {
    float3 uv = x / (x + 1.0);  // log-like
    return lut.SampleLevel(s_linear, uv, 0).rgb;
}
```

The 3D LUT (typically 33x33x33) is the artist's interface. The artist tweaks it in DaVinci Resolve, exports as `.cube`, the engine bakes it into a 3D texture.

### HDR Output

HDR displays accept extended-range signals. The scRGB convention: sRGB primaries, linear, values from 0 to ~125 (mapped to 0 to 10,000 nits). HDR10: BT.2020 primaries, PQ transfer (perceptual quantizer), 10-bit per channel.

To output HDR10:

1. Create the swapchain with `DXGI_FORMAT_R10G10B10A2_UNORM` or `VK_FORMAT_A2B10G10R10_UNORM_PACK32`.
2. Set color space to `DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020` (D3D12) or `VK_COLOR_SPACE_HDR10_ST2084_EXT` (Vulkan).
3. Tone-map to 0 to 10,000 nits range, not 0 to 1.
4. Convert from linear BT.709 (or AP1) to BT.2020 primaries via a 3x3 matrix.
5. Apply PQ encoding.

```hlsl
// PQ (SMPTE ST.2084) encoding
float3 pq_encode(float3 nits) {
    const float m1 = 2610.0 / 16384.0;
    const float m2 = 2523.0 / 32.0;
    const float c1 = 3424.0 / 4096.0;
    const float c2 = 2413.0 / 128.0;
    const float c3 = 2392.0 / 128.0;
    float3 y = saturate(nits / 10000.0);
    float3 ym = pow(y, m1);
    return pow((c1 + c2 * ym) / (1.0 + c3 * ym), m2);
}

// BT.709 to BT.2020 matrix
static const float3x3 bt709_to_bt2020 = {
    0.6274, 0.3293, 0.0433,
    0.0691, 0.9195, 0.0114,
    0.0164, 0.0880, 0.8956,
};

float4 PSMain(VOut in) : SV_Target {
    float3 hdr_linear = scene.Sample(s, in.uv).rgb;  // 0 to ~100 in nits scaled
    float3 nits = aces_hdr_tonemap(hdr_linear);       // 0 to 4000 (typical)
    float3 bt2020 = mul(bt709_to_bt2020, nits);
    float3 pq = pq_encode(bt2020);
    return float4(pq, 1);
}
```

### Dolby Vision and HDR10+

Dolby Vision is dynamic-metadata HDR: per-frame or per-scene metadata describes the brightness range, the display tone-maps with that information. Quality is higher than static HDR10 but the pipeline is licensed and proprietary. Games on consoles support it. PC support is limited.

HDR10+ is the open dynamic-metadata equivalent. Limited adoption.

### Wide Color Gamut

Display P3 is the iPhone, iPad, MacBook display gamut, ~25 percent wider than sRGB. Outputting sRGB on a P3 display gives correct (slightly muted) results. Authoring in P3 requires a P3-aware pipeline: textures encoded in P3, shaders aware of the broader gamut, the swapchain configured for P3 output (`DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P3D65`).

For most cross-platform games, render in BT.2020 or wider linear, output in either sRGB (SDR) or HDR10 / scRGB (HDR), with P3 output as a possible variant on Apple platforms.

### Monitor Calibration

Even the best pipeline produces wrong output on a miscalibrated display. The OS-level color management (Windows ICC profiles, macOS ColorSync) handles this if it is present. Games often bypass OS color management for performance and consistency, which means they ship a calibration tool ("adjust this grayscale to match", "raise this slider until the icon disappears") to correct for display variance.

For HDR specifically, displays vary in peak brightness (300 to 4000 nits), local dimming, and tone-mapping. Games usually expose:

- Maximum luminance slider (matching the display's actual peak).
- Paper white slider (the "SDR-equivalent white" in HDR, typically 200 nits).
- HDR/SDR toggle.

### Junior to FAANG

A junior renders in sRGB space, applies Reinhard tonemap, outputs to sRGB swapchain, and the lighting is wrong everywhere but it sort of looks okay so it ships. A senior at Pixar or Industrial Light & Magic implements the full ACES pipeline with proper LMT support, calibrates against a reference monitor, ships HDR10 output with correct PQ encoding, and the same content looks right on a \$200 monitor and a \$25,000 reference display.

---
