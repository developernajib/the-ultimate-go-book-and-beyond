## Compatibility Notes

### GODEBUG Settings for Backward Compatibility

The `GODEBUG` environment variable lets you opt a running program back into the behavior of an older Go version for specific features, providing an escape valve when an upgrade changes runtime semantics in a way that breaks existing code. This is particularly valuable during incremental migrations: you can ship a binary built with the latest toolchain while keeping one problematic behavior pinned to its previous semantic until the code is ready to adapt.

```bash
# go/types tooling: represent aliases without Alias nodes (pre-1.23 behavior)
GODEBUG=gotypesalias=0 go run main.go

# HTTP/2 settings
GODEBUG=http2client=0  # Disable HTTP/2 client
GODEBUG=http2server=0  # Disable HTTP/2 server

# TLS settings
GODEBUG=tls10server=1  # Re-enable TLS 1.0 server support (off by default since Go 1.22)
GODEBUG=tlsrsakex=1    # Re-enable RSA key exchange cipher suites (off by default since Go 1.22)
```

One important non-GODEBUG case: the Go 1.22 loop-variable semantics are gated by the `go` directive in `go.mod`, not by GODEBUG. A module declaring `go 1.21` keeps the old shared-variable behavior even when built with a newer toolchain, which is the supported way to defer that migration.

### Language Version in go.mod

The `go` directive in `go.mod` sets the minimum language version required to build the module and also governs which language features the compiler enables for packages in the module. Adding a `toolchain` directive pins the exact Go release used to build and test the project, so all contributors and CI systems use consistent compiler behavior even when newer toolchains are locally installed.

```go
// Specify minimum Go version
module example.com/myapp

go 1.23

// Use toolchain directive for exact version
toolchain go1.23.1
```

### Version-Specific Build Tags

When a new Go release introduces syntax or standard library features that are unavailable on older toolchains, version-specific build tags let you provide a forward-compatible implementation in one file while keeping a fallback in another. The `//go:build go1.23` constraint is evaluated by the compiler against the declared module language version, ensuring the file containing the newer feature is silently excluded on toolchains that cannot compile it.

```go
//go:build go1.23

package main

// This file only builds with Go 1.23+
func useNewFeature() {
    for v := range myIterator {
        fmt.Println(v)
    }
}
```

---
