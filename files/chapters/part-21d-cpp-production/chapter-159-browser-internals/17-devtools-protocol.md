## 159.17 DevTools Protocol

The Chrome DevTools Protocol (CDP) is the wire protocol between Chromium and any debugger or automation client. The same protocol drives the in-browser DevTools UI, headless Chrome, Puppeteer, Playwright, and most browser-automation tooling. CDP is implemented in `third_party/blink/renderer/core/inspector/`, `content/browser/devtools/`, and `v8/src/inspector/`.

### Protocol Shape

CDP is JSON-RPC over a WebSocket (or pipe in some configurations). Messages:

- **Commands.** `{"id": 1, "method": "Page.navigate", "params": {"url": "..."}}`. Reply: `{"id": 1, "result": {...}}` or `{"id": 1, "error": {...}}`.
- **Events.** `{"method": "Page.frameNavigated", "params": {...}}`. Pushed from the browser, no client request.

The protocol surface is grouped into "domains": `Page`, `Network`, `Runtime`, `Debugger`, `DOM`, `CSS`, `Performance`, `Profiler`, `Target`, `Security`, ~50 total. Each domain has commands and events. Definitions live as JSON in `third_party/blink/public/devtools_protocol/browser_protocol.pdl` and `v8/include/js_protocol.pdl`.

### How Domains Connect to Implementation

Each domain has a C++ class implementing its commands and emitting its events.

```cpp
// third_party/blink/renderer/core/inspector/inspector_page_agent.h
class InspectorPageAgent : public InspectorBaseAgent<protocol::Page::Metainfo> {
 public:
  protocol::Response navigate(const String& url, ...) override;
  protocol::Response reload(...) override;
  void frameNavigated(LocalFrame* frame);
  // emits Page.frameNavigated event.
};
```

Generated bindings handle JSON parse/serialize. The agent talks to the rest of Blink through normal C++ APIs.

The V8 Inspector (`v8/src/inspector/`) implements `Runtime`, `Debugger`, `Profiler`, `HeapProfiler`, `Console`. It is part of V8 itself, not Blink, because debugging needs deep V8 internals (breakpoints in compiled code, async stack capture across promises, heap snapshots).

### Targets

A CDP client can attach to multiple targets: tabs, iframes, workers, service workers, the browser process itself. Each target has its own session with its own message stream.

```
Client (Puppeteer / Playwright)
   |
   v  WebSocket
+----------------------+
| Browser-level target | -- handles Browser, Target domains
+----------------------+
   |
   |  child sessions:
   v
Per-tab target (Page session)
   |
   v
Per-frame target (cross-origin iframe)
   |
   v
Per-worker target
```

The `Target` domain is the API for enumerating and attaching to child targets. `Target.attachToTarget` returns a new sessionId, further messages with that sessionId are routed to the child target.

### Headless Mode

`--headless=new` runs Chrome with no UI, all in-process windows are off-screen, and the GPU process uses a software backend. Otherwise it is the same Chrome: same V8, same Blink, same network stack.

Headless is the workhorse of:

- Server-side rendering and screenshotting.
- PDF generation from HTML.
- Browser automation tests.
- Web crawling.

Old `--headless` (the one that shipped in 2017) was a separate code path. New headless (2023+) reuses the full browser process, eliminating divergence between headless and headed behavior.

### Puppeteer and Playwright Integration

Both Puppeteer and Playwright are CDP clients. Differences:

- **Puppeteer.** Maintained by the Chrome team. Wraps CDP directly. Chrome-only by design.
- **Playwright.** Maintained by Microsoft. Has Chrome (via CDP) plus Firefox and WebKit drivers. Uses CDP for Chrome but a different protocol (a Playwright-specific patched protocol) for the others.

A Puppeteer call like `page.click('#login')`:

```
1. evaluate JS in the page to find the element bounding box (Runtime.evaluate).
2. Compute click coordinates.
3. Dispatch synthetic mouse events (Input.dispatchMouseEvent with type=mousePressed, etc.).
4. Wait for any navigation event if relevant (Page.frameNavigated subscription).
```

The "wait" semantics are where Playwright differentiates: it has built-in retry-and-wait logic for elements that aren't ready, which is encoded as a sequence of CDP polls.

### Debugger Domain

The `Debugger` domain provides the client-server side of source debugging:

- `Debugger.setBreakpointByUrl`: install a breakpoint.
- `Debugger.paused` event: fired when execution stops.
- `Debugger.resume`, `Debugger.stepOver`, `Debugger.stepInto`, `Debugger.stepOut`.
- `Debugger.getScriptSource`: fetch source for a loaded script.
- `Debugger.evaluateOnCallFrame`: run an expression at the paused frame.

Implementation in `v8/src/inspector/v8-debugger.cc`. V8 supports breakpoints by patching debug instructions into bytecode (Ignition) and triggering deopt of any optimized code. Stepping is implemented by setting per-frame "should pause" flags on the call stack.

### Network Domain

Intercepting network requests via CDP:

- `Network.enable` to receive events.
- `Network.requestWillBeSent`, `Network.responseReceived`, `Network.dataReceived`, `Network.loadingFinished` events.
- `Network.setRequestInterception` (deprecated) and `Fetch.enable` (current) to pause and modify requests.

`Fetch.enable` lets the client pause requests at specified stages and respond with a custom body, override headers, or fail the request. Used by Playwright's mocking, by ad-blocking crawlers, and by tools that record network traces.

### Performance and Tracing Integration

`Tracing.start` enables Chrome's perfetto-based tracing. Categories like `blink`, `cc`, `v8`, `gpu` produce massive event streams. `Tracing.tracingComplete` event delivers a JSON or proto blob.

`Performance.metrics` exposes coarse metrics. `Profiler.start`/`Profiler.stop` runs V8's CPU profiler.

The Chrome DevTools UI uses these domains to render the Performance panel.

### Security Considerations

CDP is enormously powerful. A CDP-attached process can read any cookie, execute arbitrary JS in any context, intercept any network request, take screenshots of any page. Chrome only exposes CDP when the user explicitly opts in (`--remote-debugging-port=9222`) and binds by default to localhost only.

Chrome also displays a "DevTools is open" indicator when a session is attached. This is intentional: malware that uses CDP cannot fully hide its presence.

### CDP vs WebDriver BiDi

WebDriver BiDi is the W3C standard alternative to CDP. It emerged because CDP is Chrome-specific. BiDi is a bidirectional WebDriver extension that aims to provide CDP-equivalent capabilities across all browsers.

Chrome supports BiDi alongside CDP. Selenium 4+ uses BiDi. Playwright continues to use CDP because BiDi does not yet match its feature surface.

Implementation in Chromium: `chrome/test/chromedriver/`.

### Senior Interview Material

- "Walk me through the architecture of CDP. Where do messages enter Chromium, and how are they routed?"
- "What is a target, and how does session multiplexing work for cross-origin iframes?"
- "Why did Chrome rewrite headless mode in 2023?"
- "How does V8 implement breakpoints in optimized code?"
- "Compare CDP and WebDriver BiDi. What does each give up?"

The next section moves to the build system that ties this whole codebase together.

---
