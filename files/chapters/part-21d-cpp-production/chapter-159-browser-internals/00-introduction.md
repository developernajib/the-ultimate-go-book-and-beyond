# Chapter 159: Browser Internals in C++

> "A browser is an operating system pretending to be a document viewer.", Anonymous Chrome engineer

A modern web browser is the most complex piece of consumer C++ software ever shipped. Chromium passed 35 million lines of source in 2024, of which roughly 20 million are first-party C++ (the rest is third-party deps, generated bindings, test data, and assets). For comparison the Linux kernel sits around 30 million lines, and most of that is drivers. A browser is a JIT-compiled language runtime, a layout engine, a graphics compositor, a media pipeline, a networking stack with three protocol generations live simultaneously, a storage engine, a sandboxed execution platform, and a secure update system. All of it runs on every desktop and phone, all of it parses untrusted input from the open internet, and all of it has to repaint at 60 frames per second.

This chapter is for engineers who want to work on Chrome, V8, WebKit, Gecko, or Edge. Those teams are the highest concentration of advanced C++ talent at any company on Earth. The interview bar is brutal because the day-to-day work is brutal: you will read template code that nobody alive fully understands, you will debug a use-after-free across a Mojo IPC boundary, and you will be asked why your CL regressed Speedometer 3 by 0.4%.

## Why Browsers Are Different

Most C++ codebases optimize for one or two of: throughput, latency, memory, security, binary size. A browser optimizes for all five at once and the trade-offs are not abstract. Every kilobyte of binary size adds milliseconds to startup on a low-end Android phone in India. Every megabyte of resident memory pushes the renderer closer to the OOM killer on a Chromebook with 4 GB of RAM. Every additional process gives you more isolation and costs you a base 10-20 MB. Every microsecond of IPC latency multiplied by thousands of round trips per page load shows up as p99 input delay on the New York Times.

Browser engineers cannot reason about their code in isolation. A change to V8's inline cache invalidation can regress jQuery selectors. A change to Blink's style invalidation can regress Gmail. A change to the network service can regress YouTube startup. The feedback loop is the perf bot suite, and a regression of 1% on a top metric will revert your change automatically.

## The Sandboxing Constraint

Browsers run untrusted code from arbitrary websites. The web security model assumes that V8 has zero-day RCE bugs because it has had hundreds, that Skia has parser bugs because every image format parser does, and that PDFium has heap corruption because it inherited Foxit's codebase. The defense is process-level sandboxing: the renderer runs with no filesystem, no network, no GPU access, and a seccomp-bpf filter that allows roughly 60 syscalls. Anything the renderer needs from the OS goes through Mojo IPC to a more privileged broker.

This constraint shapes every API. A renderer cannot open a font file, so font enumeration is an IPC. A renderer cannot accept a TCP connection, so fetch() is an IPC into the network service. A renderer cannot allocate GPU memory, so Skia draws into command buffers that the GPU process replays. The IPC boundary is C++ code on both sides, generated from .mojom interface descriptions, validated for memory safety because an attacker controls one side.

## The Performance Budget

Chrome ships a frame every 16.67 milliseconds. That budget covers JavaScript execution, style recalc, layout, paint, raster, GPU command submission, and compositing. Within that budget the JavaScript heap may need to GC, the layout tree may need to invalidate a subtree, and the network service may need to deliver a streamed image. Missing the budget produces visible jank, and visible jank shows up in Core Web Vitals which shows up in search ranking which shows up in revenue.

The numbers junior engineers underestimate:

- Style recalc on a 5000-element page: target 4 ms, budget 8 ms.
- Layout of a Gmail-sized DOM: target 6 ms.
- Major GC in V8 old generation: target under 50 ms with incremental marking, hit on a background thread with concurrent marking.
- IPC round trip renderer to browser: 50 to 200 microseconds, dominated by serialization and scheduler wakeup.
- Cold tab restore: 800 ms target on Pixel 6.

Every engineer on Blink or V8 has these numbers memorized.

## How Chromium Source Is Organized

The top-level layout is worth knowing before you `git clone`:

```
src/
  base/                  Common utilities, threading, callbacks, strings.
  build/                 GN build configuration, toolchain definitions.
  cc/                    Chromium compositor (layer trees, tile management).
  chrome/                Chrome-the-product. UI, browser process, omnibox.
  components/            Reusable, non-Chrome-specific modules (autofill, sync).
  content/               The "content" layer. Renderer/browser process boundary.
  device/                Device APIs (USB, Bluetooth, sensors).
  gpu/                   GPU process, command buffer, ANGLE integration.
  media/                 Media pipeline (decoders, capture, playback).
  mojo/                  IPC system. Bindings, message pipes, .mojom compiler.
  net/                   Network stack. URLRequest, HTTP, sockets, cache.
  pdf/                   PDFium integration.
  printing/
  remoting/
  sandbox/               Per-OS sandbox implementations.
  services/              Mojo-fronted services (network, audio, storage).
  third_party/blink/     Rendering engine. DOM, CSS, layout, paint.
  third_party/skia/      Graphics library.
  third_party/icu/
  third_party/...        Roughly 400 vendored deps.
  ui/                    Cross-platform UI framework (views, gfx, gl).
  url/                   URL parser. GURL.
  v8/                    Vendored V8 (also a separate top-level repo).
```

The `content/` layer is the architectural divide. Below `content/` is the browser engine that anyone could embed (CEF, Electron, Edge, Brave). Above `content/` is Chrome-the-product. WebKit has a similar split between WebKit2 (the engine) and Safari (the product). Knowing where to put a feature is half the design review.

## Junior to FAANG: What You Should Already Know

Before reading this chapter you should be comfortable with C++17 minimum, ideally C++20. You should understand virtual dispatch, RAII, move semantics, the C++ memory model, and templates well enough to read STL implementations. You should be able to draw the layout of a `std::vector` and explain what `std::shared_ptr` costs in a multi-threaded program. If any of that is shaky, return to chapters 12 through 30 of this book before continuing.

You should also have some web platform background. You do not need to be a web developer, but you should know what the DOM is, what a CSS selector is, what HTTP/2 multiplexing means, and roughly how a JIT compiler differs from an interpreter. The engineering details in this chapter assume the web platform vocabulary as a baseline.

## Senior at FAANG: What This Chapter Adds

If you are already a senior engineer working in browser-adjacent code (a JS framework, an Electron app, a WebView wrapper), this chapter fills in the systems-level picture you have been working around. You will leave understanding why postMessage is slow, why your Service Worker fetch handler runs on a different thread than you thought, why a CSS contain: layout property is a 40x speedup on a stock ticker, and why Chrome's process model changed three times in the last decade.

If you are interviewing for Chrome, V8, WebKit, or Edge, this chapter is the technical depth the interview loop expects. The questions in section 21 are the real questions, sourced from public statements by Chrome and WebKit engineers, from Mozilla's hiring rubric, and from the conference talks that members of those teams give at CppCon and BlinkOn.

The next sections walk through the multi-process architecture, Mojo, Blink, V8, Skia, the network stack, sandboxing, and tooling. By the end you will have a mental map of the complete system, deep enough to ask the right follow-up questions in a design review with someone who has been on the Chrome team for fifteen years.

---
