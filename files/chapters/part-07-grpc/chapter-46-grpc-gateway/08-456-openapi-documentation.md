## 46.6 OpenAPI Documentation

### Serving OpenAPI Spec

The `protoc-gen-openapiv2` plugin generates an OpenAPI v2 JSON spec from the same `.proto` annotations that drive gRPC-Gateway routing. Embedding the spec with `//go:embed` and serving it at `/swagger.json` alongside a Swagger UI handler gives API consumers a live, self-documenting interface that stays in sync with the protobuf contract without manual OpenAPI authoring.

```go
package gateway

import (
    "embed"
    "io/fs"
    "net/http"
)

//go:embed openapi/*.json
var openAPISpecs embed.FS

func OpenAPIHandler() http.Handler {
    fsys, err := fs.Sub(openAPISpecs, "openapi")
    if err != nil {
        panic(err)
    }
    return http.FileServer(http.FS(fsys))
}

func SwaggerUIHandler() http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        html := `<!DOCTYPE html>
<html>
<head>
    <title>API Documentation</title>
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
        SwaggerUIBundle({
            url: "/openapi/api.swagger.json",
            dom_id: '#swagger-ui',
            presets: [
                SwaggerUIBundle.presets.apis,
                SwaggerUIBundle.SwaggerUIStandalonePreset
            ],
            layout: "StandaloneLayout"
        });
    </script>
</body>
</html>`
        w.Header().Set("Content-Type", "text/html")
        w.Write([]byte(html))
    })
}

// Setup routes
func SetupDocs(mux *http.ServeMux) {
    mux.Handle("/openapi/", http.StripPrefix("/openapi/", OpenAPIHandler()))
    mux.HandleFunc("/docs", SwaggerUIHandler().ServeHTTP)
}
```

The `SetupDocs` function mounts the raw JSON spec and the Swagger UI page on separate paths. API consumers can fetch the spec programmatically at `/openapi/api.swagger.json` for SDK generation, while developers browse the interactive docs at `/docs`. Because the spec is embedded at compile time via `//go:embed`, deploying the binary is self-contained with no external file dependencies.

### Junior -> FAANG: Treating the OpenAPI Spec as a Deliverable

Many junior engineers treat the OpenAPI spec as a debug convenience: a page you can open in Swagger UI to test endpoints. At FAANG, it is a deliverable with the same lifecycle as the API itself.

The most important habit to develop is adding the spec to your CI/CD pipeline as an artifact. Every build that passes should publish a versioned OpenAPI spec to an artifact store (S3, an API catalog, or the BSR). This means external consumers can always find the spec for any deployed version, which is essential for debugging "the client is using a different spec than what is deployed" issues.

The `//go:embed` pattern in the section is correct for embedding the spec in the binary, but it creates a dependency: the spec must be generated before `go build` runs. Your Makefile or CI pipeline must run `buf generate` before `go build`. A common mistake is checking in stale generated files and letting `go build` succeed with the wrong spec. The CI check described in the fundamentals section (run `buf generate` and fail on diff) prevents this.

Swagger UI loaded from a CDN (`unpkg.com/swagger-ui-dist@5`) is convenient for development but wrong for production. A CDN outage or a version change at the CDN breaks your docs. Embed the Swagger UI assets alongside the spec using `//go:embed` or serve them from a pinned npm artifact. The binary becomes slightly larger but becomes self-contained.

The `protoc-gen-openapiv2` annotations in the proto file (operation summaries, response schemas for error codes, field descriptions) are what make the generated spec useful versus just technically correct. A spec that lists every endpoint but has no descriptions, no example values, and no error response schemas is useless for SDK generation and unhelpful for a developer trying to integrate. Make annotation quality part of your proto review checklist.

### Senior @ FAANG: The OpenAPI Spec as an API Catalog Asset

At scale, the OpenAPI spec is not just documentation for one API. It is the source for an API catalog that aggregates hundreds of services, drives automated SDK generation for multiple languages, powers contract tests that verify client-server compatibility, and provides the input for security scanners that look for exposed sensitive fields.

**API catalog integration.** Large organizations (Google, Stripe, Twilio) operate internal API catalogs where developers discover available services, browse documentation, and subscribe to change notifications. The OpenAPI spec is the feed for this catalog. This means the spec must include metadata beyond the technical definition: team ownership, SLO (expressed as a custom extension like `x-slo-p99-ms`), deprecation status, and a link to the service's runbook. These fields are not part of the OpenAPI standard. They are conveyed via `x-` extension fields, which `protoc-gen-openapiv2` supports via the `openapiv2_swagger` option's `extensions` field.

**SDK generation as a quality gate.** If you generate a client SDK from the OpenAPI spec (using openapi-generator or similar), the SDK generation step should run in CI. A proto change that breaks the spec in a way that prevents SDK generation is caught immediately. More importantly, the generated SDK can be used in contract tests: run the SDK against the live gateway in a staging environment and verify that every operation produces the expected response shape. This is stronger than testing the spec in isolation.

**Version management for the spec.** The spec served at `/openapi/api.swagger.json` should include a version field that matches the service version. When you deploy a new version, the spec changes. If external partners have cached the old spec, they may be testing against the wrong contract. A convention like `/openapi/v1/api.swagger.json` and `/openapi/v2/api.swagger.json` lets partners cache the spec for their target version without being confused by updates to other versions.

**Security considerations for the spec endpoint.** The spec endpoint is commonly left unprotected because it is "just documentation." But an exposed spec tells an attacker every endpoint, every field name, every authentication mechanism, and every error code. For internal APIs that should not be publicly discoverable, require authentication on the spec endpoint or restrict it to internal network CIDRs. For public APIs, the spec is intentionally public, but review it for inadvertent exposure of internal field names or undocumented endpoints.

**OpenAPI v2 vs v3 and the migration question.** `protoc-gen-openapiv2` generates OpenAPI v2 (Swagger 2.0). As of 2026, most tooling (SDK generators, API gateways, documentation platforms) supports both v2 and v3, but v3 has richer features for describing streaming responses, `oneOf`/`anyOf` schemas, and link relations. The `protoc-gen-openapiv3` project exists but is less mature than v2 generation. The ADR for this choice should note that the spec version is locked to what the gateway generates, and a migration to v3 requires toolchain changes (new plugin, updated CI, re-generated SDKs) that must be coordinated with consumers.

---
