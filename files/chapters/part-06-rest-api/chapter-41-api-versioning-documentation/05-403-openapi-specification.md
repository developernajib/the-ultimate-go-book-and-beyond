## 41.3 OpenAPI Specification

### OpenAPI Document Generation

`APIDocGenerator` builds the OpenAPI document programmatically using `kin-openapi`, keeping the spec in sync with the Go types that actually implement the API rather than a separately maintained YAML file. The generator exposes a handler that serializes the document to JSON on demand so the spec is always derivable from the running server.

**Which OpenAPI version?** OpenAPI 3.1 is the current target and is fully aligned with JSON Schema 2020-12, which ended the long-standing divergence between the Schema Object and JSON Schema that previously forced spec authors to pick between two kinds of schema, both subtly wrong. OpenAPI 3.0 remains widely deployed, most toolchains support both, and many organizations still generate 3.0 because older SDK generators lag on 3.1 features like proper `null` types and `const`. For a new API, prefer 3.1 unless a specific downstream generator forces 3.0. The example below pins `OpenAPI: "3.1.0"`. Swap in `"3.0.3"` if a critical tool in your pipeline has not caught up yet.

**A note on the `kin-openapi` API.** This library has changed shape over time and older tutorials will not compile. As of the current releases: `Paths` and `Responses` are opaque structs built with `openapi3.NewPaths()` and `openapi3.NewResponses()` and populated with `.Set(key, value)`, not maps you can `make()` and index. `Schema.Type` is a `*openapi3.Types` (a `[]string`), which is exactly what makes 3.1 type unions expressible: `&openapi3.Types{"string", "null"}` is how you say nullable in 3.1, and `nullable: true` no longer exists. `MaxLength`, `Min`, and `Max` are pointers, so use the `openapi3.Uint64Ptr` and `openapi3.Float64Ptr` helpers, and note the fields are `Min`/`Max`, not `Minimum`/`Maximum`. The generic `openapi3.Ptr` replaces the old per-type helpers such as `StringPtr`.

```go
// ... imports omitted for brevity (encoding/json, net/http, github.com/getkin/kin-openapi/openapi3)

// APIDocGenerator generates OpenAPI documentation
type APIDocGenerator struct {
    doc *openapi3.T
}

func NewAPIDocGenerator(title, version, description string) *APIDocGenerator {
    return &APIDocGenerator{
        doc: &openapi3.T{
            OpenAPI: "3.1.0", // OpenAPI 3.1 (JSON Schema 2020-12 compatible); use "3.0.3" for older tooling
            Info: &openapi3.Info{
                Title:       title,
                Version:     version,
                Description: description,
                Contact: &openapi3.Contact{
                    Name:  "API Support",
                    Email: "support@example.com",
                    URL:   "https://example.com/support",
                },
                License: &openapi3.License{
                    Name: "Apache 2.0",
                    URL:  "https://www.apache.org/licenses/LICENSE-2.0",
                },
            },
            Servers: openapi3.Servers{
                {URL: "https://api.example.com/v1", Description: "Production"},
                {URL: "https://staging-api.example.com/v1", Description: "Staging"},
                {URL: "http://localhost:8080/v1", Description: "Development"},
            },
            // NewPaths(), not make(): Paths is an opaque struct.
            Paths: openapi3.NewPaths(),
            Components: &openapi3.Components{
                Schemas:         make(openapi3.Schemas),
                SecuritySchemes: make(openapi3.SecuritySchemes),
                Responses:       make(openapi3.ResponseBodies),
            },
        },
    }
}

// AddSecuritySchemes adds authentication schemes
func (g *APIDocGenerator) AddSecuritySchemes() {
    g.doc.Components.SecuritySchemes["bearerAuth"] = &openapi3.SecuritySchemeRef{
        Value: &openapi3.SecurityScheme{
            Type:         "http",
            Scheme:       "bearer",
            BearerFormat: "JWT",
            Description:  "JWT Authorization header using Bearer scheme",
        },
    }

    g.doc.Components.SecuritySchemes["apiKey"] = &openapi3.SecuritySchemeRef{
        Value: &openapi3.SecurityScheme{
            Type:        "apiKey",
            In:          "header",
            Name:        "X-API-Key",
            Description: "API key for authentication",
        },
    }
}

// AddSchema adds a schema component
func (g *APIDocGenerator) AddSchema(name string, schema *openapi3.Schema) {
    g.doc.Components.Schemas[name] = &openapi3.SchemaRef{Value: schema}
}

// AddPath adds a path with operations
func (g *APIDocGenerator) AddPath(path string, item *openapi3.PathItem) {
    g.doc.Paths.Set(path, item)
}

// DefineCommonResponses registers the shared response components that
// operations below reference by $ref. Skipping this step is the single most
// common way to ship a spec that looks fine in review and then fails to
// resolve: a $ref to a component that was never defined is a dangling
// pointer, and every generator, linter, and validator will reject the
// document. Define them once, reference them everywhere.
func (g *APIDocGenerator) DefineCommonResponses() {
    errContent := openapi3.Content{
        "application/json": &openapi3.MediaType{
            Schema: &openapi3.SchemaRef{Ref: "#/components/schemas/Error"},
        },
    }

    for name, desc := range map[string]string{
        "BadRequest":      "Malformed request",
        "Unauthorized":    "Authentication required or invalid",
        "NotFound":        "Resource does not exist",
        "Conflict":        "Conflicts with current resource state",
        "ValidationError": "One or more fields failed validation",
    } {
        g.doc.Components.Responses[name] = &openapi3.ResponseRef{
            Value: &openapi3.Response{
                // Ptr, not the removed StringPtr. Description is required on
                // a Response Object, so a nil here is a spec violation.
                Description: openapi3.Ptr(desc),
                Content:     errContent,
            },
        }
    }
}

// Generate returns the OpenAPI document
func (g *APIDocGenerator) Generate() *openapi3.T {
    return g.doc
}

// ServeSpec returns an HTTP handler for the OpenAPI spec
func (g *APIDocGenerator) ServeSpec() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(g.doc)
    }
}
```

### Schema Definitions

Schema definitions enumerate required fields and property types so client code generators can produce typed SDKs without manual annotation. Reusing a named schema reference like `"User"` across multiple path definitions avoids duplication and means a single field change propagates to every endpoint that references it.

```go
// ... imports omitted for brevity (github.com/getkin/kin-openapi/openapi3)

// DefineUserSchemas adds user-related schemas
func (g *APIDocGenerator) DefineUserSchemas() {
    // User response schema
    g.AddSchema("User", &openapi3.Schema{
        Type:     &openapi3.Types{"object"},
        Required: []string{"id", "email", "name"},
        Properties: openapi3.Schemas{
            "id": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Format:      "uuid",
                    Description: "Unique user identifier",
                    Example:     "550e8400-e29b-41d4-a716-446655440000",
                },
            },
            "email": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Format:      "email",
                    Description: "User email address",
                    Example:     "user@example.com",
                },
            },
            "name": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    MinLength:   2,
                    MaxLength:   openapi3.Uint64Ptr(100),
                    Description: "User display name",
                    Example:     "John Doe",
                },
            },
            "role": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Enum:        []any{"user", "admin", "editor"},
                    Description: "User role",
                    Example:     "user",
                },
            },
            "created_at": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Format:      "date-time",
                    Description: "Creation timestamp",
                },
            },
        },
    })

    // Create user request schema
    g.AddSchema("CreateUserRequest", &openapi3.Schema{
        Type:     &openapi3.Types{"object"},
        Required: []string{"email", "name", "password"},
        Properties: openapi3.Schemas{
            "email": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:   &openapi3.Types{"string"},
                    Format: "email",
                },
            },
            "name": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:      &openapi3.Types{"string"},
                    MinLength: 2,
                    MaxLength: openapi3.Uint64Ptr(100),
                },
            },
            "password": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Format:      "password",
                    MinLength:   8,
                    Description: "Must contain uppercase, lowercase, number, and special character",
                },
            },
            "role": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:    &openapi3.Types{"string"},
                    Enum:    []any{"user", "admin", "editor"},
                    Default: "user",
                },
            },
        },
    })

    // Pagination metadata, referenced by the list endpoint's "meta" field.
    // Every $ref must have a definition or the document will not resolve.
    g.AddSchema("PaginationMeta", &openapi3.Schema{
        Type:     &openapi3.Types{"object"},
        Required: []string{"page", "page_size", "total"},
        Properties: openapi3.Schemas{
            "page":      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"integer"}, Min: openapi3.Float64Ptr(1)}},
            "page_size": &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"integer"}, Min: openapi3.Float64Ptr(1), Max: openapi3.Float64Ptr(100)}},
            "total":     &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"integer"}, Min: openapi3.Float64Ptr(0)}},
        },
    })

    // Error response schema
    g.AddSchema("Error", &openapi3.Schema{
        Type:     &openapi3.Types{"object"},
        Required: []string{"status", "code", "message"},
        Properties: openapi3.Schemas{
            "status": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"integer"},
                    Description: "HTTP status code",
                },
            },
            "code": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Description: "Error code",
                },
            },
            "message": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"string"},
                    Description: "Human-readable error message",
                },
            },
            "details": &openapi3.SchemaRef{
                Value: &openapi3.Schema{
                    Type:        &openapi3.Types{"array"},
                    Description: "Detailed error information",
                    Items: &openapi3.SchemaRef{
                        Value: &openapi3.Schema{
                            Type: &openapi3.Types{"object"},
                            Properties: openapi3.Schemas{
                                "field":   &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}}},
                                "code":    &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}}},
                                "message": &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}}},
                            },
                        },
                    },
                },
            },
        },
    })
}
```

### Path Definitions

`DefineUserPaths` registers each operation with its tag, summary, operation ID, and full response schema including error shapes, giving code generators enough information to produce typed client methods with correct error handling. The `OperationID` field is critical for SDK generation because it becomes the function name in generated clients.

Call order matters at startup: `AddSecuritySchemes`, `DefineCommonResponses`, and `DefineUserSchemas` must all run before you serve the document, because the operations below reference those components by `$ref`. A quick way to prove you got it right is to round-trip the generated JSON through `openapi3.NewLoader().LoadFromData` and then `doc.Validate(ctx)` in a unit test. That resolves every `$ref` and fails loudly on a dangling one, which is a check worth having in CI rather than discovering when a generator produces a broken SDK.

```go
// ... imports omitted for brevity (github.com/getkin/kin-openapi/openapi3)

// DefineUserPaths adds user endpoint documentation.
//
// Responses is an opaque struct, so it is built with NewResponses() and
// populated with Set(). A map literal like openapi3.Responses{"200": ...}
// is from an older version of the library and no longer compiles.
func (g *APIDocGenerator) DefineUserPaths() {
    // GET /users
    listResponses := openapi3.NewResponses()
    listResponses.Set("200", &openapi3.ResponseRef{
        Value: &openapi3.Response{
            Description: openapi3.Ptr("Successful response"),
            Content: openapi3.Content{
                "application/json": &openapi3.MediaType{
                    Schema: &openapi3.SchemaRef{
                        Value: &openapi3.Schema{
                            Type: &openapi3.Types{"object"},
                            Properties: openapi3.Schemas{
                                "data": &openapi3.SchemaRef{
                                    Value: &openapi3.Schema{
                                        Type:  &openapi3.Types{"array"},
                                        Items: &openapi3.SchemaRef{Ref: "#/components/schemas/User"},
                                    },
                                },
                                "meta": &openapi3.SchemaRef{Ref: "#/components/schemas/PaginationMeta"},
                            },
                        },
                    },
                },
            },
        },
    })
    listResponses.Set("401", &openapi3.ResponseRef{Ref: "#/components/responses/Unauthorized"})

    // NewResponses() seeds a "default" response. Delete it when every status
    // is enumerated explicitly, otherwise the generated SDK grows a stray
    // default branch that can never fire.
    listResponses.Delete("default")

    createResponses := openapi3.NewResponses()
    createResponses.Set("201", &openapi3.ResponseRef{
        Value: &openapi3.Response{
            Description: openapi3.Ptr("User created"),
            Headers: openapi3.Headers{
                "Location": &openapi3.HeaderRef{
                    Value: &openapi3.Header{
                        Parameter: openapi3.Parameter{
                            Description: "URL of created resource",
                            Schema:      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Format: "uri"}},
                        },
                    },
                },
            },
            Content: openapi3.Content{
                "application/json": &openapi3.MediaType{
                    Schema: &openapi3.SchemaRef{
                        Value: &openapi3.Schema{
                            Type: &openapi3.Types{"object"},
                            Properties: openapi3.Schemas{
                                "data": &openapi3.SchemaRef{Ref: "#/components/schemas/User"},
                            },
                        },
                    },
                },
            },
        },
    })
    createResponses.Set("400", &openapi3.ResponseRef{Ref: "#/components/responses/BadRequest"})
    createResponses.Set("409", &openapi3.ResponseRef{Ref: "#/components/responses/Conflict"})
    createResponses.Set("422", &openapi3.ResponseRef{Ref: "#/components/responses/ValidationError"})
    createResponses.Delete("default")

    g.AddPath("/users", &openapi3.PathItem{
        Get: &openapi3.Operation{
            Tags:        []string{"Users"},
            Summary:     "List users",
            Description: "Returns a paginated list of users",
            OperationID: "listUsers",
            Security:    &openapi3.SecurityRequirements{{"bearerAuth": []string{}}},
            Parameters: openapi3.Parameters{
                &openapi3.ParameterRef{
                    Value: &openapi3.Parameter{
                        Name:        "page",
                        In:          "query",
                        Description: "Page number",
                        Schema:      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"integer"}, Default: 1, Min: openapi3.Float64Ptr(1)}},
                    },
                },
                &openapi3.ParameterRef{
                    Value: &openapi3.Parameter{
                        Name:        "page_size",
                        In:          "query",
                        Description: "Items per page",
                        Schema:      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"integer"}, Default: 20, Min: openapi3.Float64Ptr(1), Max: openapi3.Float64Ptr(100)}},
                    },
                },
                &openapi3.ParameterRef{
                    Value: &openapi3.Parameter{
                        Name:        "role",
                        In:          "query",
                        Description: "Filter by role",
                        Schema:      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Enum: []any{"user", "admin", "editor"}}},
                    },
                },
            },
            Responses: listResponses,
        },
        Post: &openapi3.Operation{
            Tags:        []string{"Users"},
            Summary:     "Create user",
            Description: "Creates a new user account",
            OperationID: "createUser",
            Security:    &openapi3.SecurityRequirements{{"bearerAuth": []string{}}},
            RequestBody: &openapi3.RequestBodyRef{
                Value: &openapi3.RequestBody{
                    Required:    true,
                    Description: "User creation data",
                    Content: openapi3.Content{
                        "application/json": &openapi3.MediaType{
                            Schema: &openapi3.SchemaRef{Ref: "#/components/schemas/CreateUserRequest"},
                        },
                    },
                },
            },
            Responses: createResponses,
        },
    })

    // GET /users/{id}
    getResponses := openapi3.NewResponses()
    getResponses.Set("200", &openapi3.ResponseRef{
        Value: &openapi3.Response{
            Description: openapi3.Ptr("Successful response"),
            Content: openapi3.Content{
                "application/json": &openapi3.MediaType{
                    Schema: &openapi3.SchemaRef{
                        Value: &openapi3.Schema{
                            Type: &openapi3.Types{"object"},
                            Properties: openapi3.Schemas{
                                "data": &openapi3.SchemaRef{Ref: "#/components/schemas/User"},
                            },
                        },
                    },
                },
            },
        },
    })
    getResponses.Set("404", &openapi3.ResponseRef{Ref: "#/components/responses/NotFound"})
    getResponses.Delete("default")

    g.AddPath("/users/{id}", &openapi3.PathItem{
        Parameters: openapi3.Parameters{
            &openapi3.ParameterRef{
                Value: &openapi3.Parameter{
                    Name:        "id",
                    In:          "path",
                    Required:    true,
                    Description: "User ID",
                    Schema:      &openapi3.SchemaRef{Value: &openapi3.Schema{Type: &openapi3.Types{"string"}, Format: "uuid"}},
                },
            },
        },
        Get: &openapi3.Operation{
            Tags:        []string{"Users"},
            Summary:     "Get user",
            Description: "Returns a single user by ID",
            OperationID: "getUser",
            Responses:   getResponses,
        },
    })
}
```

### Junior -> FAANG: OpenAPI prerequisites and first-job mental model

If you are new to OpenAPI, start with the four-way split that every spec uses. `info` is metadata (title, version, contact). `servers` lists base URLs per environment. `paths` maps URL templates to operations (GET, POST, etc.). `components` holds reusable schemas, parameters, responses, and security schemes referenced by `$ref`. Everything you write in a real spec fits into one of those buckets. A common junior mistake is inlining the same user schema in five endpoints. The fix is one `components.schemas.User` plus five `$ref: '#/components/schemas/User'` pointers.

Second prerequisite: JSON Schema. OpenAPI 3.1 uses JSON Schema 2020-12 directly, so `type`, `required`, `properties`, `enum`, `format`, `minLength`, `pattern`, `oneOf`, `anyOf`, and `allOf` behave exactly like they do in standalone JSON Schema. Read the JSON Schema "Getting Started Step-By-Step" guide before you write more than twenty lines of OpenAPI. The `format` keyword is advisory in JSON Schema but most OpenAPI generators treat `uuid`, `email`, `date-time`, and `uri` as strongly typed, so use them liberally.

Worked example. Take this endpoint description from a tech-screen question: "GET /orders/{id} returns an order with id, total in cents, status (pending, paid, shipped, canceled), and a list of line items." Translate it step by step. Path is `/orders/{id}`. Path parameter `id` is a string UUID, required. Response 200 has `application/json` content whose schema is `$ref: '#/components/schemas/Order'`. The `Order` component is `type: object`, required `[id, total_cents, status, items]`, properties include `status` as `type: string, enum: [pending, paid, shipped, canceled]`, and `items` as `type: array, items: {$ref: '#/components/schemas/LineItem'}`. Add a 404 response pointing at a shared `NotFound` response component. That is roughly 40 lines of YAML and it is the exercise an L3 or L4 interviewer will actually ask.

First-job context at FAANG and FAANG-adjacent shops. You will almost never start a spec from scratch. You will inherit one (often 3000+ lines), add an endpoint, run the repo's linter (usually Spectral), and open a PR that a senior reviews against a style guide. The style guide dictates naming (snake_case versus camelCase), error envelope shape, pagination contract, and which security schemes are allowed. Your job week one is to read that style guide, find three existing endpoints similar to the one you are adding, and copy their structure. Do not invent new patterns. Do not introduce a new error shape. Consistency beats elegance in a large API surface.

Interview entry-point. Expect "explain the difference between `$ref` and inlining a schema," "what does `additionalProperties: false` do," "how do you document an endpoint that returns either a success object or a validation error," and "what is `operationId` and why does it matter." The last one is the discriminator that tells the interviewer you have actually used a code generator. `operationId` becomes the client method name, so `listUsers` becomes `client.listUsers(...)` in generated TypeScript or `client.ListUsers(ctx, ...)` in generated Go. Make them verbBased, lowerCamelCase, and unique across the whole document.

### Senior @ FAANG: spec-first governance, 3.1 adoption, and the 2026 toolchain

Staff-level work on OpenAPI in 2026 is no longer "write YAML, run swagger-ui, ship." It is governance of a spec that may span hundreds of endpoints, multiple teams, dozens of SDKs, and a public developer portal with SLAs. The decisions that matter are version selection, spec-first versus code-first, linting and CI enforcement, SDK generation strategy, and portal rendering. Get these wrong and you accumulate spec drift that takes a year and an embarrassing outage to unwind.

Version selection. OpenAPI 3.1.1 is the safe default target. It finally aligns the Schema Object with JSON Schema 2020-12, which means `nullable: true` is dead (use `type: ['string', 'null']`), `exclusiveMinimum` is a number not a boolean, `examples` (plural, array) replaces `example` in many contexts, and webhooks are first-class.

OpenAPI 3.2.0 is released, not a preview: it shipped in September 2025 and is the newest feature release. It is a backward-compatible addition to 3.1, so existing 3.1 documents keep working and you opt in to the new pieces. The additions worth knowing are hierarchical tags with standardized `summary`, `parent`, and `kind` metadata (replacing the vendor extensions everyone had invented), first-class streaming via `itemSchema` and `prefixEncoding` with explicit guidance for Server-Sent Events and JSON Lines, `additionalOperations` for documenting non-standard HTTP methods, and security-scheme support for the OAuth 2.0 device authorization flow plus a `deprecated` flag.

The reason to stay on 3.1 anyway is not the spec, it is the ecosystem: generators lag the specification by a long margin, and a feature your document uses is worthless if your SDK generator silently drops it. Verify support in your own pipeline before adopting 3.2 features, particularly in custom internal tooling. That same caution applies one version down: tooling written against 3.0 chokes on type-as-array, so audit it before flipping the version string to 3.1. OpenAPI 4.0 ("Moonwalk") is still in design and is not a 2026 planning concern.

OpenAPI is not the only contract format and a senior engineer picks deliberately. OpenAPI covers request/response HTTP APIs. AsyncAPI covers event-driven and message-broker contracts (Kafka, NATS, MQTT, WebSocket, SSE). JSON:API is a convention layered on top of HTTP APIs that standardizes resource envelopes, relationships, and sparse fieldsets (it solves the "every team invents their own pagination" problem but costs you flexibility). gRPC with Protocol Buffers is a parallel universe. Protobuf is the schema, gRPC is the transport, and tooling like buf handles linting and breaking-change detection. Use OpenAPI for public REST. Use AsyncAPI when you publish Kafka topics or WebSocket channels that external teams consume. Use gRPC for internal service-to-service where you control both sides and want strict typing plus streaming. Mixing is fine and common. Shopify publishes OpenAPI for REST and GraphQL SDL for GraphQL. Google publishes protobuf internally and OpenAPI externally via gnostic.

The design-first versus code-first debate. Design-first means humans write the YAML, then generate servers and clients. Code-first means annotations or reflection on Go types produce the YAML. Design-first wins for public APIs because the spec is the contract and review discipline is easier. Code-first wins for internal APIs with fast iteration because spec drift is physically impossible if the generator runs every build. The hybrid most mature teams land on is "spec-first with generated server stubs, where changing the handler signature forces a spec edit." oapi-codegen v2 in strict-server mode is the idiomatic Go version of this. You write the spec, generate a `ServerInterface`, and the compiler refuses to build until your handlers match. ogen goes further with stricter typing and zero runtime reflection, which matters if you care about allocation profile in a hot path. Huma inverts the model. It is code-first but structurally impossible to produce an invalid spec because the framework owns both sides.

Spec-as-code workflow. Treat the OpenAPI document as source code. Store it in the service repo (not a central "APIs" repo that nobody updates). Lint on every PR with Spectral and a custom ruleset that enforces your style guide. Break-check against the last released version on every PR with `oasdiff` or `openapi-diff`. Publish the rendered documentation from CI to a preview URL for every PR so reviewers see the diff visually, not just in YAML. Regenerate SDKs automatically on tag and publish to language package registries (npm, PyPI, Go module proxy, Maven) with the same version number as the spec. Sign the generated SDKs. Scalar, Bump.sh, and Redocly Realm all offer first-party hosting for this workflow in 2026. Self-hosted Redoc plus a static site hosted on your CDN is the zero-cost alternative and what most internal platforms do.

Spectral is the load-bearing tool. The default ruleset catches obvious sins (missing `operationId`, missing 4xx responses, unused components). The value comes from writing custom rules that encode your API style guide. Rule examples worth writing: "every 4xx response must reference `components/responses/Error`," "every path must have an `operationId` in lowerCamelCase," "no endpoint may return a bare array at the top level (forces envelope)," "every new path must be tagged with a team-owned tag from an allow-list." Stripe publishes a redacted version of their rules. Adobe, DigitalOcean, and Box all publish theirs on GitHub. Fork one that matches your philosophy rather than starting from zero.

Breaking-change classification is the senior-level topic that juniors underestimate. Adding an optional field is non-breaking for consumers. Adding a required request field is breaking. Removing any response field is breaking because a consumer may depend on it. Tightening a `maxLength` is breaking. Changing an enum from open to closed is breaking. Adding an enum value is breaking for strict parsers like ogen and non-breaking for loose parsers like most hand-written clients, so your policy must pick a side and document it. `oasdiff --fail-on ERR` in CI is the enforcement mechanism. The corresponding policy document lives alongside the spec and says "we guarantee additive changes in a major version, and any breaking change bumps the major and ships a migration guide." That is the contract the changelog section of this chapter will operationalize.

Portal rendering choices. Swagger UI is the incumbent, works everywhere, looks dated, and is fine for internal tools. Redoc (now Redocly) produces the three-panel layout that Stripe popularized and renders large specs far better than Swagger UI. Scalar is the 2024-2026 challenger, significantly faster on 10k-line specs, cleaner Try-It panel, and ships as a React component, a CLI-generated static site, or a hosted portal. Elements from Stoplight is the fourth option and strongest if you already use Stoplight Studio for authoring. For a public developer portal with marketing polish, Readme.com and Bump.sh are managed offerings that add auth'd playgrounds, analytics, and versioned docs. Stripe's API Reference is still the gold standard everyone benchmarks against. It is a custom build on top of their own spec with curated examples per-language and real-time request construction. You cannot clone it with a generator but Scalar gets you about eighty percent of the way at a fraction of the engineering cost.

Security schemes deserve a separate mention. The `bearerAuth` plus `apiKey` pattern in the example above is correct for a lot of APIs but misses OAuth2 flows, which are what any B2B platform actually uses. Define `oauth2` schemes with `authorizationUrl`, `tokenUrl`, and `scopes`, then attach `Security: [{oauth2: [scope1, scope2]}]` to each operation that requires specific scopes. The generated documentation will show which scopes each endpoint needs, which is the single most useful auth documentation feature and the one most teams forget. mTLS, request signing (AWS SigV4, Stripe-style), and DPoP are under-represented in OpenAPI 3.1 and are typically documented in prose alongside the spec. OpenAPI 3.2 narrows the gap a little by adding the OAuth 2.0 device authorization flow, security-scheme metadata URLs, and a `deprecated` flag on schemes, but request signing still lands in prose. One related correction worth carrying: OAuth 2.1 is still an IETF draft, not a ratified RFC, so cite it as a draft when you reference it in a security section.

Finally, a warning. The spec is not the documentation. The spec is the machine-readable contract. Documentation is a rendered site with a narrative introduction, authentication walkthrough, quickstart, conceptual guides, endpoint reference, SDKs, changelog, and status page. Stripe's docs team is larger than most startups' entire engineering org for a reason. Treat the OpenAPI document as the foundation, not the ceiling, and budget real writing effort on top of it.

---
