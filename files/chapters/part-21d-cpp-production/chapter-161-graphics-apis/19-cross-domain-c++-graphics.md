## Cross-Domain C++ Graphics

Graphics APIs are not just for games. The same Vulkan and D3D12 code paths drive browsers, ML data pipelines, scientific visualization, CAD, video editing, and offline rendering. This section covers the cross-domain applications a senior C++ graphics engineer should know.

### Chromium GPU Process

Chrome's GPU process is a separate OS process that owns all GPU access for the browser. Web content that uses WebGL, WebGPU, or Canvas2D, plus the compositor that turns layered content into a final frame, all runs in this process.

The architecture:

- Renderer processes (one per origin or tab) execute JavaScript and produce drawing commands.
- Drawing commands are serialized over IPC to the GPU process.
- The GPU process executes them through Skia (for Canvas2D and most layer compositing) or through ANGLE / WebGPU's Dawn (for WebGL / WebGPU content).
- Skia rasterizes through its Vulkan, Metal, or D3D12 backend depending on platform.
- The compositor (Viz, formerly Cc) merges all layers into the final frame and presents.

The GPU process is C++. Skia is C++. ANGLE is C++. Dawn is C++. Viz is C++. The whole pipeline is C++ from JavaScript-issued draw command to display.

Skia's Vulkan backend (`SkSurface::MakeRenderTarget` over a `GrBackendRenderTarget` wrapping a `VkImage`) is one of the larger production Vulkan applications outside games. It hits 99th percentile budgets that are tighter than most games (a single tab cannot stutter the whole browser).

ANGLE translates OpenGL ES 2/3 into Vulkan, D3D11, D3D12, or Metal. WebGL runs on ANGLE everywhere. ANGLE's Vulkan backend has shipped on Android since 2019 and is increasingly the path on Windows, replacing the legacy ANGLE-on-D3D11 stack.

Dawn is the WebGPU implementation. WebGPU is the standardized portable GPU API the web has settled on. Dawn implements it on D3D12, Vulkan, and Metal. Same code, different backend.

### Headless Rendering for ML

ML training datasets often need rendered images at scale: synthetic data for autonomous driving (CARLA, NVIDIA DRIVE Sim, Waymo's Carcraft), robotics simulation (Isaac Sim, Habitat), medical imaging synthesis, and 3D scene understanding. These pipelines render millions of frames offline, headless, with custom shaders that output ground truth in addition to color (depth, semantic labels, instance IDs, motion vectors).

Implementation: a Vulkan or CUDA-OptiX renderer running in a container, no display, no swapchain. Output goes to host-visible buffers, gets read back, written to disk or streamed to the training pipeline. NVIDIA's Omniverse uses this model: USD scenes go in, RGB+labels come out at thousands of frames per second per GPU.

The C++ challenges for headless rendering at scale:

**Throughput per dollar**. A100 / H100 GPUs cost \$20,000+. The pipeline must keep them saturated. Use multiple Vulkan instances per GPU, each rendering a different scene, with the CUDA / Vulkan interop to share the GPU between rendering and post-processing.

**Determinism**. Training requires reproducible outputs. The renderer must produce bit-identical frames given the same inputs. Avoid driver-specific defaults, set sample positions explicitly, fix random number generation per frame.

**Massive scene streaming**. Datasets are 10 to 100 TB. The renderer streams scene data on demand, GPU-resident only what is being rendered.

### Blender Cycles

Blender's Cycles is a production-grade path tracer used in films (Next Gen, Spider-Man: Across the Spider-Verse, much of the Mandalorian), TV, advertising, and indie. Architecture:

- Scene setup in C++. Triangle data, shader graphs, camera state.
- BVH builder in C++ (multiple algorithms: spatial split, embree-style).
- Render kernel in CUDA, OptiX (NVIDIA), HIP (AMD), Metal (Apple), oneAPI (Intel), and CPU SIMD.
- The kernel is shared C++ source with `#ifdef`-guarded backends.

The BVH builder is itself a complex C++ system. It evaluates split candidates using SAH (surface area heuristic), spatial splits at high triangle density, and produces a hierarchical structure that the path tracer traverses. Build time scales with scene complexity, for large scenes the builder is multithreaded with task stealing.

The shading language is OSL (Open Shading Language) for CPU and SVM (Shader Virtual Machine) bytecode for GPU. The GPU SVM is interpreted by a megakernel: one shader contains all material logic and dispatches by material type per ray. Modern Cycles has shifted toward separate kernels per material to reduce register pressure.

Cycles X (the 2021 rewrite) moved to a wavefront path tracer: rays go into queues, queues are processed in batches, intersections are processed in batches, shading is processed in batches. This improves GPU use at the cost of memory for the intermediate queues.

### Adobe Substance, Photoshop, Premiere

Adobe's professional applications are heavy GPU consumers, all C++. Substance 3D Designer (procedural material authoring) compiles node graphs to GPU compute shaders. Photoshop's neural filters use ML accelerated through Core ML on Mac and DirectML on Windows. Premiere uses GPU compute for color grading, scaling, and effects.

The pattern is similar across these apps: a node-graph DSL that compiles to GPU compute or fragment shaders, executed via D3D12, Metal, or OpenCL/CUDA depending on platform. The C++ runtime manages caches of compiled shaders and intermediate textures.

### Browser Compositors

Every modern OS has a compositor: Windows DWM, macOS WindowServer / SkyLight, Android SurfaceFlinger, Linux Mutter / KWin / Sway. They are GPU-accelerated, written in C++ (or Rust, in Sway's case), and use the same underlying graphics APIs as games.

WindowServer on macOS uses Metal and Core Animation. SurfaceFlinger uses OpenGL ES (with Vulkan migration ongoing). DWM uses D3D11 historically and D3D12 in recent Windows. The compositor's job is to take per-application backbuffers and composite them into the final desktop frame at the display's refresh rate.

The performance budget for a compositor is brutal: 16.6 ms at 60Hz, 8.3 ms at 120Hz, 6.9 ms at 144Hz, 4.2 ms at 240Hz. Frame drops cause perceptible jank. Modern compositors are heavily threaded, lock-free internally, and use direct scanout (the GPU presents an application's surface directly without a compositor copy) when possible.

### Scientific Visualization

ParaView, VisIt, OSPRay, NVIDIA IndeX. Visualizing 1 TB volumetric simulation data is a graphics problem with different constraints than games. The data does not fit on the GPU. Streaming, level-of-detail, and parallel rendering across nodes (MPI-coupled GPUs) are required.

OSPRay (Intel) is a CPU-only ray tracer using AVX-512 and SYCL. NVIDIA IndeX uses CUDA for volumetric rendering at LANL and ORNL. Both are C++ codebases at the multi-million-line scale.

### Game Streaming

GeForce NOW, xCloud, PlayStation Plus Premium. Run the game on a server, encode the frame to H.264/H.265/AV1, stream over the network to a client. The encoder runs on the same GPU as the game (NVENC, AMF, Apple's VideoToolbox), reading directly from the swapchain.

The C++ challenge is end-to-end latency: render budget plus encode budget plus network plus decode plus display. Each step is on a tight schedule. Renderer changes (NVIDIA Reflex, AMD Anti-Lag) reduce the queue depth between game and GPU to minimize input lag, and the encoder is tuned for low-latency mode.

### Junior to FAANG

A junior thinks Vulkan is for games. A senior knows the same Vulkan code path drives Chrome's compositor, Adobe's render farm, NVIDIA Omniverse's synthetic data factory, and an Isaac Sim robotics fleet, and the C++ skills that ship one of those ship all of them.

---
