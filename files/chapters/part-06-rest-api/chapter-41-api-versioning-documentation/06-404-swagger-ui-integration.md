## 41.4 Swagger UI Integration

### Serving Swagger UI

The handler embeds the Swagger UI static assets directly into the binary using `//go:embed`, eliminating the need to distribute a separate `swagger-ui` directory alongside the executable. The index page is generated in Go with `specURL` interpolated into the `SwaggerUIBundle` config, so the UI always points at the live OpenAPI spec of the running server.

Watch the closing tags in the templates below. They are `</script>`, not `<\/script>`. The escaped form is only needed when a script tag is embedded *inside a JavaScript string literal*, where an unescaped `</script>` would terminate the surrounding block early. Inside a Go raw string it is simply wrong: the backslash is not an escape there, so it is emitted verbatim, the browser never sees a closing tag, and you get a blank page. That specific mistake is the cause of a good share of the "blank docs page" reports debugged later in this section.

`specURL` is also interpolated straight into an HTML page here, which is fine because it is a compile-time constant. If it ever becomes caller-controlled (a `?spec=` query parameter, say), interpolate it through `html/template` instead of string concatenation, or you introduce reflected XSS into the documentation portal.

```go
// ... imports omitted for brevity (embed, io/fs, net/http,
// github.com/go-chi/chi/v5)

//go:embed swagger-ui/*
var swaggerUI embed.FS

// SwaggerUIHandler serves Swagger UI
func SwaggerUIHandler(specURL string) http.Handler {
    // Get swagger-ui subdirectory. This error is a programmer error, not a
    // runtime condition: it can only fail if the embedded path is wrong, and
    // that is knowable at startup. Panic here rather than silently serving a
    // nil filesystem that 404s every asset in production.
    fsys, err := fs.Sub(swaggerUI, "swagger-ui")
    if err != nil {
        panic("embed: swagger-ui subdirectory missing: " + err.Error())
    }

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Serve index.html with spec URL injected
        if r.URL.Path == "/" || r.URL.Path == "/index.html" {
            serveSwaggerIndex(w, specURL)
            return
        }

        // Serve static files
        http.FileServer(http.FS(fsys)).ServeHTTP(w, r)
    })
}

func serveSwaggerIndex(w http.ResponseWriter, specURL string) {
    html := `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>API Documentation</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
        window.onload = () => {
            SwaggerUIBundle({
                url: "` + specURL + `",
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIBundle.SwaggerUIStandalonePreset
                ],
                layout: "StandaloneLayout"
            });
        };
    </script>
</body>
</html>`

    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    w.Write([]byte(html))
}

// SetupDocRoutes configures documentation endpoints
func SetupDocRoutes(r chi.Router, docGen *APIDocGenerator) {
    // OpenAPI spec
    r.Get("/openapi.json", docGen.ServeSpec())

    // Swagger UI
    r.Mount("/docs", http.StripPrefix("/docs", SwaggerUIHandler("/openapi.json")))

    // Redoc (alternative UI)
    r.Get("/redoc", func(w http.ResponseWriter, r *http.Request) {
        html := `<!DOCTYPE html>
<html>
<head>
    <title>API Documentation</title>
    <meta charset="utf-8"/>
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
    <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
    <redoc spec-url='/openapi.json'></redoc>
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
</body>
</html>`
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        w.Write([]byte(html))
    })

    // Scalar: a polished, ergonomic alternative to Swagger UI and Redoc
    // with searchable nav, built-in request runner, and a cleaner default aesthetic.
    r.Get("/scalar", func(w http.ResponseWriter, r *http.Request) {
        html := `<!DOCTYPE html>
<html>
<head><title>API Documentation</title></head>
<body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        w.Write([]byte(html))
    })
}
```

**Picking a docs viewer:**
- **Swagger UI** - the default. Feature-complete, built-in "try it out" runner, familiar to every API consumer.
- **Redoc** - three-column reading layout, superior for long-form reference documentation meant to be read end-to-end.
- **Scalar** - a more recent, polished option with fast search, an ergonomic built-in request runner, and a cleaner visual aesthetic. Gaining rapid adoption for public API portals.

Serve all three from the same `/openapi.json` so developers can pick their preferred view without you maintaining three sets of documentation.

### Junior -> FAANG: how docs portals actually work and what to watch for

First principle. A docs portal is a single-page application (or a static site) that fetches your OpenAPI document at runtime and renders it. That means three moving parts live inside the page. An HTML shell with a mount point (the `<div id="swagger-ui">` above). A JavaScript bundle loaded from a CDN or embedded asset. A configuration call that tells the bundle where to fetch the spec. If the portal is broken, the bug is in one of those three places. Open the browser dev tools Network tab and look for a 404 on the bundle, a 404 or CORS error on `openapi.json`, or a JavaScript exception in the console. That is the triage flow you will use every week for the rest of your career.

CORS is the most common first-job failure. The portal lives on `docs.example.com`, the spec endpoint lives on `api.example.com/openapi.json`, and the browser blocks the cross-origin fetch. Fix it by setting `Access-Control-Allow-Origin` on the spec endpoint to either the docs origin or `*` if the spec is public. If the spec contains only public endpoint descriptions (not secrets), `*` is safe. If the spec leaks internal endpoint names, host the portal on the same origin as the API or require an auth cookie.

Second gotcha. The "Try it out" button in Swagger UI sends real HTTP requests from the user's browser to the API. That means you need CORS configured for the API itself too, not just the spec. You also need a sensible default `server` entry. If your spec lists `https://api.example.com` but the user is on `staging.example.com/docs`, the Try button will hit production. Stripe and Twilio work around this by injecting an auth token into the portal session and routing Try-It calls through a proxy. For internal tools, just pick a server dropdown and let the user switch.

Worked example. Your task ticket says "the docs page shows a blank screen in production but works locally." Walk through it. Open dev tools. Check the Network tab. If `swagger-ui-bundle.js` returns 404, your CDN URL is wrong or the CDN is blocked by the user's corporate proxy. If the bundle loads but `openapi.json` returns 401, the spec endpoint requires auth that the browser does not have. If both load but the page is still blank, open Console and look for an OpenAPI validation error. Swagger UI refuses to render an invalid spec and the error message is specific. This is a forty-five minute debugging exercise the first time, five minutes every subsequent time.

Interview entry-point. Expect "what is the difference between Swagger UI and OpenAPI," "how does Swagger UI fetch the spec," "how would you secure a docs portal that describes an internal API," and "what happens if the spec is 50MB." The last one is the scaling question. Swagger UI parses the entire spec in the browser on page load. At 50MB (yes, this happens at big companies) the page takes twenty seconds to render and crashes on mobile. The answers are switching to Redoc or Scalar (both stream and virtualize), splitting the spec with `$ref` to external files that load lazily, or maintaining per-tag slimmer specs for different audiences.

### Senior @ FAANG: portal architecture, the 2026 viewer landscape, and what the Try-It button implies

Staff-level work on documentation portals is three concerns braided together. Rendering performance on real specs at real sizes. Authenticated Try-It flows that do not leak credentials. Portal hosting that survives the next outage and the next org reshuffle. The code in this file solves none of those by itself. It shows you the mounting primitive. The interesting decisions happen one layer up.

The viewer landscape. Swagger UI remains the default in every open-source template and is fine for internal APIs under about 500 endpoints. Above that the DOM tree gets expensive and the app becomes sluggish. Redoc (now Redocly Redoc, MIT licensed core, SaaS on top) is the long-form reference option. Its three-panel layout with left-rail nav, middle-column narrative, and right-column examples is the layout Stripe popularized and the pattern most developer-facing companies now copy. Scalar arrived in 2023, matured rapidly, and by 2026 ships a React component, a Fastify plugin, a Vite plugin, a static-site CLI, and a hosted portal. Its differentiators are speed on large specs (it virtualizes the endpoint list), a cleaner Try-It, code samples generated across twelve languages, and theming that does not look like 2014. Stoplight Elements is the fourth mainstream option and is strongest if you author in Stoplight Studio or Platform. Bump.sh is a managed portal focused on automatic changelog generation and breaking-change visualization (and uses its own renderer). Readme.com is the marketing-grade managed portal used by Segment, Intercom, and a long tail of mid-market SaaS. Mintlify sits in the same space and has gained traction with AI-native docs sites that embed an LLM-backed search and answering layer trained on the spec plus narrative guides. Pick based on audience. Internal platform engineers tolerate Swagger UI. External enterprise buyers expect Readme or Mintlify polish. High-traffic public APIs need Scalar or Redoc for performance.

Self-hosted versus managed. Self-hosted Redoc or Scalar rendered to a static site on a CDN is the cheapest, most durable, and most auditable option. Zero runtime dependencies on an external SaaS, full control over auth, full control over analytics, zero monthly bill. The trade-off is you build the surrounding portal (landing page, auth, sidebar navigation across multiple APIs, changelog page, status page embed). Managed portals (Readme, Mintlify, Bump, Scalar Cloud, Redocly Realm, SwaggerHub, Stoplight Platform) give you that scaffolding for a per-seat or per-API monthly fee. The real hidden cost of managed platforms is vendor lock-in on the portal (not the spec, which stays portable) plus the integration code that pushes specs on every release. Budget a migration cost of two engineer-weeks if you ever switch portals.

The Try-It button is a security surface. When a user clicks it, the browser sends their credentials (API key, bearer token, OAuth access token) to the API origin. That means three things need to be true. The portal must store credentials in a way that survives page reloads without exposing them to other scripts (session cookies with `HttpOnly` are impossible because the SPA needs the header, so you are stuck with memory + localStorage trade-offs). The API must accept CORS from the portal origin. The API must rate-limit Try-It traffic separately from production traffic or a single curious user can DoS your staging environment. Stripe's answer is to provision a low-privilege sandbox key automatically on portal login and never let the portal see production credentials. GitHub's answer is to require an OAuth flow per session. Small teams short-circuit all of this by disabling Try-It in production (`tryItOutEnabled: false`) and pointing users at Postman or curl examples instead. That is a legitimate choice and the one I recommend for any API where a stray DELETE would ruin someone's afternoon.

Versioning the portal. When your API has v1, v2, and v3 live simultaneously (the common case once the API is more than three years old), the portal needs to render all three and let users switch. Swagger UI has a version selector but it is clunky. Redocly, Scalar, Bump, and Readme all have native multi-version support. The spec-per-version pattern is cleanest. Store `openapi-v1.json`, `openapi-v2.json`, `openapi-v3.json`. Render one portal per version under `/docs/v1`, `/docs/v2`, `/docs/v3`. Link them from a shared header. Deprecate old versions with a prominent banner and a link to the migration guide. Do not try to represent multiple versions in a single spec. OpenAPI does not model that cleanly and the tooling will fight you.

Performance budget. Set one explicitly, for example above-the-fold render in under two seconds on a mid-range laptop on residential broadband. The levers for a large spec are the same regardless of viewer: compress the JSON with Brotli at the CDN edge, pick a viewer that virtualizes the endpoint list rather than mounting every operation into the DOM, and keep the initial bundle small. The structural difference that matters is virtualization. Swagger UI renders the full operation list, so cost grows with endpoint count and the wall shows up first on mobile. Redoc and Scalar both virtualize and degrade far more gracefully. Do not take those characterizations, or any vendor's benchmark, as a number for your spec: your endpoint count, schema depth, and `$ref` fan-out dominate. Measure your actual document with Lighthouse and a real-device run before committing to a viewer.

Authoring integration. The portal is the output. The input is whatever workflow your team uses to produce OpenAPI. Three patterns dominate. Spec-first in a YAML repo (Stoplight Studio or any IDE, Spectral in CI, render to portal on merge). Code-first via annotations (swag for Go, drf-spectacular for Django, NestJS + @nestjs/swagger, FastAPI auto-generation). Hybrid generation (hand-write the spec, generate server stubs with oapi-codegen, keep them in sync with the compiler). The portal does not care which one you use as long as the output is a valid OpenAPI 3.1 document. That means the choice is an authoring ergonomics question, not a portal question, and you should decouple them explicitly in your architecture doc.

Analytics and feedback loops. A docs portal that does not capture "what endpoints are people reading, which search queries returned no results, where did users abandon the quickstart" is a docs portal that decays. Minimum instrumentation is page views per endpoint, search query log, Try-It click-through rate, and a feedback widget per page. Readme and Mintlify include this out of the box. Self-hosted portals need PostHog, Plausible, or similar plus a tiny event-emission layer. Review the analytics monthly with the DevRel or docs team and fund the top-five underperforming pages for a rewrite. That feedback loop is the difference between "we have docs" and "our docs are a product."

---
