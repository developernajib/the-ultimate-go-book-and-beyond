## Where C++ Wins, Domain by Domain

> **Junior to FAANG:** Career planning means picking a domain, not just a language. C++ is a tool. The domains below are the actual jobs.
>
> **Senior at FAANG:** Domain expertise compounds faster than language expertise. The senior C++ engineer who also understands HFT microstructure, or video codec internals, or GPU memory hierarchy, has a moat that pure language skill does not provide.

This chapter walks the major domains where C++ remains dominant in 2026, with one paragraph each on why and a real-world example you can study or join.

### High-frequency trading (deterministic latency)

HFT exists at the intersection of "latency tail matters more than throughput" and "every microsecond is money". A typical market-making strategy has a budget of roughly 1-5 microseconds from network packet receipt to order send on the wire. GC pauses, page faults, malloc spikes, and context switches are all unacceptable. The standard stack is C++ with kernel-bypass NICs (Solarflare Onload, Mellanox VMA, OpenOnload), shared memory IPC, lock-free queues, and CPU pinning. Real example: Citadel Securities, Jump Trading, Tower Research, Hudson River Trading, and Optiver are all heavy C++ shops. Open-source landmarks: Aeron (mostly Java but the patterns are universal), Disruptor (LMAX, Java), Onixs (commercial C++ FIX engine). For a feel of the domain, read the Disruptor paper and Carl Cook's CppCon talk "When a Microsecond Is an Eternity".

### Browsers (large codebase legacy plus performance)

Chrome is 35+ million lines of C++. WebKit is similar order of magnitude. Firefox is a mix of C++ and Rust (Servo components have been integrated as Stylo, WebRender). The browser has unique constraints: parse untrusted HTML and JavaScript at high speed, render at 60-120 Hz, manage tens of GB of memory across processes, sandbox aggressively, and run on every operating system. JavaScript engines (V8, JavaScriptCore, SpiderMonkey) are the hottest sub-projects: hand-tuned interpreters, baseline JITs, optimizing JITs, all C++. Real example: V8's TurboFan and Maglev compilers are C++14/17 with heavy template use for the IR. To study, clone Chromium, build it (this takes hours), and read `v8/src/compiler/turbofan-graph.h`. The complexity is humbling.

### Game engines (memory budget plus SIMD plus tooling)

A AAA console game running at 4K 60 FPS has 16.6 ms per frame to do physics, animation, AI, audio, networking, and rendering submission. Memory is fixed and small (12-16 GB on PS5, 13.5 GB usable on Xbox Series X). GC is impossible. Engines run their own allocators (frame allocator, pool allocator, scratch allocator), their own memory budgets per subsystem, and their own job systems for parallelism. SIMD is everywhere: vector math, mesh skinning, physics broad-phase, audio mixing. Real example: Unreal Engine 5 source is available to licensees and is C++17. Study `Engine/Source/Runtime/Core/Public/Math/UnrealMathSSE.h` to see SIMD wrapped portably. id Tech is famously pragmatic (John Carmack's coding style). Frostbite (DICE/EA) is a strong reference for ECS and data-oriented design.

### Databases (cache-conscious data structures)

Databases live and die by cache behavior. A B+tree node sized to a cache line, a bloom filter that fits in L1, a hash table with prefetching, an LSM compaction strategy that respects DRAM bandwidth. Modern databases are written in C++ for these reasons. Real examples: ClickHouse (C++20, columnar OLAP), MongoDB (C++17, document store), MySQL/MariaDB (C++ with C history), CockroachDB (Go, an exception that proves the rule), TiKV (Rust, the new entrant), RocksDB (C++ at Meta, the embedded LSM behind many systems). Reading list: ClickHouse source is approachable and modern. RocksDB's `db/version_set.cc` is a deep dive on persistent state machines. For OLTP, study CMU's Andy Pavlo's database course.

### Compilers (LLVM/GCC stay in C++ for momentum)

LLVM is millions of lines of C++14/17. GCC is C++ since the gcc-4.8 era. The Swift compiler, the Rust compiler's frontend (rustc itself is Rust, but it links against LLVM which is C++), the Go gc compiler (Go, but cgo backends are C++), the V8 and JSC compilers, MSVC, ICX (Intel), Clang, all C++. Why? Compilers manipulate large heterogeneous trees and graphs. C++'s class hierarchies and templates fit IR design naturally. The optimization passes are often template-heavy DSLs. The 30-year codebase momentum is unbeatable. Real example: read `llvm/lib/Transforms/Scalar/LoopVectorize.cpp`. It is dense but representative of professional C++ compiler code.

### Graphics (GPU drivers and shader compilers)

Vulkan, Direct3D 12, Metal, OpenGL, all expose C APIs implemented internally in C++. GPU drivers are millions of lines of C++ per vendor (NVIDIA, AMD, Intel, Apple, Mali, Qualcomm Adreno). Shader compilers (DXC, glslangValidator, SPIRV-Cross, Apple's Metal compiler, NVIDIA's NVRTC) are all C++. CUDA, HIP, and SYCL are C++-based GPU programming languages. There is no path to writing a competitive GPU driver in another language: the data shapes, the toolchain, and the existing investment all point one way. Real example: Mesa3D (the open-source Linux graphics stack) is C and C++. The Intel and AMD open-source driver components are mostly C++. SwiftShader (Google's CPU-fallback Vulkan implementation) is C++17.

### Embedded and kernel (no GC, no surprise allocation)

Linux kernel is C, FreeBSD is C, Windows kernel is C with C++ in some new components. Drivers, bootloaders, hypervisors. User-space embedded firmware (set-top boxes, automotive ECUs, industrial controllers, consumer electronics SoCs) is often C++ today, with `-fno-exceptions -fno-rtti`. The discipline: no surprise allocation, predictable timing, small binary, integrate with vendor C SDKs. Real example: ChromeOS firmware (coreboot is C, Chrome OS user space is C++), Tesla's vehicle compute (mostly C++ on Linux with custom RT patches), Cisco router OS components, Juniper's Trio chipset firmware, Apple's secure enclave (mix of C/C++/some Swift). For a public reference, study Zephyr RTOS (C, but a clear reference for embedded patterns) and consider the Boost.SML state-machine library for embedded C++.

### Audio plugin DSP (real-time)

A plugin in a DAW (Pro Tools, Logic, Ableton, Bitwig, Reaper) processes audio buffers on a real-time thread with hard 1-3 ms deadlines. Missing the deadline causes audible clicks. C++ is the native language: JUCE, iPlug2, VST3 SDK, AAX SDK, AudioUnit, all C++. The discipline: no allocation, no locks, no exceptions, no system calls on the audio thread. Communicate with the GUI thread through lock-free ring buffers. Real example: most commercial plugins (Universal Audio, Native Instruments, Waves, FabFilter, iZotope, Slate Digital) are JUCE-based C++. Open source: SuperCollider's `sclang` server, FAUST DSL compiler output is C++, and iPlug2 examples on GitHub. Read Timur Doumler's CppCon talks on real-time audio.

### Telecom and BEAM hot paths

Erlang/Elixir's BEAM virtual machine is C. Hot paths in network gear (Ericsson, Nokia, Cisco, Juniper, Huawei) are C and C++ with FPGA offload. WhatsApp's BEAM-based messaging core has C++ NIFs (native implemented functions) for crypto, codec, and shared-state hot paths. Real-time telecom protocols (5G UPF, SCTP stacks, GTP-U handlers) are commonly C++ on top of DPDK (Data Plane Development Kit, also C). Real example: Open5GS is a 5G core implementation in C. Free5GC is in Go but with C dependencies for performance-critical paths. NVIDIA Aerial (5G RAN on GPU) is C++ with CUDA.

### Robotics and ROS2

ROS2 (Robot Operating System 2) is C++14 with optional Python bindings. Real-time control loops, sensor fusion, computer vision, motion planning, all C++. The middleware (DDS, RTPS) is C++. Real example: Boston Dynamics Spot's API is C++, Tesla Bot's perception stack is C++ with Python prototyping, Waymo and Cruise are heavy C++ shops, Skydio's drone autonomy is C++. ROS2's open-source examples (Navigation2, MoveIt2) are accessible entry points to professional robotics C++.

### Aerospace, defense, simulation

Flight simulators, mission planning, signal processing for radar/sonar, missile guidance, satellite ground stations. Heavy C++, often with safety-critical certification. Real example: NASA cFS (Core Flight System) is C, but ground systems and simulation are C++. Lockheed's F-35 mission systems are C and C++. SpaceX's Dragon and Starship flight software is C++ on Linux with PREEMPT_RT patches. Companies hiring: Lockheed, Boeing, Northrop, Raytheon, BAE, Anduril, SpaceX, Rocket Lab, Astra, Relativity. Compensation is below FAANG but work intensity and clearance requirements vary.

### Scientific computing and HPC

CERN, NASA, national labs, weather forecasting, computational fluid dynamics, molecular dynamics. Fortran historically, C++ increasingly. ROOT (CERN's analysis framework) is C++. Geant4 (particle physics simulation) is C++. LAMMPS (molecular dynamics) is C++. OpenMP and MPI bindings are most idiomatic in C++. Real example: CERN's ROOT framework includes a C++ JIT (Cling, based on Clang) that lets physicists script in C++ interactively. SLATE and FleCSI are modern HPC C++ libraries.

### Machine learning infrastructure

The Python you use sits on top of C++. PyTorch's `torch/csrc` is C++. TensorFlow's runtime is C++. JAX's XLA compiler is C++. ONNX Runtime is C++. NVIDIA's cuDNN, cuBLAS, NCCL are C++. The CUDA kernels themselves are C++. Real example: read PyTorch's `aten/src/ATen/native/cuda/Reduce.cuh` to see real C++ template metaprogramming for GPU kernel generation. The Python API is a thin wrapper around weeks of compute happening in C++.

### The pattern

Every domain in this list has the same shape: hard latency or memory or throughput requirement, decades of accumulated investment, vendor toolchains in C++, talent pool that knows C++. None of these will rewrite to another language in the next decade. The senior C++ career path is choosing one or two of these domains and going deep.

If you are early-career and trying to pick: HFT pays the most cash, FAANG infra has the broadest career range, game engines have the steepest learning curve and the most fun problems, GPU/ML infrastructure is growing fastest. Embedded and aerospace pay less but offer stability and meaningful work. Browsers and databases are stable, deep, and have public open-source codebases you can contribute to before you have a full-time role.
