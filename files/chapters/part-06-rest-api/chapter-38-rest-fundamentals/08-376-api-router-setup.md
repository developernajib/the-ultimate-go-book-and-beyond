## 38.6 API Router Setup

Since Go 1.22 (February 2024), the standard-library `http.ServeMux` supports method-matched patterns and path variables, so most services no longer need a third-party router. The key conventions:

1. Write patterns as `"METHOD /path/{var}"` and extract variables with `r.PathValue("var")`.
2. Mount sub-mux instances under path prefixes using `mux.Handle("/api/v1/", http.StripPrefix("/api/v1", v1))`.
3. Compose middleware as plain `func(http.Handler) http.Handler`, there is no framework-specific type to adopt.
4. Register action sub-resources as `POST /posts/{id}/publish` rather than encoding verbs in the base URL.

For teams that need regex patterns, host-based routing beyond what ServeMux supports, or per-route middleware trees, `github.com/go-chi/chi/v5` remains a solid ~1k-LOC alternative that also uses `r.PathValue`. Default to the standard library and reach for chi only when you hit a concrete limitation.

```go
// ... imports omitted for brevity (net/http, time)

func setupRouter() http.Handler {
    // v1 sub-mux
    v1 := http.NewServeMux()

    v1.HandleFunc("GET    /users",             listUsersHandler)
    v1.HandleFunc("POST   /users",             createUserHandler)
    v1.HandleFunc("GET    /users/{id}",        getUserHandler)
    v1.HandleFunc("PUT    /users/{id}",        replaceUserHandler)
    v1.HandleFunc("PATCH  /users/{id}",        updateUserHandler)
    v1.HandleFunc("DELETE /users/{id}",        deleteUserHandler)

    v1.HandleFunc("GET    /posts/{id}",        getPostHandler)
    v1.HandleFunc("POST   /posts/{id}/publish", publishPostHandler)
    v1.HandleFunc("POST   /posts/{id}/archive", archivePostHandler)

    // Root mux wires health + versioned API
    root := http.NewServeMux()
    root.HandleFunc("GET /health", healthHandler)
    root.Handle("/api/v1/", http.StripPrefix("/api/v1", v1))

    // Global middleware chain (order matters: outermost runs first)
    return Chain(root,
        RequestID,
        RealIP,
        Logging(logger),
        Recovery(logger),
        Timeout(60*time.Second),
    )
}

// Chain applies middleware in reverse order so the first argument runs outermost.
func Chain(h http.Handler, mw ...func(http.Handler) http.Handler) http.Handler {
    for i := len(mw) - 1; i >= 0; i-- {
        h = mw[i](h)
    }
    return h
}
```

For **resource-scoped middleware** like loading a user into context once for all `/users/{id}/*` routes, wrap the subset of handlers that need it rather than the whole mux:

```go
loadUser := UserContextMiddleware(store) // func(http.Handler) http.Handler

v1.Handle("GET    /users/{id}",        loadUser(http.HandlerFunc(getUserHandler)))
v1.Handle("PUT    /users/{id}",        loadUser(http.HandlerFunc(replaceUserHandler)))
v1.Handle("PATCH  /users/{id}",        loadUser(http.HandlerFunc(updateUserHandler)))
v1.Handle("DELETE /users/{id}",        loadUser(http.HandlerFunc(deleteUserHandler)))
```

### Junior → FAANG: router setup prerequisites

A router is a function that inspects `(method, path)` and returns a handler. That is the entire abstraction. Every Go HTTP framework is a decoration on top of that core. If you internalize one thing before your first on-call rotation, it is that `http.Handler` is the universal currency. Every middleware, every framework adapter, every test helper speaks `http.Handler`. Frameworks that require their own handler type (older gin versions, older echo) create friction when you need to integrate a library that ships standard handlers.

Before Go 1.22 the standard `http.ServeMux` had two genuine limitations: no method matching and no path variables. Every junior engineer used gorilla/mux or chi to work around these. In 2026 those reasons are gone for most services. The Go 1.22 enhanced ServeMux handles `"POST /users/{id}"` patterns, supports wildcards with `{path...}` for catch-alls, and precedence rules are specified (longer patterns win, method-specific wins over method-agnostic). The one genuine limitation remaining is that ServeMux has no regex constraints on path variables. If you need `{id:[0-9]+}`, reach for chi. Otherwise, do not.

Worked junior example. Your team ships `/users/{id}` where `{id}` is a UUID. A caller passes `/users/abc`. With ServeMux, the handler runs, `r.PathValue("id")` returns `"abc"`, parsing fails in the handler, you return 400. With chi and a regex constraint, the router returns 404 before your handler runs. Both are defensible. The ServeMux approach keeps routing simple and pushes validation into the handler where test coverage already lives. The chi approach matches Rails-style expectations and produces cleaner metrics (404 versus 400 distinction by route). Pick one per project and stick with it, do not mix.

Interview entry-point questions at the junior level. (1) What is the difference between `Handle` and `HandleFunc`? (`Handle` takes an `http.Handler`, `HandleFunc` takes a bare function and wraps it, that is the only difference). (2) Why does `http.StripPrefix` exist? (Mounted sub-muxes see paths starting from their mount point, so the outer mux must strip the prefix before delegating, otherwise the sub-mux would need to know its own mount path). (3) What is `http.ServeMux`'s conflict resolution? (Longer patterns win, method-specific wins over method-agnostic, conflicts panic at registration time in Go 1.22+).

### Senior @ FAANG: router setup at staff and principal scope

The router choice question gets asked in every system design interview and almost nobody answers it correctly. The correct answer is "show me the p99 latency budget, the route count, and the middleware stack, and I will tell you what to use". Without those numbers the answer is "standard library, escalate to chi if you find a concrete limit".

Public router microbenchmarks consistently rank fiber (fasthttp-based) and httprouter fastest, gin (which wraps httprouter's tree) close behind, chi in the middle, and the stdlib ServeMux at the back of the pack, with the whole spread measured in tens to a few hundred nanoseconds per request. huma wraps any of the above and adds a small per-request cost for OpenAPI validation. For a service with a 50 ms p99 latency budget and 50 routes, router CPU is noise. For a service with a sub-millisecond p99 budget serving hundreds of thousands of RPS (think: auth token introspection in the hot path of every request), a few hundred nanoseconds per request becomes a visible slice of the CPU budget. Benchmark your real service, not a microbenchmark.

The framework selection matrix a staff engineer actually uses. (1) net/http + chi: default choice for any public-facing REST API. Idiomatic, standard-library-compatible handlers, well-maintained, integrates cleanly with OpenTelemetry, slog, and every auth library in the ecosystem. (2) net/http + stdlib ServeMux: correct for small services, internal tools, and anything where dependency minimization matters (think: supply-chain attack surface for security-sensitive services). (3) gin: legacy choice, still productive, uses its own context type which creates adapter friction with stdlib middleware. Pick it only if the team already knows it. (4) echo: similar tradeoffs to gin, slightly cleaner API, same adapter friction. (5) fiber: uses fasthttp, which reuses request objects and creates subtle bugs with goroutines that outlive the handler. Avoid unless you have a measured need for its raw throughput and your team understands the memory model. Fasthttp is not compatible with net/http middleware, so every middleware has to be ported. (6) huma: sits on top of chi or stdlib, generates OpenAPI from handler signatures, excellent for API-first teams. Adds a thin reflection layer per request. Worth it when documentation drift is a real cost. (7) connect-go: not strictly a REST router, but the right answer when your "REST API" is actually an RPC surface and you want protobuf-generated handlers with JSON fallback.

Middleware composition is where router architecture actually matters. The onion model (each middleware wraps the next, innermost runs closest to the handler) is correct for all of the common concerns: request ID injection, panic recovery, timeout, logging, tracing, metrics, authentication, authorization, rate limiting, compression. The ordering ADR every senior engineer writes once and reuses forever:

1. RequestID (outermost) so every subsequent log line and error carries the ID.
2. RealIP extraction from X-Forwarded-For if and only if the request came from a trusted proxy (verify by source IP against a CIDR allowlist, do not trust the header blindly, this is a header-spoofing vulnerability).
3. Recovery converts panics to 500 responses and emits a metric. Must be outside metrics and logging so those see the panic outcome.
4. Tracing starts the OpenTelemetry span. Must be outside logging so log lines carry the trace ID.
5. Logging emits the access log. Outside metrics so the log captures the metric-emitted status.
6. Metrics records latency and status. Must be the innermost observability layer so it measures handler time only.
7. Timeout applies `http.TimeoutHandler` or a `context.WithTimeout` wrapper. Inside observability so the timeout outcome is logged and traced.
8. Compression is outermost of the body-touching middlewares. Must be outside any middleware that writes to the body (auth errors, rate-limit errors) so those responses are also compressed.
9. Authentication. Before authorization, obviously.
10. Authorization. Inside auth, outside rate limiting so per-user rate limits can key on the authenticated principal.
11. Rate limiting. Innermost before the handler. Keys on the authenticated principal or IP.

Get this order wrong and you ship real bugs. Recovery inside logging means the panic bypasses your access log. Tracing inside logging means trace IDs never appear in logs. Compression inside auth means 401 responses are not compressed, which is a minor bandwidth issue but also inconsistent content-length handling. Rate limiting outside auth means unauthenticated traffic consumes the authenticated user's budget.

Per-route middleware trees are where chi wins decisively over stdlib ServeMux. Chi supports `r.Route("/admin", func(r chi.Router) { r.Use(RequireAdmin); ... })` which applies `RequireAdmin` to every handler in the subtree. With stdlib ServeMux you either wrap each handler individually (verbose, easy to forget) or create a sub-mux per subtree and wrap the sub-mux (clean, but proliferates mux instances). The stdlib sub-mux pattern is fine up to about 20 routes per subtree. Beyond that chi saves real maintenance cost.

Finally, router testing. Every route should have a test that exercises the router configuration, not just the handler. Mount the full router in the test (or at minimum the sub-mux being exercised), send an `httptest.NewRequest`, assert the status code. This catches the class of bugs where the handler works but was registered under the wrong method or the wrong path. At FAANG scale this test often lives in a code-generated file produced from the OpenAPI spec, which catches router-versus-spec drift on every commit.

---
