## 46.1 gRPC-Gateway Fundamentals

### What is gRPC-Gateway?

gRPC-Gateway generates an HTTP multiplexer from the same `.proto` file as the gRPC service, using `google.api.http` annotations to map HTTP methods and URL paths to RPC methods. A single `protoc` invocation with `protoc-gen-grpc-gateway` produces both the Go gateway handler and an OpenAPI spec, keeping the REST contract synchronized with the protobuf schema.

```go
package main

/*
gRPC-Gateway:
- Translates RESTful HTTP/JSON to gRPC
- Generates reverse proxy from protobuf annotations
- Supports custom path mappings and query parameters
- Enables same service to serve gRPC and REST

Benefits:
- Single service implementation
- Consistent behavior across protocols
- Browser-friendly REST endpoints
- OpenAPI specification generation
- Gradual migration from REST to gRPC

Architecture:
                ┌─────────────────┐
   gRPC Client ─►│   gRPC Server   │
                └─────────────────┘
                        ▲
                        │
   REST Client ─►│ gRPC-Gateway  │──► gRPC Server
                 │ (HTTP Proxy)  │
                 └───────────────┘
*/
```

### Installation and Setup

The gRPC-Gateway toolchain requires three `protoc` plugins: `protoc-gen-go` for Go types, `protoc-gen-go-grpc` for gRPC stubs, and `protoc-gen-grpc-gateway` for the HTTP mux. All three must be present on `$PATH` and their versions must be pinned in `tools.go` to ensure reproducible code generation across the team.

```bash
# Install protoc plugins
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@latest
go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@latest
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest

# Or use buf
# buf.gen.yaml handles all plugin configuration
```

### buf.gen.yaml Configuration

Using `buf` instead of raw `protoc` invocations simplifies plugin management. The `buf.gen.yaml` file declares all code generation plugins, their output directories, and options in one place. Running `buf generate` then produces Go types, gRPC stubs, gateway handlers, and OpenAPI specs in a single pass.

```yaml
# buf.gen.yaml
version: v1
managed:
  enabled: true
  go_package_prefix:
    default: github.com/myapp/gen
plugins:
  # Generate Go protobuf code
  - plugin: buf.build/protocolbuffers/go
    out: gen
    opt: paths=source_relative

  # Generate gRPC Go code
  - plugin: buf.build/grpc/go
    out: gen
    opt: paths=source_relative

  # Generate gRPC-Gateway code
  - plugin: buf.build/grpc-ecosystem/gateway
    out: gen
    opt:
      - paths=source_relative
      - generate_unbound_methods=true

  # Generate OpenAPI spec
  - plugin: buf.build/grpc-ecosystem/openapiv2
    out: gen/openapi
    opt:
      - allow_merge=true
      - merge_file_name=api
```

### Junior -> FAANG: Toolchain Setup as a Signal of Engineering Maturity

The installation section shows two paths: raw `protoc` invocations and `buf`. Most tutorials show `protoc` first because it is the lowest-level tool, but in practice every team that uses gRPC at scale moves to `buf` quickly. Knowing why is the first signal of maturity.

Raw `protoc` requires manually specifying include paths (`-I` flags) for every proto dependency, including `google/api/annotations.proto` which grpc-gateway needs. When a new developer joins the team and their environment has a different `protoc` version or a different include path layout, code generation fails in ways that are confusing to debug. `buf` solves this by encoding all dependency resolution in `buf.yaml` and `buf.gen.yaml`, making code generation reproducible across machines.

The `buf.gen.yaml` example in this section uses remote plugins from `buf.build`. That means the plugin binary is downloaded from the BSR (Buf Schema Registry) at generation time, pinned by a digest, and cached locally. No manual `go install` is needed. When you audit the `buf.gen.yaml` file you see the exact version of every plugin, which satisfies reproducibility requirements for security-conscious teams.

Habits to build for your first job:

- Never run `buf generate` (or `protoc`) manually in a shell and commit the output separately. Add a `make generate` or `go generate` target and run it in CI. Generated code checked into the repo should match exactly what CI produces.
- Add a CI step that runs `buf generate` and checks for a diff. If the diff is non-empty, fail the build. This ensures nobody edits generated files by hand.
- Understand what `paths=source_relative` does in the `opt` field. It controls whether the generated files are placed in paths relative to the proto source or relative to the module root. Getting this wrong produces import paths that do not match the module name, causing build failures that are misleading.

Interview entry point: if asked "how do you set up proto code generation for a team," the answer mentions `buf`, `buf.gen.yaml` for plugin config, `buf.yaml` for dependency pinning, and a CI check for generated code drift.

### Senior @ FAANG: Governing Code Generation Across a Multi-Team Organization

At scale, the grpc-gateway toolchain setup becomes a governance problem, not a personal workflow problem. A senior engineer's job is to make the right setup easy and the wrong setup impossible.

The `buf.gen.yaml` file has a `go_package_prefix` under `managed`. This controls the `go_package` option that gets injected into generated files. If every team sets a different prefix, generated packages have inconsistent import paths, which breaks cross-team proto imports and makes a shared Go module layout impossible. The platform team should either mandate a standard prefix or provide a shared `buf.gen.yaml` template that teams include.

The BSR (Buf Schema Registry) is the correct home for shared protos (error types, common message schemas, the `google.api` annotations). Teams that copy `google/api/annotations.proto` into their own repo are creating a maintenance problem: when the canonical version is updated, their copy diverges. The correct model is to declare the BSR module as a dependency in `buf.yaml` and let `buf` manage the version.

Plugin version pinning in `buf.gen.yaml` is a security control, not just a reproducibility control. A plugin that generates Go code runs arbitrary code during `buf generate`. If the plugin version is unpinned, a supply chain attack that poisons the latest version of `protoc-gen-grpc-gateway` would silently generate malicious gateway code. Pin versions, verify the digest in your supply chain audit, and treat plugin updates as a dependency upgrade that requires a review.

The `generate_unbound_methods=true` option in the gateway plugin is worth knowing about. By default, RPC methods without `google.api.http` annotations are not exposed by the gateway. With `generate_unbound_methods=true`, unbound methods are exposed at a generated path. This is useful during development but dangerous in production: a developer who forgot to add annotations will accidentally expose internal RPCs to REST clients. The platform default should leave this option off and enforce annotations via `buf lint`.

ADR question: should the platform maintain a central `buf.gen.yaml` that all services use, or should each service own its own? The central model ensures consistency but means any change to generation options requires a platform review. The per-service model gives teams autonomy but risks divergence. A pragmatic middle path is a base template that teams extend, with `buf lint` enforcing that all extensions are additive and do not override platform-required settings.

---
