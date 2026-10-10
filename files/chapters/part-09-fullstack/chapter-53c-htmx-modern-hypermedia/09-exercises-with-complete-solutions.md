## 53C.9 Hands-On Exercises with Complete Solutions

These hands-on exercises build practical proficiency in hypermedia development with Go and htmx 4.

---

### Exercise 1: Inline Table Cell Editing

#### Problem Statement
Build an inline editable configuration parameter table. When a user clicks an "Edit" button on any row, that specific table cell transforms into an HTML `<input>` field with "Save" and "Cancel" buttons. Saving updates the in-memory record and swaps the row back to read-only view. Canceling reverts to the original value without server mutation.

#### Solution Implementation

```go
package main

import (
    "fmt"
    "html/template"
    "net/http"
    "strconv"
    "sync"
)

type ConfigItem struct {
    ID    int
    Key   string
    Value string
}

type ConfigStore struct {
    mu    sync.RWMutex
    items map[int]ConfigItem
}

var store = &ConfigStore{
    items: map[int]ConfigItem{
        1: {ID: 1, Key: "MAX_DATABASE_CONNECTIONS", Value: "50"},
        2: {ID: 2, Key: "RATE_LIMIT_PER_MINUTE", Value: "1200"},
    },
}

func handleGetRow(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.Atoi(r.PathValue("id"))
    store.mu.RLock()
    item := store.items[id]
    store.mu.RUnlock()

    renderReadOnlyRow(w, item)
}

func handleEditRow(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.Atoi(r.PathValue("id"))
    store.mu.RLock()
    item := store.items[id]
    store.mu.RUnlock()

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    fmt.Fprintf(w, `
<tr id="row-%d">
  <td><strong>%s</strong></td>
  <td>
    <form hx-put="/config/%d" hx-target="#row-%d" hx-swap="outerHTML" style="display: flex; gap: 0.5rem;">
      <input type="text" name="value" value="%s" required>
      <button type="submit" class="btn-save">Save</button>
      <button type="button" hx-get="/config/%d" hx-target="#row-%d" hx-swap="outerHTML">Cancel</button>
    </form>
  </td>
</tr>`, item.ID, item.Key, item.ID, item.ID, template.HTMLEscapeString(item.Value), item.ID, item.ID)
}

func handleSaveRow(w http.ResponseWriter, r *http.Request) {
    id, _ := strconv.Atoi(r.PathValue("id"))
    newValue := r.PostFormValue("value")

    store.mu.Lock()
    item := store.items[id]
    item.Value = newValue
    store.items[id] = item
    store.mu.Unlock()

    renderReadOnlyRow(w, item)
}

func renderReadOnlyRow(w http.ResponseWriter, item ConfigItem) {
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    fmt.Fprintf(w, `
<tr id="row-%d">
  <td>%s</td>
  <td>
    <span>%s</span>
    <button hx-get="/config/%d/edit" hx-target="#row-%d" hx-swap="outerHTML" style="margin-left: 1rem;">
      Edit
    </button>
  </td>
</tr>`, item.ID, template.HTMLEscapeString(item.Key), template.HTMLEscapeString(item.Value), item.ID, item.ID)
}
```

---

### Exercise 2: Cascading Multi-Tier Selects

#### Problem Statement
Create a three-tier dependent dropdown hierarchy for infrastructure management:
1. Region selection (`us-east-1`, `eu-west-1`) loads available Clusters.
2. Cluster selection loads available Worker Pools.
3. If the user changes the Region, both downstream dropdowns must reset to empty states.

#### Solution Implementation

```go
package main

import (
    "fmt"
    "net/http"
)

func handleClusters(w http.ResponseWriter, r *http.Request) {
    region := r.URL.Query().Get("region")
    w.Header().Set("Content-Type", "text/html; charset=utf-8")

    if region == "" {
        fmt.Fprintln(w, `<option value="">Select a region first</option>`)
        return
    }

    clusters := map[string][]string{
        "us-east-1": {"prod-alpha-use1", "prod-beta-use1"},
        "eu-west-1": {"prod-prod-euw1", "dr-standby-euw1"},
    }[region]

    fmt.Fprintln(w, `<option value="">Select Cluster</option>`)
    for _, c := range clusters {
        fmt.Fprintf(w, `<option value="%s">%s</option>`+"\n", c, c)
    }
}

func handlePools(w http.ResponseWriter, r *http.Request) {
    cluster := r.URL.Query().Get("cluster")
    w.Header().Set("Content-Type", "text/html; charset=utf-8")

    if cluster == "" {
        fmt.Fprintln(w, `<option value="">Select a cluster first</option>`)
        return
    }

    pools := []string{"compute-optimized-c6i", "memory-heavy-r6i", "gpu-training-g5"}
    fmt.Fprintln(w, `<option value="">Select Node Pool</option>`)
    for _, p := range pools {
        fmt.Fprintf(w, `<option value="%s">%s</option>`+"\n", p, p)
    }
}
```

#### Frontend Template

```html
<div class="cascading-selects">
  <label>Region:</label>
  <select name="region" 
          hx-get="/api/clusters" 
          hx-target="#cluster-select" 
          hx-trigger="change">
    <option value="">Select Region</option>
    <option value="us-east-1">US East (N. Virginia)</option>
    <option value="eu-west-1">EU (Ireland)</option>
  </select>

  <label>Cluster:</label>
  <select id="cluster-select" 
          name="cluster" 
          hx-get="/api/pools" 
          hx-target="#pool-select" 
          hx-trigger="change">
    <option value="">Select a region first</option>
  </select>

  <label>Worker Node Pool:</label>
  <select id="pool-select" name="pool">
    <option value="">Select a cluster first</option>
  </select>
</div>
```

---

### Exercise 3: Multi-Target Alert Dismissal via `<hx-partial>`

#### Problem Statement
Build an alert center where clicking "Acknowledge" on an alert:
1. Deletes the alert card from the list.
2. Updates the global unread alert counter in the header in the same network response using htmx 4 `<hx-partial>`.

#### Solution Implementation

```go
func (s *AlertServer) handleDismissAlert(w http.ResponseWriter, r *http.Request) {
    alertID := r.PathValue("id")
    s.store.Dismiss(alertID)
    remainingCount := s.store.ActiveCount()

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    
    // htmx 4 Multi-target partial response
    fmt.Fprintf(w, `
<hx-partial target="#alert-%s" hx-swap="delete"></hx-partial>

<hx-partial target="#header-alert-count">
  <span id="header-alert-count" class="badge">
    %d Active
  </span>
</hx-partial>`, alertID, remainingCount)
}
```

---

### Exercise 4: Real-Time SSE Health Stream with Fallback

#### Problem Statement
Implement a unidirectional Server-Sent Events health stream. If SSE fails to connect or drops, provide a manual refresh fallback button that queries the same status endpoint over standard HTTP.

#### Solution Implementation

```go
func handleHealthSSE(w http.ResponseWriter, r *http.Request) {
    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-r.Context().Done():
            return
        case <-ticker.C:
            memUsage := getSystemMemoryUsageMB()
            fmt.Fprintf(w, "event: memoryMetric\ndata: <div id='mem-metric'>Memory Usage: %d MB</div>\n\n", memUsage)
            flusher.Flush()
        }
    }
}
```

```html
<div class="metrics-panel">
  <!-- SSE Stream container -->
  <div hx-ext="sse" sse-connect="/stream/health" sse-swap="memoryMetric">
    <div id="mem-metric">Connecting to telemetry stream...</div>
  </div>

  <!-- Manual fallback button if client blocks SSE -->
  <button hx-get="/api/health/memory" 
          hx-target="#mem-metric" 
          hx-swap="outerHTML" 
          class="btn-fallback">
    Refresh Manually
  </button>
</div>
```
