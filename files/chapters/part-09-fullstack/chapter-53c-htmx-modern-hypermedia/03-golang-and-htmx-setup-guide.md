## 53C.3 Setting Up a Go Backend with htmx 4

Setting up a Go application with htmx requires no external build tools. Standard Go 1.22+ routing patterns and the standard library `html/template` package provide a complete foundation for production systems.

---

### Project Structure

A clean, production-ready directory layout organizes templates into layouts and reusable partials:

```
monitor-app/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── handlers/
│   │   ├── monitor.go
│   │   └── templates.go
│   └── store/
│       └── memory.go
├── static/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── htmx.min.js
├── templates/
│   ├── layouts/
│   │   └── base.html
│   └── partials/
│       ├── incident_list.html
│       ├── incident_row.html
│       ├── stats_badge.html
│       └── create_modal.html
├── go.mod
└── Makefile
```

---

### Loading htmx 4 in Your Frontend

You can load htmx 4 using a CDN or vendor it directly into your Go binary.

#### Option 1: Unpkg CDN

During early prototyping, include htmx 4 from the npm `next` distribution:

```html
<!-- Load htmx 4 from npm next tag -->
<script src="https://unpkg.com/htmx.org@next"></script>
```

#### Option 2: Vendored with `go:embed` (Recommended for Production)

For production deployments, vendor the minified script directly inside your binary. This guarantees that your application runs without third-party network dependencies or CDN outages:

```go
package main

import (
    "embed"
    "net/http"
)

//go:embed static/*
var staticFS embed.FS

func setupStaticRoutes(mux *http.ServeMux) {
    fileServer := http.FileServer(http.FS(staticFS))
    mux.Handle("GET /static/", fileServer)
}
```

In your base template:

```html
<script src="/static/js/htmx.min.js"></script>
```

---

### The `HX-Request` Header Pattern

The most critical architectural pattern in Go plus htmx is content negotiation between full page loads and partial fragment swaps.

When a user visits a URL directly by typing it into the browser address bar or clicking a bookmark, the browser sends a standard HTTP request. The server must return the full HTML document including `<head>`, navigation bars, and stylesheet links.

When a user interacts with an element wired to htmx, htmx automatically includes the header:

```http
HX-Request: true
```

When this header is present, the server skips the outer page shell and renders only the specific HTML fragment needed for the swap.

Here is the production Go helper:

```go
// internal/handlers/templates.go
package handlers

import (
    "html/template"
    "io"
    "net/http"
)

// IsHTMX checks if the incoming request was initiated by an htmx client
func IsHTMX(r *http.Request) bool {
    return r.Header.Get("HX-Request") == "true"
}

type TemplateRegistry struct {
    templates *template.Template
}

func NewTemplateRegistry(pattern string) (*TemplateRegistry, error) {
    tmpl, err := template.ParseGlob(pattern)
    if err != nil {
        return nil, err
    }
    return &TemplateRegistry{templates: tmpl}, nil
}

// Render handles content negotiation automatically
func (tr *TemplateRegistry) Render(w http.ResponseWriter, r *http.Request, name string, data any) error {
    w.Header().Set("Content-Type", "text/html; charset=utf-8")

    if IsHTMX(r) {
        // Render only the partial fragment for AJAX swaps
        return tr.templates.ExecuteTemplate(w, name, data)
    }

    // Render the complete page shell for direct browser navigations
    return tr.templates.ExecuteTemplate(w, "base.html", struct {
        ContentTemplate string
        Data            any
    }{
        ContentTemplate: name,
        Data:            data,
    })
}
```

---

### Parsing Form Submissions Without JSON Overhead

In traditional React architectures, forms require JSON serialization:

```javascript
// Complex client serialization required by SPAs
const payload = {
    serviceName: formState.name,
    severity: parseInt(formState.severity, 10),
}
await fetch('/api/incidents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
})
```

With htmx, HTML forms submit standard URL-encoded form data (`application/x-www-form-urlencoded`). Go handles this natively with zero memory allocations for JSON reflection:

```go
// Standard Go handler reading native form parameters
func (h *IncidentHandler) CreateIncident(w http.ResponseWriter, r *http.Request) {
    if err := r.ParseForm(); err != nil {
        http.Error(w, "Invalid form data", http.StatusBadRequest)
        return
    }

    serviceName := r.PostFormValue("service_name")
    severity := r.PostFormValue("severity")
    description := r.PostFormValue("description")

    // Business validation logic
    if serviceName == "" {
        w.WriteHeader(http.StatusUnprocessableEntity) // HTTP 422
        h.templates.ExecuteTemplate(w, "incident_form_error.html", map[string]string{
            "Error": "Service name is required.",
        })
        return
    }

    incident := h.store.Save(serviceName, severity, description)

    // In htmx 4, return the new row directly
    w.WriteHeader(http.StatusCreated)
    h.templates.ExecuteTemplate(w, "incident_row.html", incident)
}
```

---

### HTTP Status Code Design in htmx 4

htmx 4 uses standard HTTP semantics to drive browser behavior:

| Status Code                    | Client Behavior in htmx 4                                      | Typical Go Use Case                                   |
| :----------------------------- | :------------------------------------------------------------- | :---------------------------------------------------- |
| **`200 OK`**                   | Swaps the returned HTML into the target element.               | Normal queries, data renders, and tab switches.       |
| **`201 Created`**              | Swaps the new HTML fragment into place.                        | Creation actions that return the newly added element. |
| **`204 No Content`**           | Does not alter the DOM. Keeps existing elements intact.        | Heartbeats, analytics events, background writes.      |
| **`422 Unprocessable Entity`** | Swaps the returned HTML error fragment into target by default. | Form validation failures showing field-level errors.  |
| **`400 Bad Request`**          | Swaps error template directly into target.                     | Malformed input or missing CSRF tokens.               |
| **`500 Internal Error`**       | Swaps server error banner into target.                         | Unhandled database or operational failures.           |

---

### Server-to-Client Control Headers

htmx allows your Go backend to control browser navigation and client-side events using response headers:

#### 1. Client-Side Event Dispatching (`HX-Trigger`)

When an action occurs that other components need to know about, your Go server can fire custom browser events:

```go
// Tell the browser to emit the "incidentResolved" event
w.Header().Set("HX-Trigger", "incidentResolved")
```

Any element in your HTML can listen for this event and refresh itself:

```html
<!-- Automatically refreshes when any handler returns the HX-Trigger header -->
<div id="stats-widget" hx-get="/api/stats" hx-trigger="incidentResolved from:body">
    <!-- Stats cards -->
</div>
```

#### 2. Client Navigation (`HX-Redirect` and `HX-Push-Url`)

- `HX-Push-Url: /dashboard/incidents`: Updates the browser URL bar and adds an entry to browser history without a full page reload.
- `HX-Redirect: /login`: Forces the browser to navigate to a new page, useful when an authentication session expires during an AJAX swap.
