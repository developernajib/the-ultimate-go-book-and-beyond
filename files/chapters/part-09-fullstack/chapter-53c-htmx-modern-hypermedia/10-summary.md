## 53C.10 Summary

Hypermedia architecture and **htmx 4** provide a productive alternative to Single Page Applications for data-driven systems.

### Key Architecture Takeaways

* **Server as Single Source of Truth:** Hypermedia-Driven Applications eliminate client-side state duplication. The Go server controls business state, database persistence, and user permissions in one location.
* **htmx 4 Core Capabilities:** Version 4 modernizes hypermedia development with the native browser `fetch()` API, explicit `:inherited` attribute scoping, default error swapping for HTTP 4xx and 5xx responses, built-in morphing swaps (`hx-swap="morph"`), and clean multi-target updates using `<hx-partial>`.
* **Pragmatic Technology Selection:** Reach for htmx when building CRUD systems, monitoring tools, internal portals, and administrative software. Reserve React and heavy SPA frameworks for specialized domains requiring offline synchronization, local canvas rendering, or complex client-side calculations.
* **Operational Simplicity:** Combining Go's standard library `net/http` and `html/template` or Templ with htmx produces fast, self-contained binaries with zero Node.js runtime dependencies or fragile client build chains.

Embracing hypermedia allows backend engineers to deliver modern, responsive interfaces while maintaining the simplicity and performance that make Go a premier backend platform.
