## 41.5 Code-First Documentation with swag

### Swag Annotations

Swag annotations live as structured comments directly above each handler function, so a reviewer sees the documented contract and the implementation in the same diff. Note the qualifier: this makes drift *visible*, it does not make it *impossible*. Nothing in the compiler checks that `@Success 200 {object} Response{data=User}` describes what the function actually writes, which is the central weakness of the code-first approach and the reason the contract-testing advice later in this section is not optional.

The generic syntax in `@Success 200 {object} Response{data=[]User,meta=PaginationMeta}` is swag's way of expressing a wrapper type whose field types are substituted at documentation time, which is how you document one envelope reused across many payload types without declaring a struct per combination.

```go
// ... imports omitted for brevity (net/http)

// @title           User API
// @version         1.0
// @description     User management API
// @termsOfService  https://example.com/terms

// @contact.name   API Support
// @contact.url    https://example.com/support
// @contact.email  support@example.com

// @license.name  Apache 2.0
// @license.url   https://www.apache.org/licenses/LICENSE-2.0

// @host      api.example.com
// @BasePath  /api/v1

// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
// @description Type "Bearer" followed by a space and JWT token

// ListUsers godoc
// @Summary      List users
// @Description  Get paginated list of users
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        page       query   int     false  "Page number"           default(1)   minimum(1)
// @Param        page_size  query   int     false  "Items per page"        default(20)  minimum(1)  maximum(100)
// @Param        role       query   string  false  "Filter by role"        Enums(user, admin, editor)
// @Param        sort_by    query   string  false  "Sort field"            Enums(created_at, name, email)
// @Param        sort_order query   string  false  "Sort order"            Enums(asc, desc)  default(desc)
// @Success      200  {object}  Response{data=[]User,meta=PaginationMeta}
// @Failure      400  {object}  APIError
// @Failure      401  {object}  APIError
// @Failure      500  {object}  APIError
// @Security     BearerAuth
// @Router       /users [get]
func (h *UserHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
    // Implementation...
}

// CreateUser godoc
// @Summary      Create user
// @Description  Create a new user account
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        user  body      CreateUserInput  true  "User creation data"
// @Success      201   {object}  Response{data=User}
// @Header       201   {string}  Location  "URL of created resource"
// @Failure      400   {object}  APIError
// @Failure      409   {object}  APIError  "Email already exists"
// @Failure      422   {object}  APIError{details=[]ErrorDetail}  "Validation error"
// @Security     BearerAuth
// @Router       /users [post]
func (h *UserHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
    // Implementation...
}

// GetUser godoc
// @Summary      Get user
// @Description  Get user by ID
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        id   path      string  true  "User ID"  Format(uuid)
// @Success      200  {object}  Response{data=User}
// @Failure      404  {object}  APIError
// @Security     BearerAuth
// @Router       /users/{id} [get]
func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    // Implementation...
}

// UpdateUser godoc
// @Summary      Update user
// @Description  Partial update user by ID
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        id    path      string           true  "User ID"  Format(uuid)
// @Param        user  body      UpdateUserInput  true  "User update data"
// @Success      200   {object}  Response{data=User}
// @Failure      400   {object}  APIError
// @Failure      404   {object}  APIError
// @Failure      422   {object}  APIError{details=[]ErrorDetail}
// @Security     BearerAuth
// @Router       /users/{id} [patch]
func (h *UserHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
    // Implementation...
}

// DeleteUser godoc
// @Summary      Delete user
// @Description  Delete user by ID
// @Tags         users
// @Accept       json
// @Produce      json
// @Param        id   path      string  true  "User ID"  Format(uuid)
// @Success      204  "No content"
// @Failure      404  {object}  APIError
// @Failure      403  {object}  APIError  "Cannot delete own account"
// @Security     BearerAuth
// @Router       /users/{id} [delete]
func (h *UserHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
    // Implementation...
}
```

### Model Annotations

Swag reads struct tags and `//` comments on each field to populate the OpenAPI schema with types, examples, and enum constraints. The `@name` directive at the closing brace sets the schema name used in `$ref` references, which matters when multiple packages define structs with the same Go name.

```go
package model

// ... imports omitted for brevity (time)

// User represents a user account
// @Description User account information
type User struct {
    // User unique identifier
    ID string `json:"id" example:"550e8400-e29b-41d4-a716-446655440000"`
    // User email address
    Email string `json:"email" example:"user@example.com"`
    // User display name
    Name string `json:"name" example:"John Doe"`
    // User role
    Role string `json:"role" example:"user" enums:"user,admin,editor"`
    // Account creation timestamp
    CreatedAt time.Time `json:"created_at" example:"2024-01-15T09:30:00Z"`
    // Last update timestamp
    UpdatedAt time.Time `json:"updated_at" example:"2024-01-15T09:30:00Z"`
} // @name User

// CreateUserInput represents user creation request
// @Description User creation request body
type CreateUserInput struct {
    // User email address
    Email string `json:"email" example:"user@example.com" validate:"required,email"`
    // User display name
    Name string `json:"name" example:"John Doe" validate:"required,min=2,max=100"`
    // User password
    Password string `json:"password" example:"SecurePass123!" validate:"required,min=8"`
    // User role (defaults to user)
    Role string `json:"role" example:"user" enums:"user,admin,editor"`
} // @name CreateUserInput

// UpdateUserInput represents user update request
// @Description User update request body (all fields optional)
type UpdateUserInput struct {
    // User email address
    Email *string `json:"email,omitempty" example:"newemail@example.com"`
    // User display name
    Name *string `json:"name,omitempty" example:"Jane Doe"`
} // @name UpdateUserInput

// Response wraps successful API responses
// @Description Standard API response wrapper
type Response struct {
    // Response data
    Data any `json:"data"`
    // Pagination metadata
    Meta *PaginationMeta `json:"meta,omitempty"`
} // @name Response

// PaginationMeta contains pagination information
// @Description Pagination metadata
type PaginationMeta struct {
    // Current page number
    Page int `json:"page" example:"1"`
    // Items per page
    PageSize int `json:"page_size" example:"20"`
    // Total number of items
    TotalCount int64 `json:"total_count" example:"150"`
    // Total number of pages
    TotalPages int `json:"total_pages" example:"8"`
} // @name PaginationMeta

// APIError represents an error response
// @Description Standard API error response
type APIError struct {
    // HTTP status code
    Status int `json:"status" example:"400"`
    // Error code
    Code string `json:"code" example:"VALIDATION_ERROR"`
    // Human-readable error message
    Message string `json:"message" example:"Validation failed"`
    // Detailed error information
    Details []ErrorDetail `json:"details,omitempty"`
    // Request tracking ID
    RequestID string `json:"request_id,omitempty" example:"abc123"`
} // @name APIError

// ErrorDetail provides specific error information
// @Description Detailed error information
type ErrorDetail struct {
    // Field that caused the error
    Field string `json:"field,omitempty" example:"email"`
    // Error code
    Code string `json:"code" example:"INVALID_FORMAT"`
    // Human-readable message
    Message string `json:"message" example:"Invalid email format"`
} // @name ErrorDetail
```

### Generate Documentation

`swag init` parses the annotation comments and writes a `docs` package containing the OpenAPI JSON, a Go-importable spec string, and a Swagger UI registration call. The `--parseDependency` flag traverses imported packages so struct types defined outside the main module are included in the schema rather than rendered as opaque `object` types.

```bash
# Install swag
go install github.com/swaggo/swag/cmd/swag@latest

# Generate docs
swag init -g cmd/api/main.go -o docs/swagger

# Generate with specific parsers
swag init --parseDependency --parseInternal -g cmd/api/main.go
```

Once the `docs` package is generated, import it with a blank identifier (`_`) so its `init` function registers the spec, then mount the `httpSwagger.Handler` on a wildcard route. The handler serves both the Swagger UI assets and the generated `doc.json` spec file.

```go
// ... imports omitted for brevity (net/http, chi/v5, httpSwagger, _ myapp/docs/swagger)

func main() {
    r := chi.NewRouter()

    // Serve swagger docs
    r.Get("/swagger/*", httpSwagger.Handler(
        httpSwagger.URL("/swagger/doc.json"),
        httpSwagger.DeepLinking(true),
        httpSwagger.DocExpansion("none"),
        httpSwagger.DomID("swagger-ui"),
    ))

    // API routes...

    http.ListenAndServe(":8080", r)
}
```

### Code-First vs. Spec-First: Choosing an Approach

`swag` is a code-first tool: the Go code is the source of truth, and the OpenAPI document is derived from it. The opposite approach is **spec-first** (also called contract-first or design-first): a human-authored `openapi.yaml` is the source of truth, and servers/clients are generated from it. Both have trade-offs, and sophisticated teams often combine them.

| Approach | Tooling in Go | Strengths | Weaknesses |
|---|---|---|---|
| **Code-first** | `swaggo/swag`, `kin-openapi` | Annotations live next to handlers, documentation drift is caught in code review, no build-step dependency for adding an endpoint | Spec quality depends on annotator discipline, annotations can subtly misrepresent behavior. SDK quality constrained by what `swag` can express |
| **Spec-first** | `ogen-go/ogen`, `oapi-codegen/oapi-codegen` | Spec is a contract negotiated before implementation, generated server stubs make drift impossible, clients get strongly-typed SDKs with optional/nullable distinction | Requires YAML fluency, generated code is another build artifact to review, small changes still need a regen cycle |

**When to pick which:**
- **Spec-first (ogen or oapi-codegen)** for external/partner APIs where the contract is negotiated and breaking changes have economic consequences. `ogen` is notable for generating strongly-typed clients with proper `OptString` / `OptNullable` types for PATCH semantics, and enum value checking rather than bare `string` aliases. `oapi-codegen` produces simpler, more idiomatic Go and is often the pragmatic default when the team prefers hand-written business logic and machine-written boilerplate.
- **Code-first (swag)** for internal APIs and rapid prototypes where handler code moves faster than any spec review cycle. The cost is eternal vigilance against annotation drift, mitigated by CI checks that regenerate the spec and compare against a committed snapshot.

**Hybrid pattern:** many teams write the spec by hand, use `ogen` or `oapi-codegen` to generate server interfaces, and then add `swag`-style annotations on top for richer examples that are easier to author in Go comments than in YAML. The generated interface makes drift impossible for signatures. The annotations enrich the human-facing documentation.

**SDK distribution:** once the OpenAPI spec is stable, services like **Stainless** and **Fern** produce polished, idiomatic client SDKs across Go, Python, TypeScript, Java, and others, a tier above what generic OpenAPI Generator templates produce. Stainless is the approach behind the public SDKs of Anthropic, OpenAI, and Cloudflare, which is a useful signal: those are companies whose SDK is a large part of the product experience.

### Junior -> FAANG: getting swag working and why annotations drift

Start with a mental picture. `swag` is a CLI that walks your source tree, finds comments that match its annotation syntax, reconstructs an OpenAPI document, and writes it to a `docs/` package plus a `swagger.json` file on disk. It runs at build time. It does not run at request time. Nothing about your production binary depends on `swag` being installed on the server. That detail trips up juniors on first install because they assume a runtime library. It is purely a code generator.

The day-one setup. `go install github.com/swaggo/swag/cmd/swag@latest` puts the `swag` binary in `$GOPATH/bin`. Put that on your `PATH`. In your repo root run `swag init -g cmd/api/main.go` (the `-g` points at the file that has the `@title`, `@version`, `@host` top-level annotations). The command writes `docs/docs.go`, `docs/swagger.json`, and `docs/swagger.yaml`. Import `_ "yourmodule/docs"` in `main.go`. Mount the Swagger UI handler. Visit `/swagger/index.html`. That is the full loop. If the UI is blank, check the blank import first: it is by far the most common cause, because without it nothing ever registers the generated spec and the handler serves a document that does not exist.

Make generation part of your build. Add a `go:generate //go:generate swag init -g cmd/api/main.go` directive near `main.go` and run `go generate ./...` in CI. Or add a `Makefile` target `docs:` that runs `swag init` and call it from the test job. The important property is that `swag init` must run on every PR and the generated files must be committed. If you do not commit them, every deploy will produce a different spec and your changelog automation will melt. If you do commit them but never regenerate, your docs will slowly diverge from reality and someone will file a priority-1 bug in six months.

Worked example. You add a new field `IsVerified bool` to `User`. You run the server. The docs do not update. Why. Because `swag init` has not run. You run it. The generated schema now includes `is_verified`. You forgot to add the `example:"true"` tag so the rendered UI shows an empty field. You add the tag. Regenerate. Commit. Review. Ship. That loop, repeated a hundred times, is what a first-year FAANG engineer owning an API does.

Annotation drift, explained concretely. The handler comment says `@Success 200 {object} Response{data=User}`. The handler actually returns `Response{data=[]User}` (a slice). The docs claim a single object, the API returns an array, the SDK generated from those docs produces broken client code. Nothing in the compiler catches this. Nothing in the test suite catches this unless you explicitly assert the response shape matches the documented schema. The senior-level fix is to generate the spec, then run contract tests (e.g., Dredd, Schemathesis, or a property test against `kin-openapi`) that replay the spec against the live server. That closes the loop. Do it from month one of owning an API or you will regret it.

Interview entry-point. Expect "what is the difference between swag and openapi-generator," "how do you prevent your docs from drifting from your code," "what is the downside of annotations in comments versus struct tags," and "how would you migrate from swag to spec-first without breaking clients." The last question is common because many companies try swag, hit drift limits, and then move to oapi-codegen or ogen. The migration is "export the current swag-generated spec as the starting YAML, freeze swag, hand-edit the YAML, regenerate server stubs with oapi-codegen, port handlers to the new signatures incrementally behind a feature flag." Be ready to sketch that on a whiteboard.

### Senior @ FAANG: picking a Go OpenAPI toolchain in 2026 and the code-first tax

Staff-level framing. The Go ecosystem has four serious OpenAPI tools and the choice among them is a multi-year commitment because migrating between them is painful. The tools are swag, oapi-codegen v2, ogen, and Huma. Each optimizes for something different and picking the wrong one for your team's workflow causes slow, dragging, irreversible pain.

swag (swaggo/swag). Code-first via structured comments. Strengths are low ceremony, no build-time YAML, friendly to teams already writing godoc. Weaknesses are the expressiveness gap versus raw OpenAPI (swag cannot fully express `oneOf`, discriminators, complex `allOf` compositions, or nullability the way 3.1 does) and the comment-drift problem, which no amount of discipline fully solves because the annotations are strings the compiler never reads. swag suits internal APIs with simple schemas. It starts to hurt as schema complexity grows, and the pain arrives through the expressiveness gap rather than through endpoint count alone.

oapi-codegen v2 (oapi-codegen/oapi-codegen). Spec-first code generator. Generates Echo, Chi, Gin, Gorilla, net/http server interfaces plus Go clients. v2 added the "strict-server" mode where handler signatures force type-safe request and response types and the compiler refuses to build on spec mismatch. This is the sweet spot for most Go teams in 2026. Idiomatic Go, good generics support since v2, active maintenance, wide router support. Trade-off is that pure spec-first means no escape hatch for richer examples that live naturally in comments, and the generated code is another layer to understand during debugging.

ogen (ogen-go/ogen). Spec-first but with stricter generation. Produces zero-reflection, zero-allocation-in-the-hot-path code. Proper `OptString`, `OptNil`, `OptNilString` types that distinguish "not present," "present but null," and "present with value." Enum value checking at parse time. Validates against the spec automatically. It is the right choice when you need strict typing, high performance, and airtight PATCH semantics (where the three-state distinction actually matters for partial updates). Trade-off is verbose generated code, a steeper learning curve, and sharper edges when the spec uses features ogen does not fully support (ogen has the narrowest feature matrix of the four, so audit your spec's `oneOf` and `discriminator` usage first).

Huma (danielgtaylor/huma). Code-first like swag but structurally cannot drift because the framework owns both sides. You define Go types, Huma produces the spec from them, and the router and the spec are always in sync by construction. v2 is mature, OpenAPI 3.1 native, supports middleware composition, CLI generation, and is arguably the nicest ergonomics of the four if you are greenfield. Trade-off is framework lock-in. You are adopting a web framework, not just a codegen tool. If you already use Chi or Gin you are not migrating.

Default recommendation for 2026. Greenfield Go service, public-facing, team of 3 to 15 engineers. Use oapi-codegen v2 in strict-server mode. Write the spec by hand in YAML in the service repo. Commit the generated code. Run Spectral in CI. Regenerate SDKs with Stainless or Fern. This is the path of least resistance and the one most FAANG-adjacent companies with mature Go APIs converge on. Pick Huma if your team wants the absolute highest velocity and is willing to accept framework coupling. Pick ogen if your API exposes complex PATCH semantics or you are in a latency-sensitive path. Pick swag only if you are prototyping or maintaining a pre-existing swag-annotated codebase.

The code-first tax that nobody discusses at the junior level. Comment annotations are not type-checked. Struct-tag annotations are partially type-checked. Neither catches the case where a handler returns a `*User` pointer that happens to be nil and the spec claims the response is non-nullable. Neither catches the case where middleware wraps the response body in a pagination envelope that the handler's annotation did not anticipate. Neither catches the case where a graceful shutdown handler returns 503 with a different shape than the documented error envelope. What these share is that the divergence lives between layers, so no single file looks wrong and no reviewer reading a diff can see it. The mitigation is contract tests running in CI against a staged server with seeded data, because only a running server can be compared against the document. Schemathesis is the premier tool (Python, runs against any OpenAPI spec, property-based). Dredd is the older, simpler alternative. Prism from Stoplight can run as a validating proxy in front of your staging server. Budget one engineer-week to stand this up. It will catch bugs for the rest of the service's life.

SDK generation strategy. For internal consumers, oapi-codegen produces fine Go clients and openapi-generator produces acceptable clients in other languages. For external paying customers, generic tools produce SDKs that feel like generic tools. Stainless (used by Anthropic, OpenAI, Cloudflare, Together, Groq, and many 2024-2026 AI infra companies) and Fern (used by Cohere, AssemblyAI, Flatfile) produce SDKs that feel hand-written. They handle pagination, retries, streaming, error hierarchies, and idiomatic naming per language. They are paid services. The cost is typically justified by the second or third language you ship because maintaining five SDKs by hand costs more than either service's annual fee. Speakeasy is a third entrant in the same space. All three read your OpenAPI spec as input, which is the whole point of making that spec the durable artifact.

OpenAPI Generator as a fallback. If paid SDK services are off the table, openapi-generator (the Java-based tool maintained by a large OSS community) produces clients in 50+ languages. Quality varies by language. The Go client is decent. The TypeScript client is workable. The Python client has improved significantly since 2023. The Ruby, PHP, and Kotlin clients need more manual polish. Budget real engineering time to review and patch the generated SDKs before publishing them. Do not publish straight-from-the-generator output to a public package registry. Your users will notice.

A final production pattern. Treat the OpenAPI spec as a published, versioned artifact. Publish the spec itself to a URL (`https://api.example.com/openapi.json`) at a stable path. Include it in your release pipeline. Tag it in git alongside the service version. Consumers can diff the spec across versions, generate their own clients, and file PRs against you when they spot regressions. That transparency is what separates "we have an API" from "we have an API product." Stripe, Twilio, and GitHub all do this. The spec file is effectively part of the product surface. Owning it at that level is the staff-level shift.

---
