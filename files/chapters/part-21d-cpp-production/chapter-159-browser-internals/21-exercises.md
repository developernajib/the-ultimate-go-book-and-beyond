## 159.21 Exercises

Six labs that take you from "have read about browser internals" to "have actually run the code". Time estimates assume a 2024-vintage developer machine with 32 GB RAM and a fast SSD.

### Lab 1: Build Chromium and Run It

**Time:** 4 to 8 hours wall time on first build (mostly compile time). 30 minutes hands-on.

Goal: get a Chromium dev binary running, modify a string in the UI, see your change.

Steps:

1. Install depot_tools per `https://chromium.googlesource.com/chromium/src/+/main/docs/get_the_code.md`.
2. `fetch --no-history chromium`.
3. `cd src && gn gen out/Default --args='is_debug=false is_component_build=true symbol_level=1'`.
4. `autoninja -C out/Default chrome` (this is the long step).
5. Run: `out/Default/chrome --user-data-dir=/tmp/chrome-dev --no-first-run`.
6. Open `chrome/browser/ui/views/profiles/profile_menu_view.cc`, find a user-visible string, change it.
7. `autoninja -C out/Default chrome` (incremental, 30 to 90 seconds).
8. Re-run, verify your change.

Deliverable: a screenshot of Chromium with your modified string.

### Lab 2: Write a Standalone V8 Embedder

**Time:** 2 to 4 hours.

Goal: build a CLI that runs a JS file with a C++-provided `print` function and a custom `readFile` function.

Steps:

1. Build standalone V8: `gclient sync && gn gen out.gn/x64.release --args='is_debug=false target_cpu="x64" v8_use_external_startup_data=false v8_monolithic=true is_component_build=false'`.
2. Build: `ninja -C out.gn/x64.release v8_monolith`.
3. Write `runner.cc` that:
 - Initializes `Platform`, `Isolate`.
 - Creates an `ObjectTemplate` for the global with `print` and `readFile`.
 - Reads a file path from argv, runs it as JS.
4. `readFile(path)` opens a file and returns its contents as a JS `String`. Validate the path (no traversal, must exist).
5. Run: `./runner test.js`.

Test JS:

```js
const data = readFile('test.txt');
print('file contents:', data);
print('squared:', (() => { let s = 0; for (let i = 0; i < 100; i++) s += i*i; return s; })());
```

Deliverable: source code, build command, sample output.

### Lab 3: Profile a Real Page

**Time:** 1 to 2 hours.

Goal: identify the bottleneck in a slow page using Chrome DevTools and Perfetto.

Steps:

1. Open a content-heavy site (your choice: a news homepage, a CRM dashboard demo, a heavy SPA).
2. Open DevTools -> Performance, record a 5-second navigation.
3. Identify:
 - Time spent in scripting vs layout vs paint vs composite.
 - The longest task on the main thread.
 - The number of forced layouts (search for "Forced reflow" warnings).
4. Switch to Perfetto: `chrome://tracing` or `ui.perfetto.dev`. Record the same load with categories `blink`, `cc`, `v8`, `loading`.
5. Find the LCP element. Trace its dependencies: which fetch must complete, which fonts, which CSS.
6. Write a one-page report: bottleneck, root cause, recommended fix.

Deliverable: the report.

### Lab 4: Implement a Mojo Interface (in your own fork)

**Time:** 4 to 6 hours.

Goal: add a Mojo interface to Chromium that exposes a small browser-process service to renderers.

Steps:

1. Define `chrome/common/lab/lab.mojom`:

```mojom
module chrome.lab.mojom;
interface LabService {
  GetTimestamp() => (int64 unix_ms);
  EchoString(string input) => (string output);
};
```

2. Add to `chrome/common/BUILD.gn` a `mojom("lab")` target.
3. Implement in `chrome/browser/lab/lab_service_impl.cc`. Validate `input` (cap at 1024 bytes).
4. Wire into the renderer interface broker in `chrome/browser/chrome_browser_interface_binders.cc`.
5. From a renderer (e.g., a DevTools snippet via a custom binding), call into the service.
6. Verify with logging: server side prints the input, client gets the output.

Deliverable: the diff against Chromium.

### Lab 5: Reproduce a V8 Deoptimization

**Time:** 1 hour.

Goal: write JS that gets optimized to TurboFan, then deoptimizes, and observe both events.

Steps:

1. In standalone d8 (V8's shell): `out.gn/x64.release/d8 --trace-deopt --trace-opt deopt_demo.js`.
2. `deopt_demo.js`:

```js
function add(a, b) { return a + b; }

// Warm to monomorphic with smis.
for (let i = 0; i < 100000; i++) add(1, 2);

// Cause deopt.
add('hello', 'world');
add(1.5, 2.5);
```

3. Observe `--trace-opt` showing `[compiling method add using Maglev/TurboFan]`.
4. Observe `--trace-deopt` showing `[deoptimizing ... reason: Insufficient type feedback for binary operation]`.
5. Add `%NeverOptimizeFunction(add)` (requires `--allow-natives-syntax`) and confirm tiering changes.

Deliverable: console output showing the optimization and deopt traces.

### Lab 6: Build a Simple Compositor Layer

**Time:** 3 to 5 hours.

Goal: in a Chromium check-out, modify Blink so that a specific element class always gets its own composited layer with a debug border.

Steps:

1. Find `PaintLayer::SetNeedsCompositingInputsUpdate` and the surrounding logic.
2. In `LocalFrameView::PaintTree` or similar, insert a check: if element has class `lab-composite`, force `layer->SetForcesCompositedScrolling(true)` (or the modern equivalent).
3. Add a debug border draw in the layer's paint path (a colored rectangle around the bounds).
4. Build and run `out/Default/chrome`.
5. Open a test page with a `<div class="lab-composite">` and verify it has its own layer in DevTools' Layers tab and shows the border.

Deliverable: the diff plus a screenshot.

### Stretch: Submit an Upstream CL

If you have a real fix, follow the process from the build-and-tooling section: `git cl upload`, attach owners, address review feedback, get CQ+2 to land. Even a documentation typo is a great way to walk through the workflow once.

---
