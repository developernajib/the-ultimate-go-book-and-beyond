## 159.16 Extension and PWA Architecture

Chrome extensions and Progressive Web Apps share an underlying mechanism: privileged JavaScript that runs alongside web content but with a different trust model. Implementation lives in `extensions/`, `chrome/browser/extensions/`, and `chrome/browser/web_applications/`.

### Extensions: Manifest V3

Manifest V3 (MV3) is the current extension model, replacing Manifest V2 (which is deprecated and deactivated for most users on stable Chrome since 2024).

Key MV3 architectural changes from MV2:

- **Service worker background scripts** instead of persistent background pages. The extension's background can be torn down when idle.
- **`declarativeNetRequest`** instead of `webRequest` blocking listeners. Rules are declarative, evaluated in the network service without round-tripping to the renderer.
- **Remotely hosted code is forbidden.** All code must ship in the extension package.
- **Tighter `host_permissions`** with runtime permission grants.

A minimal `manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "MyExtension",
  "version": "1.0",
  "permissions": ["storage"],
  "host_permissions": ["https://*.example.com/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["https://*.example.com/*"],
    "js": ["content.js"]
  }],
  "action": { "default_popup": "popup.html" }
}
```

### Process Model

Extensions run across multiple contexts:

- **Background service worker.** Per extension, in its own worker thread. Owns the extension's privileged API surface.
- **Content scripts.** Injected into web pages. Run in an isolated world (next section). Have a limited view of the extension API.
- **Popup / options page.** Extension-origin pages, run in their own renderer process.
- **Side panel.** Newer (2023): extension UI in a side dock instead of a popup.

The background service worker process is a normal renderer process locked to the extension's origin. Extensions are first-party in their own origin (`chrome-extension://<id>/`).

### Isolated Worlds

A content script runs in the same V8 isolate as the page (so it shares the DOM) but in an isolated world: a separate JS context where the page's globals are invisible. The isolated world has its own copy of `Object.prototype`, its own `window` properties.

Implementation:

```cpp
// In Blink, the script controller maintains multiple V8 contexts per Frame.
// Each isolated world is one of those contexts.
class ScriptController {
 public:
  v8::Local<v8::Context> WorldContext(DOMWrapperWorld& world);
};
```

The DOM is shared (the same `Document` and `Element` C++ objects back both contexts), but JS objects are not. A page cannot reach into the content script's variables, and a content script cannot accidentally invoke a page-defined `Array.prototype.push`. This is the main defense against extensions being broken by malicious page code.

### Communication

The extension architecture has several IPC mechanisms:

- `chrome.runtime.sendMessage` between content script and background service worker. Async. Implemented as Mojo through the extension's IPC channel.
- `chrome.runtime.connect` for long-lived ports.
- `window.postMessage` between content scripts and the page (deliberate trust boundary).
- `chrome.tabs.sendMessage` from background to a specific tab's content script.

### Permissions

Extensions declare permissions in the manifest. Some are user-visible at install time (`history`, `tabs`, `bookmarks`), others are silent (`storage`, `alarms`). Host permissions (`https://*.example.com/*`) grant the ability to inject content scripts and read responses on those origins.

Recent Chrome versions added "site access" controls: the user can deny an extension access to a site at install or runtime, regardless of manifest declaration. Defense against compromised or malicious extensions reading your banking site.

### Service Worker Lifecycle for Extensions

Like web service workers, extension service workers have lifecycle events: `install`, `activate`, `fetch`. Unlike web SW, extension SW does not intercept fetches by default, it instead provides the extension's privileged API handlers and event listeners.

The major difference: extension SWs are torn down aggressively when idle (~30 seconds). State must persist via `chrome.storage`. The worker is restarted on next event. This caused major MV3 migration pain because MV2 background pages were persistent.

### Native Messaging

Extensions can talk to a locally-installed native app via the `chrome.runtime.connectNative` API. The native app is registered in a per-user manifest file with a JSON spec. Communication is length-prefixed JSON over stdin/stdout. Used by password managers, hardware security keys, gaming peripheral managers.

Security: the user explicitly installs both the extension and the native app, with matching IDs. Random extensions cannot launch arbitrary native code.

### Progressive Web Apps

A PWA is a website that has installed itself as an app on the OS. The web manifest (`manifest.webmanifest`) declares display mode, icons, theme color, scope. A service worker provides offline behavior. The browser installs an app shortcut, runs the site in a window without browser chrome (`display: standalone`), and gives it OS-level surface area: dock, start menu, share targets, file handlers.

Implementation in `chrome/browser/web_applications/`:

```cpp
class WebApp {
  std::string app_id_;
  GURL start_url_;
  GURL scope_;
  std::vector<IconInfo> icons_;
  DisplayMode display_mode_;
  // Persisted to per-profile WebApp database (LevelDB).
};
```

A PWA window is a renderer process with the app's origin, a stripped browser frame, and the same Site Isolation rules as a normal tab. The browser process treats it specially for window grouping and OS integration.

### Trusted Web Activities (Android)

A TWA is an Android app that hosts a PWA in a Custom Tab. The app proves origin ownership via Digital Asset Links (a JSON file at `https://example.com/.well-known/assetlinks.json` listing the package that owns the origin). Once verified, the Custom Tab opens in immersive mode (no browser chrome, no URL bar) and the user sees an app, not a browser.

Used by retailers, news publishers, and so on to ship a "real" Android app that is actually their existing website.

### Window Controls Overlay

A PWA on desktop can opt into a custom title bar (`display_override: ["window-controls-overlay"]`). The window controls (close, minimize, maximize) overlay the page content, and the page draws the title bar itself. This is how apps like Squoosh and Photopea look like native desktop apps.

### File Handlers and Protocol Handlers

A PWA can register as a handler for file types (open `.png` in Photopea PWA) or protocols (open `mailto:` links in a webmail PWA). The OS routes the request to Chrome, which opens the PWA in scope.

Implementation involves writing OS-level registry entries (`HKCU\Software\Classes\` on Windows, MIME types on Linux, `LSItemContentTypes` on macOS) at install time and registering the handler with the launch URL.

### Push Notifications and Background Sync

PWAs and extensions can register for push notifications (server -> push service -> browser -> service worker `push` event). The service worker may run with no UI to display the notification.

Background Sync defers work until the device has connectivity. The service worker `sync` event fires when conditions are met.

Both are implemented in `content/browser/push_messaging/` and `content/browser/background_sync/`, integrated with the platform's push services (FCM on Android, APNs / WebPush on Apple, WNS on Windows).

### Senior Interview Material

- "What changed architecturally from Manifest V2 to V3? Why did Chrome force the migration?"
- "Walk me through what an isolated world is, and the threat model it addresses."
- "Why does an MV3 service worker get torn down so aggressively, and what does that imply for extension state?"
- "What is a Trusted Web Activity, and why would a publisher use it instead of an Android-native app?"
- "How does Chrome implement OS-level file handler registration for PWAs?"

The next section opens up the developer-facing surface of the browser: DevTools and the CDP.

---
