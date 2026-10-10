## 53C.1 The Hypermedia Philosophy and htmx 4 Architecture

To understand htmx, you must understand the architectural idea that originally made the web successful: Hypermedia as the Engine of Application State (HATEOAS).

In the original web architecture, when a client transitions from one application state to another, the server sends a new hypermedia representation (HTML). That representation contains both the data and the valid actions available to the user, encoded as links (`<a href="...">`) and forms (`<form action="..." method="...">`). The browser does not need to know the business rules or the schema of the database. The browser renders the HTML, displays available controls, and sends the user's action back to the server when clicked or submitted.

```
+-------------------------------------------------------------------+
| Hypermedia Flow (HATEOAS)                                         |
|                                                                   |
| [ Client Browser ]                                                |
|         |                                                         |
|         | 1. HTTP GET /invoices/42                                |
|         v                                                         |
| [ Go Web Server ]                                                 |
|         |                                                         |
|         | 2. Checks permissions, inspects status: "unpaid"        |
|         | 3. Generates HTML containing:                           |
|         |    - Invoice summary data                               |
|         |    - Action button: <button hx-post="/invoices/42/pay"> |
|         v                                                         |
| [ Client Browser ]                                                |
|         | Renders button because server permitted the action      |
+-------------------------------------------------------------------+
```

Contrast this with the modern Single Page Application pattern. An SPA downloads a large JavaScript bundle that implements a client-side state machine. The client fetches raw JSON data from the backend, then runs local logic:

```typescript
// Traditional SPA anti-pattern: duplicated state rules in browser
if (user.role === 'admin' && invoice.status === 'unpaid' && !invoice.isLocked) {
    renderPayButton()
}
```

This model duplicates business logic across two languages and two codebases. When the server business logic changes, the frontend code drifts out of alignment unless both deployments synchronize perfectly.

### The Limitations of Plain HTML

Plain HTML has two major limitations that originally pushed developers toward JavaScript frameworks:

1. Only `<a>` and `<form>` elements can initiate HTTP network requests.
2. Only `GET` and `POST` methods are supported in HTML forms (`PUT`, `PATCH`, and `DELETE` require JavaScript).
3. Every user action replaces the entire browser screen, causing layout flickering and losing local scroll position.

htmx removes these arbitrary limitations. It allows any HTML element (such as a `<div>`, `<button>`, or `<input>`) to issue any HTTP request (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) triggered by any browser event (`click`, `change`, `keyup`, `intersect`), and swap the resulting HTML fragment into any targeted DOM element.

```html
<!-- Any element, any HTTP verb, targeted DOM swap -->
<button hx-delete="/api/v1/sessions/current" hx-target="#session-panel" hx-swap="outerHTML">
    Revoke Session
</button>
```

---

### What Is New in htmx 4

On August 28, 2026, the htmx project released version 4.0.0. The release skipped version 3 entirely. The creator of htmx, Carson Gross, had declared during the 2.x lifecycle that there would never be an htmx 3. The project honored that commitment by advancing directly from version 2 to 4.

htmx 4 represents a complete internal rewrite that modernizes the library for contemporary web standards.

#### 1. Native `fetch()` Replaces `XMLHttpRequest`

For over a decade, hypermedia libraries relied on `XMLHttpRequest` (XHR) for browser compatibility. htmx 4 shifts the internal network transport entirely to the browser native `fetch()` API.

This change delivers three technical improvements:

- **Streaming Support:** Responses can begin processing before the full HTTP payload finishes downloading.
- **Native AbortController Integration:** In-flight network requests cancel cleanly when replacement actions trigger, reducing wasted server compute.
- **Modern DevTools Visibility:** Network requests register natively with modern browser service workers and debugging panels without XHR polyfill layers.

#### 2. Explicit Attribute Inheritance (`:inherited`)

In htmx 1 and 2, attributes placed on parent containers implicitly inherited down through all child elements. While convenient for small components, this behavior created bugs in large enterprise applications. A parent container with `hx-target="#content"` would silently override targets on deeply nested widgets unless explicitly cleared with `hx-target="this"`.

htmx 4 eliminates implicit inheritance. Attributes only cascade to child elements when explicitly designated with the `:inherited` modifier:

```html
<!-- In htmx 4, inheritance must be explicit -->
<div hx-confirm:inherited="Are you sure you want to proceed?" hx-target:inherited="#audit-log">
    <!-- Both buttons inherit confirmation and target -->
    <button hx-post="/action/run">Run Job</button>
    <button hx-post="/action/cancel">Cancel Job</button>

    <!-- Without :inherited, attributes apply only to the element declaring them -->
    <div hx-indicator="#custom-spinner">
        <button hx-post="/action/fast">Fast Action</button>
    </div>
</div>
```

#### 3. Default Swapping on 4xx and 5xx Status Codes

In htmx 1 and 2, HTTP responses with error status codes (such as `400 Bad Request` or `422 Unprocessable Entity`) did not trigger DOM swaps by default. Developers had to install custom JavaScript extensions or catch `htmx:beforeOnLoad` events to render server-side form validation errors.

htmx 4 inverts this behavior. HTTP error responses now swap into the target DOM element by default. When a user submits an invalid form, your Go handler can return HTTP `422 Unprocessable Entity` containing the form HTML with validation messages highlighted. The browser swaps the rejected form into place without special client code:

```
User Submits Form -> POST /users -> Validation Fails (missing email)
Server returns: HTTP 422 Unprocessable Entity + <form> with error banner
htmx 4: Swaps updated <form> directly into DOM
```

#### 4. Built-in Idiomorph Morphing (`hx-swap="morph"`)

Traditional DOM replacement destroys existing DOM nodes and inserts new ones. This resets text input focus, clears active scrollbars, and cancels running CSS transitions.

In htmx 2, solving this required loading the external `idiomorph` extension. htmx 4 integrates idiomorph directly into the core engine. By specifying `hx-swap="morph"`, htmx diffs the existing DOM against the incoming HTML fragment and applies targeted attribute and node mutations in place:

```html
<!-- Preserves cursor position, focus, and open dropdowns during live updates -->
<div id="service-list" hx-get="/api/services" hx-trigger="every 10s" hx-swap="morph">
    <!-- Dynamic server-rendered rows -->
</div>
```

#### 5. Multi-Target Responses via `<hx-partial>`

Applications frequently need one user interaction to update two or three distinct parts of the page simultaneously. For example, deleting a table row must remove the row itself and decrement an unread count badge in the navigation bar.

Previous versions relied on Out-of-Band (`hx-swap-oob="true"`) attributes, which required mixing global layout IDs into targeted component responses. htmx 4 introduces the native `<hx-partial>` element:

```html
<!-- Backend response to POST /api/notifications/clear-all -->
<hx-partial target="#notification-list">
    <div class="empty-state">No pending alerts.</div>
</hx-partial>

<hx-partial target="#unread-badge">
    <span class="badge badge-zero">0</span>
</hx-partial>
```

htmx 4 parses each partial block and applies the swap directly to its designated target selector in a single browser render cycle.

#### 6. Standardized Event Lifecycle

htmx 4 standardizes all lifecycle events into a clean `htmx:phase:action` naming convention:

- `htmx:before:request` replaces `htmx:beforeRequest`
- `htmx:after:request` replaces `htmx:afterRequest`
- `htmx:before:swap` replaces `htmx:beforeSwap`
- `htmx:after:swap` replaces `htmx:afterSwap`

Teams upgrading existing applications can include the official `htmx-2-compat` extension during migration.
