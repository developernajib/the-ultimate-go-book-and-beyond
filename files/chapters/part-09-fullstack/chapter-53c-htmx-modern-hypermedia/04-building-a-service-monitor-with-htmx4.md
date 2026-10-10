## 53C.4 Building an Application with Go and htmx 4: Live Service Monitor

To see how these concepts come together in production code, we will build a complete **Live Service and Incident Monitor**.

This application demonstrates the signature patterns of htmx 4:

1. **Debounced Live Search:** Filters table rows without client-side JavaScript.
2. **Inline State Transitions:** Toggles service operational health and replaces the row.
3. **Multi-Target Updates via `<hx-partial>`:** Updates both the service row and the top-level incident metric badge in one HTTP response.
4. **Form Validation with HTTP 422:** Renders validation errors in place without custom client error handlers.
5. **Morphing Swaps (`hx-swap="morph"`):** Maintains table scroll and focus states during background refreshes.

---

### 1. Data Model and In-Memory Store

```go
// main.go
package main

import (
    "fmt"
    "html/template"
    "log"
    "net/http"
    "strconv"
    "strings"
    "sync"
    "time"
)

type ServiceStatus string

const (
    StatusHealthy  ServiceStatus = "HEALTHY"
    StatusDegraded ServiceStatus = "DEGRADED"
    StatusDown     ServiceStatus = "DOWN"
)

type Service struct {
    ID        int
    Name      string
    Endpoint  string
    LatencyMs int
    Status    ServiceStatus
    UpdatedAt time.Time
}

type Store struct {
    mu       sync.RWMutex
    services map[int]Service
    nextID   int
}

func NewStore() *Store {
    s := &Store{
        services: make(map[int]Service),
        nextID:   1,
    }
    // Seed initial production telemetry
    s.Add("Authentication Gateway", "https://auth.internal:8443", 24, StatusHealthy)
    s.Add("Payment Processing Service", "https://pay.internal:9000", 185, StatusDegraded)
    s.Add("Order Execution Engine", "https://orders.internal:7001", 12, StatusHealthy)
    s.Add("Customer Notification Bus", "https://notify.internal:5500", 410, StatusDown)
    return s
}

func (s *Store) Add(name, endpoint string, latency int, status ServiceStatus) Service {
    s.mu.Lock()
    defer s.mu.Unlock()
    svc := Service{
        ID:        s.nextID,
        Name:      name,
        Endpoint:  endpoint,
        LatencyMs: latency,
        Status:    status,
        UpdatedAt: time.Now(),
    }
    s.services[s.nextID] = svc
    s.nextID++
    return svc
}

func (s *Store) List(filter string) []Service {
    s.mu.RLock()
    defer s.mu.RUnlock()
    var out []Service
    f := strings.ToLower(strings.TrimSpace(filter))
    for _, svc := range s.services {
        if f == "" || strings.Contains(strings.ToLower(svc.Name), f) || strings.Contains(strings.ToLower(svc.Endpoint), f) {
            out = append(out, svc)
        }
    }
    return out
}

func (s *Store) ToggleStatus(id int) (Service, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()
    svc, ok := s.services[id]
    if !ok {
        return Service{}, false
    }
    switch svc.Status {
    case StatusHealthy:
        svc.Status = StatusDegraded
    case StatusDegraded:
        svc.Status = StatusDown
    case StatusDown:
        svc.Status = StatusHealthy
    }
    svc.UpdatedAt = time.Now()
    s.services[id] = svc
    return svc, true
}

func (s *Store) IncidentCount() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    count := 0
    for _, svc := range s.services {
        if svc.Status != StatusHealthy {
            count++
        }
    }
    return count
}
```

---

### 2. Complete Server Implementation

The server defines clean route handlers using Go 1.22 path routing. It parses both full-page and partial template views:

```go
type Server struct {
    store     *Store
    templates *template.Template
}

func NewServer() *Server {
    tmpl := template.Must(template.New("").Parse(htmlTemplates))
    return &Server{
        store:     NewStore(),
        templates: tmpl,
    }
}

func (s *Server) Routes() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("GET /", s.handleIndex)
    mux.HandleFunc("GET /services", s.handleListServices)
    mux.HandleFunc("POST /services", s.handleCreateService)
    mux.HandleFunc("POST /services/{id}/toggle", s.handleToggleStatus)
    return mux
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
    if r.URL.Path != "/" {
        http.NotFound(w, r)
        return
    }
    data := map[string]any{
        "Services":      s.store.List(""),
        "IncidentCount": s.store.IncidentCount(),
    }
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    s.templates.ExecuteTemplate(w, "index", data)
}

func (s *Server) handleListServices(w http.ResponseWriter, r *http.Request) {
    query := r.URL.Query().Get("q")
    services := s.store.List(query)
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    s.templates.ExecuteTemplate(w, "service_rows", services)
}

func (s *Server) handleCreateService(w http.ResponseWriter, r *http.Request) {
    if err := r.ParseForm(); err != nil {
        http.Error(w, "Invalid form data", http.StatusBadRequest)
        return
    }

    name := strings.TrimSpace(r.PostFormValue("name"))
    endpoint := strings.TrimSpace(r.PostFormValue("endpoint"))

    // Validation check: return HTTP 422 with in-place error message
    if name == "" || endpoint == "" {
        w.WriteHeader(http.StatusUnprocessableEntity)
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        s.templates.ExecuteTemplate(w, "service_form_error", map[string]string{
            "Error":    "Both service name and endpoint are required.",
            "Name":     name,
            "Endpoint": endpoint,
        })
        return
    }

    s.store.Add(name, endpoint, 15, StatusHealthy)

    // On success, reset the form and refresh rows via HX-Trigger
    w.Header().Set("HX-Trigger", "serviceListChanged")
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    s.templates.ExecuteTemplate(w, "service_form_clean", nil)
}

func (s *Server) handleToggleStatus(w http.ResponseWriter, r *http.Request) {
    idStr := r.PathValue("id")
    id, err := strconv.Atoi(idStr)
    if err != nil {
        http.Error(w, "Invalid service ID", http.StatusBadRequest)
        return
    }

    svc, ok := s.store.ToggleStatus(id)
    if !ok {
        http.NotFound(w, r)
        return
    }

    w.Header().Set("Content-Type", "text/html; charset=utf-8")

    // htmx 4 Multi-Target Swap: Return row update AND incident badge in one payload
    data := struct {
        Service       Service
        IncidentCount int
    }{
        Service:       svc,
        IncidentCount: s.store.IncidentCount(),
    }

    s.templates.ExecuteTemplate(w, "multi_target_toggle", data)
}
```

---

### 3. Hypermedia Templates with htmx 4 Directives

Notice the key htmx 4 features utilized below:

1. `hx-trigger="keyup changed delay:300ms, search"` on the search box.
2. `hx-swap="morph"` on the table body to avoid flickering.
3. `<hx-partial>` tags in the toggle response to update both the row and the navigation badge simultaneously.

```go
const htmlTemplates = `
{{define "index"}}
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloud Infrastructure Telemetry</title>
  <script src="https://unpkg.com/htmx.org@next"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; }
    .container { max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; margin-bottom: 2rem; }
    .badge { padding: 0.35rem 0.75rem; border-radius: 9999px; font-weight: 600; font-size: 0.875rem; }
    .badge-ok { background: #065f46; color: #34d399; }
    .badge-warn { background: #92400e; color: #fbbf24; }
    .badge-err { background: #991b1b; color: #f87171; }
    .search-bar { display: flex; gap: 1rem; align-items: center; margin-bottom: 1.5rem; }
    input[type="text"] { background: #1e293b; border: 1px solid #475569; color: #fff; padding: 0.6rem 1rem; border-radius: 6px; width: 100%; box-sizing: border-box; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; margin-bottom: 2rem; }
    th, td { padding: 1rem; text-align: left; border-bottom: 1px solid #334155; }
    th { background: #0f172a; color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; }
    .btn { background: #2563eb; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.875rem; font-weight: 500; }
    .btn-toggle { background: #334155; }
    .btn-toggle:hover { background: #475569; }
    .spinner { display: none; color: #38bdf8; font-size: 0.875rem; }
    .htmx-request.spinner { display: inline-block; }
    .form-panel { background: #1e293b; padding: 1.5rem; border-radius: 8px; border: 1px solid #334155; }
    .error-box { background: #7f1d1d; color: #fecaca; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div>
        <h1 style="margin: 0; font-size: 1.5rem;">Infrastructure Health Monitor</h1>
        <small style="color: #94a3b8;">htmx 4 Hypermedia Architecture</small>
      </div>
      <div>
        <span id="incident-badge" class="badge {{if eq .IncidentCount 0}}badge-ok{{else}}badge-err{{end}}">
          {{.IncidentCount}} Active Incidents
        </span>
      </div>
    </div>

    <!-- Live Search with 300ms Debounce -->
    <div class="search-bar">
      <input type="text"
             name="q"
             placeholder="Filter services by name or endpoint..."
             hx-get="/services"
             hx-trigger="keyup changed delay:300ms, search"
             hx-target="#service-tbody"
             hx-indicator="#search-spinner"
             hx-swap="morph">
      <span id="search-spinner" class="spinner">Searching...</span>
    </div>

    <!-- Telemetry Table -->
    <table>
      <thead>
        <tr>
          <th>Service Name</th>
          <th>Endpoint</th>
          <th>Latency</th>
          <th>Health Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="service-tbody" hx-trigger="serviceListChanged from:body" hx-get="/services" hx-swap="morph">
        {{template "service_rows" .Services}}
      </tbody>
    </table>

    <!-- Service Registration Form with HTTP 422 Error Target -->
    <div class="form-panel">
      <h3 style="margin-top: 0; font-size: 1.1rem;">Register Internal Service</h3>
      <div id="form-container">
        {{template "service_form_clean" nil}}
      </div>
    </div>
  </div>
</body>
</html>
{{end}}

{{define "service_rows"}}
  {{range .}}
    {{template "single_service_row" .}}
  {{else}}
    <tr>
      <td colspan="5" style="text-align: center; color: #64748b; padding: 2rem;">No matching services found.</td>
    </tr>
  {{end}}
{{end}}

{{define "single_service_row"}}
<tr id="service-row-{{.ID}}">
  <td style="font-weight: 600;">{{.Name}}</td>
  <td style="color: #94a3b8; font-family: monospace;">{{.Endpoint}}</td>
  <td>{{.LatencyMs}} ms</td>
  <td>
    <span class="badge {{if eq .Status "HEALTHY"}}badge-ok{{else if eq .Status "DEGRADED"}}badge-warn{{else}}badge-err{{end}}">
      {{.Status}}
    </span>
  </td>
  <td>
    <button class="btn btn-toggle"
            hx-post="/services/{{.ID}}/toggle"
            hx-swap="morph">
      Cycle Health
    </button>
  </td>
</tr>
{{end}}

{{define "multi_target_toggle"}}
  <!-- htmx 4 native multi-target partials -->
  <hx-partial target="#service-row-{{.Service.ID}}">
    {{template "single_service_row" .Service}}
  </hx-partial>

  <hx-partial target="#incident-badge">
    <span id="incident-badge" class="badge {{if eq .IncidentCount 0}}badge-ok{{else}}badge-err{{end}}">
      {{.IncidentCount}} Active Incidents
    </span>
  </hx-partial>
{{end}}

{{define "service_form_clean"}}
<form hx-post="/services" hx-target="#form-container" hx-swap="outerHTML">
  <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
    <input type="text" name="name" placeholder="Service Name (e.g. Ingestion Pipeline)" style="flex: 1;">
    <input type="text" name="endpoint" placeholder="Endpoint URL" style="flex: 1;">
  </div>
  <button type="submit" class="btn">Register Service</button>
</form>
{{end}}

{{define "service_form_error"}}
<div id="form-container">
  <div class="error-box">{{.Error}}</div>
  <form hx-post="/services" hx-target="#form-container" hx-swap="outerHTML">
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
      <input type="text" name="name" value="{{.Name}}" placeholder="Service Name" style="flex: 1;">
      <input type="text" name="endpoint" value="{{.Endpoint}}" placeholder="Endpoint URL" style="flex: 1;">
    </div>
    <button type="submit" class="btn">Register Service</button>
  </form>
</div>
{{end}}
`

func main() {
    srv := NewServer()
    log.Println("Telemetry monitor running at http://localhost:8080")
    if err := http.ListenAndServe(":8080", srv.Routes()); err != nil {
        log.Fatalf("Server startup failed: %v", err)
    }
}
```

---

### Running and Verifying the System

To run this application locally:

```bash
go run main.go
```

Open `http://localhost:8080` in your browser. Inspect the Network tab in DevTools:

1. Typing into the search input sends debounced `GET /services?q=...` requests. The response payload is just the table rows (under 1 KB), swapped smoothly into the DOM.
2. Clicking **Cycle Health** sends `POST /services/{id}/toggle`. The response payload uses `<hx-partial>` tags. Notice that the specific row updates its badge color, and the top-right **Active Incidents** header badge increments or decrements in the exact same render step.
3. Submitting an empty registration form returns an HTTP 422 status. htmx 4 automatically swaps the error banner directly into the form container without resetting other fields.
