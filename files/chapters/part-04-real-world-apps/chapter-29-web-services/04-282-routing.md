## 29.2 Routing

### Standard Library Router (Go 1.22+, still the default in Go 1.27)

Go 1.22 added method-based routing and path parameters directly to the standard library's `ServeMux`. Patterns now accept an HTTP method prefix like `"GET /users/{id}"`, and the `{id}` segment is extracted via `r.PathValue("id")`. The `{path...}` wildcard captures the rest of the URL. For many applications, this eliminates the need for a third-party router entirely.

**When stdlib is enough:** simple REST APIs, low-to-medium complexity routing trees, no need for regex constraints or nested middleware groups. The stdlib mux wins on zero dependencies and no version churn. Reach for chi v5 (below) only when you need route groups with per-group middleware, or for mux-level middleware composition that the stdlib still does not provide cleanly.

```go
package main

import (
    "net/http"
)

func main() {
    mux := http.NewServeMux()

    // Exact match
    mux.HandleFunc("GET /", handleHome)

    // Path parameters (Go 1.22+)
    mux.HandleFunc("GET /users/{id}", handleGetUser)
    mux.HandleFunc("PUT /users/{id}", handleUpdateUser)
    mux.HandleFunc("DELETE /users/{id}", handleDeleteUser)

    // Wildcard
    mux.HandleFunc("GET /files/{path...}", handleFiles)

    // Method-specific
    mux.HandleFunc("POST /users", handleCreateUser)
    mux.HandleFunc("GET /users", handleListUsers)

    http.ListenAndServe(":8080", mux)
}

func handleHome(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("home"))
}

func handleGetUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    w.Write([]byte("user: " + id))
}

func handleUpdateUser(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("update user"))
}

func handleDeleteUser(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("delete user"))
}

func handleCreateUser(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("create user"))
}

func handleListUsers(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("list users"))
}

func handleFiles(w http.ResponseWriter, r *http.Request) {
    path := r.PathValue("path")
    w.Write([]byte("file: " + path))
}
```

### Chi Router

Chi is a lightweight router built on the standard `net/http` types. It adds route grouping, inline middleware, and URL parameter extraction while remaining fully compatible with `http.Handler`. The `r.Route` method nests sub-routers, so middleware applied to a group only affects routes within that group.

```go
package main

import (
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"
)

func main() {
    r := chi.NewRouter()

    // Middleware
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)
    r.Use(middleware.Timeout(60 * time.Second))

    // Routes
    r.Get("/", handleHome)

    // Route groups
    r.Route("/api", func(r chi.Router) {
        r.Use(authMiddleware)

        r.Route("/users", func(r chi.Router) {
            r.Get("/", listUsers)
            r.Post("/", createUser)

            r.Route("/{userID}", func(r chi.Router) {
                r.Get("/", getUser)
                r.Put("/", updateUser)
                r.Delete("/", deleteUser)
            })
        })

        r.Route("/posts", func(r chi.Router) {
            r.Get("/", listPosts)
            r.Post("/", createPost)
            r.Get("/{postID}", getPost)
        })
    })

    http.ListenAndServe(":8080", r)
}

func getUser(w http.ResponseWriter, r *http.Request) {
    userID := chi.URLParam(r, "userID")
    // Use userID...
}
```

### Gorilla Mux (Legacy, Use With Caution)

> **Note (April 2026):** The original `gorilla/mux` was archived in December 2022 and then revived by the Gorilla Web Toolkit community. It still works, but most new Go code in 2024-2026 picks either the stdlib mux (Go 1.22+) or chi v5. Use gorilla/mux only when you need its regex constraints or host-based routing and chi does not fit.

Gorilla Mux offers regex-based path constraints, query parameter matching, and host-based routing. The `{id:[0-9]+}` syntax restricts the `id` segment to digits at the routing layer, so handlers never receive a non-numeric value. Subrouters created with `PathPrefix` share a common path prefix and can carry their own middleware.

```go
package main

import (
    "net/http"

    "github.com/gorilla/mux"
)

func main() {
    r := mux.NewRouter()

    // Basic routes
    r.HandleFunc("/", handleHome).Methods("GET")

    // Path parameters
    r.HandleFunc("/users/{id:[0-9]+}", handleUser).Methods("GET")

    // Query parameters
    r.HandleFunc("/search", handleSearch).
        Queries("q", "{query}", "page", "{page:[0-9]+}")

    // Subrouters
    api := r.PathPrefix("/api/v1").Subrouter()
    api.HandleFunc("/users", listUsers).Methods("GET")
    api.HandleFunc("/users", createUser).Methods("POST")

    // Host-based routing
    r.Host("admin.example.com").HandlerFunc(handleAdmin)

    http.ListenAndServe(":8080", r)
}

func handleUser(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    id := vars["id"]
    // Use id...
}
```

### Junior to FAANG: Picking a Router Without Overthinking It

If you are building your first service in 2026, use the 1.22+ stdlib mux. If you hit a wall (need group middleware, need wildcards with constraints), adopt chi v5. Do not touch gorilla/mux for new code. Do not adopt Gin or Echo because a YouTube tutorial suggested it. The reason is portability. A handler written against `http.Handler` drops into any of these routers. A handler written against `gin.HandlerFunc` does not.

Worked example, converting stdlib patterns into chi when you outgrow stdlib.

```go
// stdlib
mux.HandleFunc("GET /api/v1/users/{id}", getUser)

// chi equivalent
r.Route("/api/v1", func(r chi.Router) {
    r.Use(authMiddleware)
    r.Get("/users/{id}", getUser)
})
// in handler: id := chi.URLParam(r, "id") replaces r.PathValue("id")
```

Interview framing. You will be asked "why not Gin." The correct answer. Gin uses its own `Context` type that is not `http.Handler`. This fragments middleware, prevents reuse of `httptest` patterns, and locks you into Gin for the life of the service. stdlib plus chi compose cleanly and migrate freely. Say that clearly and you sound like someone who has been through a framework migration.

### Senior at FAANG: Router Choice as an Org-Wide Decision

Write the router ADR once and enforce it forever. Canonical recommendation in April 2026. stdlib mux for simple services, chi v5 for services needing route groups and group middleware, Envoy route table for traffic shaping above the service. Ban Gin, Echo, Fiber, gorilla/mux, httprouter for new code. Existing services remain in maintenance mode with a deprecation timeline.

Migration playbook for fiber or gin services. Phase 1, introduce an adapter that wraps existing framework handlers behind `http.Handler`. Phase 2, write new routes using stdlib patterns under the adapter. Phase 3, codemod existing handlers to `http.HandlerFunc`, removing framework-specific APIs. Phase 4, delete the adapter and the framework dep. Timeline for a 200-handler service, typically one engineer-quarter. Publish the codemod as a platform tool so every team runs the same migration.

Routing performance reality check. For a typical FAANG service serving 10k RPS per pod, router dispatch is well under 1 microsecond. chi, stdlib, httprouter, Gin all land within a factor of 3. The actual latency is in middleware (auth, rate limit), downstream I/O (DB, cache, RPC), and serialization. Optimizing router choice for speed is almost always premature. Optimize for maintainability, ecosystem alignment, and `http.Handler` compatibility instead.

Route versioning strategy. URL-path versioning (`/api/v1/...`) is the FAANG default for external APIs because it is observable in logs and greppable in code. Header versioning (`Accept: application/vnd.corp.v2+json`) is cleaner but invisible in access logs and hard to debug. For internal east-west traffic, bake the version into the RPC contract, not the URL. Document the convention once per org.

Path-parameter security. Any `{id}` that maps to a database key must be validated as a numeric or UUID format at the edge, then re-validated in the handler. Defense in depth. A classic incident, path `/users/{id}` where `{id}` was passed directly into a SQL `LIKE` pattern for a search feature, leading to IDOR and data exfiltration. Platform middleware should offer `PathUUID("id")` helpers that return 400 on malformed input before the handler runs.

Shadow routing for canaries. At scale you deploy a new version on 1 percent of traffic while shadowing 5 percent (send to v2, discard response, compare metrics). This is done at the mesh, not the Go router, but the Go service must expose a `/metrics` label `deploy_version` to make the comparison meaningful. Build this into the platform contract.

Regex routes are a smell. `{id:[0-9]+}` from gorilla looks elegant and costs you the ability to clearly understand your route table. Prefer a validator middleware. If you find yourself reaching for regex in routes, the problem is usually that you are overloading a single path for too many shapes. Split the routes.

Route-table explosion governance. Services with more than 200 routes become unmaintainable. Rule of thumb, split a service when its route table exceeds 100 routes or when two distinct teams own routes inside it. Publish this as a platform guideline. Teams routinely blow through it and pay the incident tax later.

Host-based and subdomain routing. In 2026 the FAANG pattern is to do host routing at the ingress (Envoy, NGINX Ingress, Cloudflare) and keep every Go service mounted at `/`. Host routing inside Go is a legacy pattern that makes local development and test fixtures harder. Delete any `mux.Host(...)` calls you find.

ADR template for router selection. Context (size of org, existing router sprawl, migration appetite). Decision (stdlib plus chi, ban list). Consequences (training cost, migration tax, test-harness consolidation). Alternatives considered (Gin for dev velocity, Fiber for perf, Echo for middleware ergonomics), each rejected with a specific reason. Review date (annual). This template, applied once, ends a decade of "which router is best" debates.

---
