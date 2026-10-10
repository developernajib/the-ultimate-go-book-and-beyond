## 159.14 Graphics Compositing

The compositor is the part of the browser that decides what pixels go on the screen each frame. It lives in `cc/` (Chromium Compositor), with the GPU-side aggregation in `components/viz/` and the GPU process at `gpu/`. The compositor is the difference between a smooth-scrolling page and a janky one: it takes paint output from Blink, breaks it into tiles, rasterizes those tiles on the GPU in parallel, and then composites the results into a final framebuffer.

### Why Compositing Exists

Naive rendering: paint everything from scratch each frame. For a static page that scrolls, this redraws content that has not changed.

Compositing: split the page into layers. Layers that have not changed are reused. Scrolling becomes a transform on a cached layer, no repaint needed. Animations (transforms, opacity) run on the GPU without invoking Blink at all. CSS `transform` is the compositor-friendly animation, `top`/`left` is the bad one because it triggers full re-layout.

### The Two-Tree Model

The compositor maintains two layer trees:

- **Pending tree.** Being built from the latest Blink commit. May not be ready (waiting on tile raster).
- **Active tree.** Currently displayed.

When the pending tree is ready, it activates: swaps to active, the previous active is discarded. This is the "double buffering" that keeps display showing a consistent image while the next frame is prepared.

```cpp
// cc/trees/layer_tree_host_impl.h
class LayerTreeHostImpl {
  std::unique_ptr<LayerTreeImpl> active_tree_;
  std::unique_ptr<LayerTreeImpl> pending_tree_;
  std::unique_ptr<LayerTreeImpl> recycle_tree_;
  // ...
};
```

### Layers and Tiles

Each `Layer` (and its compositor-side counterpart `LayerImpl`) represents a region of the page that can be composited as a unit. Examples:

- The root layer (the document).
- Each `<video>`, `<canvas>`, `<iframe>`.
- Elements with `transform: translate3d(...)` or `will-change: transform`.
- Scrollable subtrees.
- Fixed-position elements.

Each layer is divided into tiles, typically 256x256 or 512x512 pixels. Only the tiles that intersect the viewport (plus a margin for prefetching) are rasterized.

### Tile Rasterization

Raster takes the picture (Skia display list from Blink paint) and turns it into pixels:

```cpp
class TileTaskWorkerPool {
  // Worker threads pick up tiles, run the picture into a tile-sized
  // backing surface (CPU bitmap or GPU texture), notify completion.
};
```

GPU raster uses Skia GPU on a worker context. CPU raster uses Skia raster, with the result uploaded to the GPU as a texture. GPU raster is the default on most platforms today, the cost of upload offsets the savings of running on the GPU only for very small areas.

### The Frame Pipeline

A complete frame:

```
1. BeginFrame from Viz (in GPU process) -> renderer compositor.
2. Compositor asks Blink to do main-thread work (style, layout, paint).
3. Blink commits paint result to compositor as picture + layer tree update.
4. Compositor builds pending tree, schedules raster work.
5. Raster workers produce tiles.
6. When all needed tiles are ready, pending -> active.
7. Compositor produces a CompositorFrame: layer transforms, tile texture refs.
8. CompositorFrame submitted to Viz over Mojo.
9. Viz aggregates frames from all renderers and the browser UI.
10. Viz issues GL/Vulkan/Metal commands -> swap chain.
11. Display refreshes.
```

This pipeline is staged: while step 11 is happening for frame N, the compositor is at step 4 for frame N+1, and Blink is working on N+2. Pipelining hides per-stage latency at the cost of input lag.

### BeginFrame Protocol

Viz drives the cadence with `BeginFrame` messages tied to vsync. Each renderer subscribes to BeginFrames for its surfaces and reports back:

- `DidFinishFrame` with a `BeginFrameAck` indicating whether work was done.
- `SubmitCompositorFrame` if a new frame is ready.

Renderers that did no work this frame (page is static) explicitly ack with no submission, and Viz reuses the previous frame.

### Viz: Multi-Surface Aggregation

The browser UI, each renderer, and PIP video each produce their own CompositorFrame. Viz aggregates them into a single frame for the display. Aggregation:

1. Walk a tree of `Surface`s (one per source).
2. Substitute each surface's CompositorFrame in.
3. Apply transforms, clips, and blend modes.
4. Produce a single `AggregatedFrame`.

The output goes to the OutputSurface, which submits it to the platform compositor (DirectComposition on Windows, CoreAnimation on macOS, Wayland surfaces, Android SurfaceFlinger).

### Hit Testing

When you click on a page, the browser must determine which renderer (and which frame in it) gets the event. Hit testing on the compositor side uses the same layer tree: the `HitTestRegionList` is committed alongside the frame, and Viz uses it to dispatch input events to the right surface.

### Threaded Scrolling

Scrolling can run entirely on the compositor thread without the main thread:

```
User touch / wheel event
  -> InputHandler on compositor thread
  -> scroll the active layer's transform directly
  -> next frame uses the new transform
```

The main thread is informed, eventually, via a deferred `scroll` event. This is why a Blink main thread that is busy compiling JavaScript can still scroll smoothly: scrolling has been moved off the critical path.

Edge cases that fall back to main-thread scrolling: scroll event listeners that call `preventDefault`, custom scroll snap, scrollbars with author styling, etc. The compositor reports "main thread scrolling reasons" in tracing.

### Hardware Overlays

For full-screen video and certain other content, the compositor can promote a layer to a hardware overlay: the platform compositor reads its texture directly from the GPU process without going through GL composition. Saves substantial power on mobile.

DirectComposition (Windows), CALayer overlays (macOS), HWComposer (Android) all expose this. The compositor must satisfy strict conditions (axis-aligned, no opacity, no filters) to qualify.

### Display Compositor in the GPU Process

The display compositor used to run in the browser process. Since 2017 it lives in the GPU process. The reason is the same as for the network service: parsing and aggregating untrusted content (textures from sandboxed renderers) is risky, and the GPU process is already the trust boundary for hardware access.

### Performance Budget

Compositor budget at 60 fps: 16.67 ms total, of which the compositor must finish in roughly 4 ms after Blink commits. At 120 fps the budget halves. ProMotion displays (variable refresh rate up to 120 Hz on Apple devices, similar on high-end Android) require the compositor to negotiate frame rates with the OS.

Tile raster on a worker thread does not count against the compositor thread budget directly, but tiles must be ready before pending tree activation, and a slow raster worker stalls activation.

### Senior Interview Material

- "Walk me through what happens between a `transform` change in CSS and the next pixel on the screen."
- "Why does Chromium have two layer trees?"
- "What is threaded scrolling, and what causes a page to fall back to main-thread scrolling?"
- "Why did the display compositor move from the browser process to the GPU process?"
- "Explain hardware overlays. Why is full-screen video typically promoted, and when does promotion fail?"

The next section turns to the security boundary that sits underneath all of this.

---
