## 159.2 Multi-Process Architecture

Chrome's defining architectural decision, made in 2008 and refined every year since, is to split the browser into many OS processes. The original split was browser process plus one renderer per tab. The current split has at least seven process types, often hundreds of processes total on a busy session, and a process model (Site Isolation) where each web origin gets its own renderer.

### The Process Types

```
+------------------+         +-----------------------+
|  Browser Process |  <-->   |   Renderer (Site A)   |
|  (privileged)    |         |   sandboxed           |
|  - UI thread     |         |   Blink + V8          |
|  - IO thread     |         +-----------------------+
|  - Profile mgmt  |
|  - Tab/window    |         +-----------------------+
|  - Bookmark/hist |  <-->   |   Renderer (Site B)   |
+------------------+         +-----------------------+
        |
        |                    +-----------------------+
        +------------------> |   GPU Process         |
        |                    |   semi-sandboxed      |
        |                    |   Skia GPU, ANGLE     |
        |                    +-----------------------+
        |
        |                    +-----------------------+
        +------------------> |   Network Service     |
        |                    |   sandboxed (out-of-  |
        |                    |    process by default)|
        |                    +-----------------------+
        |
        |                    +-----------------------+
        +------------------> |   Utility (per task)  |
                             |   audio, storage,     |
                             |   data decoder, etc.  |
                             +-----------------------+
```

#### Browser Process

One per Chrome session. Owns the UI, profile data, history, bookmarks, downloads, and all privileged operations. Has full filesystem and network access on the OS level. Hosts the IPC hub through which renderers talk to anything else. A crash here kills the whole browser.

Inside the browser process, the architecture is multi-threaded with strict thread affinities. The UI thread runs the message loop for the OS event queue. The IO thread runs the Mojo message pipe pumps. Background thread pools handle file I/O, decompression, and similar.

Code lives in `chrome/browser/` (product layer) and `content/browser/` (engine layer).

#### Renderer Process

One per site instance under Site Isolation. Hosts Blink (rendering engine) and V8 (JS engine) for one or more frames belonging to the same origin. Sandboxed: no filesystem, no network, no IPC except through Mojo pipes the browser handed it. A renderer compromise lets an attacker run code as the renderer's UID with the syscall filter, but not escape to user data.

Renderer code lives in `content/renderer/` and `third_party/blink/renderer/`.

#### GPU Process

One per session typically, sometimes more. Runs Skia's GPU backend, ANGLE (the GLES-on-anything translator), and the command buffer service. Renderers submit graphics commands here through shared memory. Semi-sandboxed: needs GPU driver access, which forces a softer sandbox profile than the renderer.

Code lives in `gpu/` and `services/viz/`.

#### Network Service

Since Chrome 73 (2019) the network stack runs out of process. Owns the URLRequestContext, HTTP cache, cookie store, socket pools, TLS, QUIC, and DNS. Sandboxed on platforms where the policy is mature (Windows, macOS, Linux all have it now).

Code lives in `services/network/` and `net/`.

#### Utility Processes

Short-lived, one per task. Examples: audio service, storage service, data decoder (parses untrusted images and JSON away from the browser process), CDM (Content Decryption Module for DRM), print compositor.

#### Plugin / PPAPI

Mostly historical. PDFium runs in-process inside a renderer with extra hardening. Flash is gone.

### The Tradeoff Curve

Process isolation buys two things: security (a renderer compromise is contained) and reliability (a renderer crash kills only that tab). It costs:

- **Memory**: each process has a fixed overhead. Chrome targets roughly 10 to 20 MB per renderer at idle plus the working set of the page. On a 100-tab session this dominates.
- **Startup latency**: forking a process on Linux is fast (under a millisecond), but ramping up V8, Blink, and the IPC plumbing takes 30 to 80 ms on desktop and 200+ ms on low-end Android. Chrome runs a "spare renderer" warm to mask this.
- **IPC cost**: every cross-process call is at minimum a serialize, a write to a Unix domain socket / Windows named pipe / mach port, a scheduler wakeup, and a deserialize. 50 to 200 microseconds per round trip is typical. A page load can do thousands.

Chrome's process model has shifted along this curve over the years. Originally one renderer per tab. Then process-per-site-instance. Then Site Isolation (one renderer per site, with cross-origin iframes hosted out of process). On Android, where memory is tight, the model degrades to fewer processes under memory pressure.

### Site Isolation

Site Isolation, shipped on desktop in 2018 in response to Spectre, requires that every site (eTLD+1) gets its own renderer process. A page on `example.com` embedding an iframe from `evil.com` runs the iframe in a different OS process. The frame tree is unified across processes through Mojo, with the cross-process frame nodes called RemoteFrames.

The pseudo-code shape of frame tree node placement:

```cpp
// content/browser/renderer_host/frame_tree_node.h, simplified
class FrameTreeNode {
 public:
  RenderFrameHostImpl* current_frame_host() const;

 private:
  // Each FrameTreeNode lives in the browser process.
  // Its current_frame_host_ may be a LocalFrame (in some renderer)
  // or proxied to a remote renderer via RenderFrameProxyHost.
  std::unique_ptr<RenderFrameHostImpl> render_manager_;
  RenderFrameHostManager render_manager_;
};
```

The browser process owns the canonical frame tree. Each renderer sees its local frames as `LocalFrame` and remote frames as `RemoteFrame` placeholders. Operations like `postMessage` across origin boundaries go: source LocalFrame -> source renderer's RemoteFrame stub -> Mojo IPC to browser -> Mojo IPC to target renderer -> target LocalFrame.

### Process Allocation Policy

The decision of which process hosts a navigation is in `RenderProcessHostImpl::GetProcessHostForSiteInstance`. The simplified logic:

```cpp
RenderProcessHost* RenderProcessHostImpl::GetProcessHostForSiteInstance(
    SiteInstanceImpl* site_instance) {
  // 1. Does an existing process already host this exact SiteInstance? Reuse.
  if (auto* existing = FindProcessForSite(site_instance->GetSiteURL()))
    return existing;

  // 2. Are we over the process limit on this platform?
  //    Desktop: ~80 processes. Android: tighter, varies by RAM.
  if (ShouldTryToUseExistingProcessHost(site_instance)) {
    if (auto* host = GetExistingProcessHost(site_instance))
      return host;
  }

  // 3. Spawn a new renderer.
  return CreateRenderProcessHost(site_instance);
}
```

The "process limit" exists because Site Isolation on a 200-tab session would otherwise create 200 processes. Above the limit, sites that are not security-sensitive (no logged-in cookies, no isolated origins list) start sharing.

### Crash Containment

Each renderer registers a crash handler. When it dies, the browser process detects the broken Mojo pipe and shows the sad-tab page. State that lived only in the renderer (form input, JS heap, in-flight XHR) is gone. State in the browser process (history, cookies, downloads) is fine.

GPU process crashes are recoverable: the browser respawns it, and renderers re-establish their command buffer connections. Three GPU crashes within a session disable hardware acceleration for the rest of the session.

Browser process crashes are not recoverable.

### Threading Inside a Process

Inside the renderer, the main thread runs Blink, V8, and most JavaScript. A pool of compositor threads runs `cc/`. A pool of worker threads runs Web Workers and Service Workers (each in its own V8 isolate). The IO thread services Mojo. Pre-defined task runners (`TaskRunner`s in `base/task/`) abstract over thread pools and named threads.

The cardinal rule: V8 isolates are single-threaded. A given Isolate can only be entered from one thread at a time. Blink piggybacks on this by living entirely on the renderer main thread for the document's V8 isolate. Workers each get their own isolate on their own thread.

### What Senior Interviews Ask

- "Walk me through what happens when I type a URL and press enter, process by process, until pixels appear."
- "Why does Chrome use a multi-process model instead of multi-threading inside one process?"
- "What does Site Isolation buy you that the older process-per-tab model did not, given Spectre?"
- "How does Chrome handle a page with 50 cross-origin iframes without exhausting the process limit?"
- "Why is the GPU process not as tightly sandboxed as the renderer?"

The next section dives into Mojo, the IPC system that makes this whole topology possible.

---
