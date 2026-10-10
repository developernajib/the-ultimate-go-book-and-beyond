## 159.8 Skia Graphics Pipeline

Skia is the 2D graphics library that draws every pixel in Chrome, ChromeOS, Firefox (for canvas and WebRender's fallback), Android (the Skia HWUI renderer), and Flutter. It lives in `third_party/skia/` in Chromium and as a standalone repo at `skia.org`. Skia is roughly 700,000 lines of C++ and the most-tested open-source 2D library in production.

### API Surface

The core public API has three central types:

- `SkCanvas`: a stateful drawing target. Receives draw calls (`drawRect`, `drawPath`, `drawImage`).
- `SkPaint`: stateless description of how to draw (color, stroke width, blend mode, shader, image filter).
- `SkPath`: a vector path: moveTo, lineTo, curveTo, with fill and stroke options.

Plus auxiliary types:

- `SkSurface`: a destination for drawing (a backbuffer). Hands you a Canvas via `getCanvas()`.
- `SkImage`: an immutable, possibly GPU-resident image.
- `SkPicture`: a recorded sequence of canvas calls. Replayable.
- `SkPictureRecorder`: builds an `SkPicture`.
- `SkColorSpace`: ICC color space, used for color management.

### A Minimal Drawing Example

```cpp
#include "include/core/SkCanvas.h"
#include "include/core/SkPaint.h"
#include "include/core/SkSurface.h"
#include "include/encode/SkPngEncoder.h"

void DrawSomething() {
  sk_sp<SkSurface> surface =
      SkSurface::MakeRasterN32Premul(800, 600);
  SkCanvas* canvas = surface->getCanvas();

  canvas->clear(SK_ColorWHITE);

  SkPaint stroke;
  stroke.setStyle(SkPaint::kStroke_Style);
  stroke.setStrokeWidth(4);
  stroke.setColor(SK_ColorRED);
  stroke.setAntiAlias(true);

  SkPath path;
  path.moveTo(100, 100);
  path.cubicTo(300, 50, 500, 700, 700, 100);

  canvas->drawPath(path, stroke);

  sk_sp<SkImage> image = surface->makeImageSnapshot();
  // image now holds the rendered bytes - encode or upload as needed.
}
```

### Backends

Skia supports many backends. The two that matter for browsers:

- **Raster.** CPU-only. Pixels in main memory. Used for headless and fallbacks.
- **GPU.** Two implementations historically exist:
 - **Ganesh.** The original GPU backend. Wraps OpenGL, Metal, Vulkan, Direct3D, Dawn (WebGPU). Has been the production GPU backend since roughly 2011.
 - **Graphite.** Modern GPU backend. Designed from scratch for modern GPU APIs (Metal, Vulkan, Dawn) without the OpenGL legacy. Records command lists more efficiently, multi-threaded recording. Graphite is used in Flutter and is in the process of replacing Ganesh in Chrome and Android, with rollout staged through 2024 and 2025.

A third (`SkSL`-driven shader) backend exists for WebGPU paths.

### Ganesh in Action

Ganesh maps Skia draw calls to GPU draws. The lifecycle:

```
SkCanvas::drawRect(...)
   |
   v
GrRenderTargetContext::drawRect
   |
   v
GrOp (a recorded "operation")
   |
   v
GrOpsTask (batches GrOps into a render pass)
   |
   v
flushOnce: convert ops to GPU draw calls (glDrawElements, etc.)
```

Ganesh's batching is what makes it fast: many small `drawRect` calls coalesce into one draw with a vertex buffer of N quads. The cost is complexity: Ganesh has three layers of abstraction over the underlying GPU API.

### Graphite Differences

Graphite was started in 2021 because Ganesh's architecture was a bottleneck on modern GPU APIs:

- Ganesh assumed OpenGL state-machine semantics and emulated them on top of Metal and Vulkan.
- Ganesh was single-threaded for command recording.
- Graphite uses a draw-list / command-buffer model that maps directly to Metal MTLRenderCommandEncoder, Vulkan VkCommandBuffer, and Dawn render passes.
- Graphite lets you record draws on multiple threads, then submit on a single thread.

Graphite shipped first in Flutter on macOS and iOS. Chrome uses it for some platforms with rollout proceeding through 2024 and 2025. The API surface for embedders is mostly the same (`SkCanvas`, `SkPaint`), but the context type changes from `GrDirectContext` to `skgpu::graphite::Context`.

### Picture Recording and Display Lists

Blink does not call Ganesh directly during paint. Instead, paint records into an `SkPictureRecorder`:

```cpp
SkPictureRecorder recorder;
SkCanvas* recording = recorder.beginRecording(width, height);

// Blink walks its display list, calling draw operations:
for (const auto& item : display_list) {
  item.Apply(recording);
}

sk_sp<SkPicture> picture = recorder.finishRecordingAsPicture();
```

The picture is then handed to the compositor (`cc/`), which decides which tiles need rasterization and replays the picture into per-tile GPU surfaces on a worker thread.

The separation is important: paint recording is fast (memory only). Rasterization is the expensive GPU step. Decoupling them lets the compositor parallelize raster across cores.

### Text Rendering

Skia uses HarfBuzz for text shaping. Typeface and glyph caching live in Skia. The path:

```
Unicode text  ->  HarfBuzz shaping (with the font's GSUB/GPOS tables)
                  -> sequence of glyph IDs and positions
                  -> Skia glyph cache lookup
                  -> rasterize glyph if not cached (FreeType / CoreText / DirectWrite)
                  -> draw glyphs as masks (CPU) or atlas textures (GPU)
```

The glyph atlas on GPU is a large texture (typically 2048x2048) that holds rasterized glyph masks. New glyphs are uploaded incrementally. The atlas can evict glyphs under pressure.

Sub-pixel positioning is supported but adds glyph cache pressure (a glyph at x=10.0 and x=10.25 are different cache entries). LCD subpixel anti-aliasing (color fringing for sharper text on RGB stripes) is increasingly disabled because high-DPI screens make it unnecessary and color management makes it complex.

### Image Decoding

Skia decodes JPEG (libjpeg-turbo), PNG (libpng), WebP (libwebp), GIF, and through plugins AVIF (libavif) and HEIF. Decoding is decoupled from drawing: an `SkImage` can be backed by a not-yet-decoded source, and decode happens on first access (or on a background thread).

In Chrome, image decode happens in the renderer on a worker thread, with the result handed to the compositor. Animated images (GIF, WebP, AVIF sequences) are decoded frame by frame on a timer.

### Color Management

`SkColorSpace` represents an ICC color profile. Each `SkSurface` and `SkImage` carries its color space. Drawing across spaces does linear-light conversion. The browser handles per-monitor ICC profiles and tags content (HDR videos, P3 photos) with their source space.

Wide-gamut support: P3, Rec. 2020, sRGB. HDR support is staged on platforms that expose HDR surfaces.

### Performance Characteristics

- A simple rectangle draw on Ganesh: ~10 to 100 nanoseconds per call (most time in batching).
- Path tessellation on Ganesh: depends on path complexity, microseconds per kilo-vertex.
- Glyph cache miss + raster: ~10 to 100 microseconds per glyph.
- Picture record: ~10 to 50 ns per simple op.
- Picture replay onto a tile: comparable to direct draw, plus tile management overhead.

### Senior Interview Material

- "Why does Skia decouple picture recording from rasterization? What does that buy the compositor?"
- "Compare Ganesh and Graphite. Why was Graphite written?"
- "How does Skia handle subpixel text positioning, and what is the cache cost?"
- "What is the GPU glyph atlas, and how does Skia handle eviction under pressure?"
- "Walk me through what happens between `canvas.fillRect(...)` in JavaScript and a pixel changing on the screen."

The next sections continue through Blink in more detail (CSS cascade, HTML parser) before returning to systems-level topics.

---
