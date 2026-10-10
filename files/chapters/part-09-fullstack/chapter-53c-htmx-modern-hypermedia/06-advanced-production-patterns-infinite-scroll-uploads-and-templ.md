## 53C.6 Advanced Production Patterns: Infinite Scroll, Cascading Selects, and Templ

Production applications demand more than basic button swaps. This section details five advanced hypermedia patterns implemented in Go: infinite scrolling, cascading dependent selects, file uploads with progress indication, type-safe HTML with Templ, and CSRF protection.

---

### 1. Infinite Scroll with `hx-trigger="revealed"`

Infinite scrolling appends records as the user reaches the bottom of a list. In a React application, this requires an `IntersectionObserver`, complex cursor state in Redux, and manual array concatenation.

In htmx 4, infinite scroll requires one attribute: `hx-trigger="revealed"`.

```html
<!-- Table rows rendered by the server -->
<tr id="service-row-49">
    <td>Worker Node 49</td>
    <td>Online</td>
</tr>

<!-- The 50th row carries the trigger for the next page -->
<tr id="service-row-50" hx-get="/services?page=2" hx-trigger="revealed" hx-swap="afterend">
    <td>Worker Node 50</td>
    <td>Online</td>
</tr>
```

When the browser viewport scrolls down until `service-row-50` becomes visible, htmx automatically fires `GET /services?page=2`. The Go server renders rows 51 through 100. The last row in that batch (row 100) carries `hx-get="/services?page=3"`.

#### The Go Backend Implementation

```go
func (s *Server) handleInfiniteScroll(w http.ResponseWriter, r *http.Request) {
    pageStr := r.URL.Query().Get("page")
    page, err := strconv.Atoi(pageStr)
    if err != nil || page < 1 {
        page = 1
    }

    const pageSize = 50
    items, hasMore := s.store.FetchPage(page, pageSize)

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    for i, item := range items {
        isLastItem := (i == len(items)-1) && hasMore
        if isLastItem {
            // Render row with revealed trigger pointing to the next page
            fmt.Fprintf(w, `<tr id="item-%d" hx-get="/services?page=%d" hx-trigger="revealed" hx-swap="afterend"><td>%s</td></tr>`,
                item.ID, page+1, template.HTMLEscapeString(item.Name))
        } else {
            // Render standard table row
            fmt.Fprintf(w, `<tr id="item-%d"><td>%s</td></tr>`, item.ID, template.HTMLEscapeString(item.Name))
        }
    }
}
```

This pattern eliminates client state. When the database runs out of items (`hasMore == false`), the server omits the `hx-trigger` attribute on the final row, cleanly terminating the scroll chain.

---

### 2. Cascading Dependent Selects

Administrative forms frequently require dependent selections: choosing an AWS Region dynamically populates the available VPC networks, which in turn filters the subnet dropdown.

```
+------------------+         +------------------+         +------------------+
| Region: [ us-east-1 ] ---> | VPC: [ vpc-prod-01 ] ---> | Subnet: [ sn-app-a ]
+------------------+         +------------------+         +------------------+
         |                            |
         | GET /vpcs?region=us-east-1 | GET /subnets?vpc=vpc-prod-01
         v                            v
    Swaps #vpc-select            Swaps #subnet-select
```

#### Frontend HTML

```html
<form class="config-form">
    <label for="region">AWS Region</label>
    <select id="region" name="region" hx-get="/vpcs" hx-target="#vpc-select" hx-swap="outerHTML">
        <option value="">Select Region</option>
        <option value="us-east-1">US East (N. Virginia)</option>
        <option value="eu-west-1">EU (Ireland)</option>
    </select>

    <label for="vpc-select">VPC Network</label>
    <select id="vpc-select" name="vpc_id" disabled>
        <option value="">Select a region first</option>
    </select>
</form>
```

#### The Go Handler

```go
func (s *Server) handleListVPCs(w http.ResponseWriter, r *http.Request) {
    region := r.URL.Query().Get("region")
    vpcs := s.cloudClient.ListVPCsByRegion(region)

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    fmt.Fprintln(w, `<select id="vpc-select" name="vpc_id" hx-get="/subnets" hx-target="#subnet-select" hx-swap="outerHTML">`)
    fmt.Fprintln(w, `  <option value="">Select VPC</option>`)
    for _, vpc := range vpcs {
        fmt.Fprintf(w, `  <option value="%s">%s (%s)</option>`+"\n", vpc.ID, template.HTMLEscapeString(vpc.Name), vpc.CIDR)
    }
    fmt.Fprintln(w, `</select>`)
}
```

The user selects a region, and htmx swaps in the active VPC dropdown. The newly inserted dropdown already contains its own `hx-get="/subnets"` directive, allowing the cascade to continue down any depth without client state coordination.

---

### 3. File Uploads with Native Progress Indication

Uploading diagnostic logs or configuration archives does not require third-party JavaScript drag-and-drop packages. Standard HTML file inputs combined with htmx 4 handle multipart uploads natively:

```html
<form
    hx-post="/diagnostics/upload"
    hx-encoding="multipart/form-data"
    hx-target="#upload-status"
    hx-indicator="#upload-progress"
>
    <input type="file" name="diagnostic_bundle" required />
    <button type="submit" class="btn">Upload Bundle</button>

    <div id="upload-progress" class="htmx-indicator progress-bar">
        <span>Uploading file to storage cluster...</span>
    </div>
</form>

<div id="upload-status"></div>
```

#### Go Multipart Processing

```go
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
    // Limit payload size to 32 MB in memory
    const maxMemory = 32 << 20
    if err := r.ParseMultipartForm(maxMemory); err != nil {
        w.WriteHeader(http.StatusRequestEntityTooLarge)
        fmt.Fprintf(w, `<div class="error">File exceeds maximum size of 32MB</div>`)
        return
    }

    file, header, err := r.FormFile("diagnostic_bundle")
    if err != nil {
        w.WriteHeader(http.StatusBadRequest)
        fmt.Fprintf(w, `<div class="error">Failed to read uploaded file</div>`)
        return
    }
    defer file.Close()

    storedPath, err := s.storage.Save(header.Filename, file)
    if err != nil {
        w.WriteHeader(http.StatusInternalServerError)
        fmt.Fprintf(w, `<div class="error">Storage failure: %s</div>`, template.HTMLEscapeString(err.Error()))
        return
    }

    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, `<div class="success">Diagnostic bundle stored at %s</div>`, template.HTMLEscapeString(storedPath))
}
```

---

### 4. Type-Safe HTML Components with Templ

While Go's standard `html/template` package is fast and reliable, it lacks compile-time type validation. Mismatched field names or missing struct attributes are only caught when executing the template at runtime.

The Go ecosystem has standardized on **Templ** (`github.com/a-h/templ`) for production hypermedia systems. Templ compiles `.templ` files into standard Go code, providing complete compile-time type safety and instant autocomplete in Go IDEs.

#### Defining a Templ Component

```templ
// components/service_card.templ
package components

type ServiceViewModel struct {
    ID     int
    Name   string
    Status string
}

templ ServiceRow(svc ServiceViewModel) {
    <tr id={ fmt.Sprintf("svc-%d", svc.ID) }>
        <td class="font-bold">{ svc.Name }</td>
        <td>
            <span class={ "badge", templ.KV("badge-ok", svc.Status == "HEALTHY") }>
                { svc.Status }
            </span>
        </td>
        <td>
            <button
                hx-post={ fmt.Sprintf("/services/%d/restart", svc.ID) }
                hx-target={ fmt.Sprintf("#svc-%d", svc.ID) }
                hx-swap="outerHTML">
                Restart
            </button>
        </td>
    </tr>
}
```

#### Rendering Templ Components in a Go Handler

```go
func (s *Server) handleRestartService(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.Atoi(r.PathValue("id"))
    svc := s.store.Restart(id)

    viewModel := components.ServiceViewModel{
        ID:     svc.ID,
        Name:   svc.Name,
        Status: svc.Status,
    }

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    // Render directly into the http.ResponseWriter
    components.ServiceRow(viewModel).Render(r.Context(), w)
}
```

Templ turns HTML generation into plain Go function calls. If you rename a struct field in your Go domain model, the Go compiler refuses to build until every template using that field is updated.

---

### 5. CSRF Protection Middleware for Hypermedia

State-changing HTTP requests (`POST`, `PUT`, `DELETE`) require cross-site request forgery protection. In htmx, configure a global event listener to attach the CSRF header to every outgoing request:

```html
<script>
    document.addEventListener('htmx:config:request', (event) => {
        // Inject CSRF token from meta tag into request headers
        const token = document.querySelector('meta[name="csrf-token"]').getAttribute('content')
        event.detail.headers['X-CSRF-Token'] = token
    })
</script>
```

#### Go CSRF Validation Middleware

```go
func CSRFMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Safe methods do not modify state
        if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
            next.ServeHTTP(w, r)
            return
        }

        token := r.Header.Get("X-CSRF-Token")
        if token == "" {
            token = r.PostFormValue("csrf_token")
        }

        if !isValidCSRFToken(r.Context(), token) {
            http.Error(w, "Invalid or missing CSRF token", http.StatusForbidden)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```
