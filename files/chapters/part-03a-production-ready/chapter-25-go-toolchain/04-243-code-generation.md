## 25.3 Code Generation

### go generate

`go generate` reads `//go:generate` directives embedded in Go source files and executes the specified commands. Unlike the build system, it is not automatic, you run it explicitly before committing generated code. Common use cases include generating `String()` methods for constants with `stringer`, creating mock implementations with `mockgen`, and compiling Protocol Buffer definitions with `protoc`.

Understand what a bare directive actually does before you rely on it. `//go:generate stringer -type=Status` runs whatever `stringer` happens to be first on your `PATH`. That is not pinned by `go.mod`, not recorded anywhere, and not necessarily the same binary your colleague or CI has. Different versions of a generator emit different code, which surfaces as a diff nobody intended in a PR that touched something else entirely.

Since Go 1.24, the fix is the `tool` directive from 25.1. Declare the generator in `go.mod` and invoke it through `go tool`, and the version is pinned by the module, resolved from the module cache, and identical everywhere:

```go
//go:generate go tool stringer -type=Status
//go:generate go tool mockgen -source=interfaces.go -destination=mocks/mocks.go
```

`protoc` stays outside this, because it is a C++ binary rather than a Go module. Pin it in your container image or your Makefile instead, and note that its Go plugins (`protoc-gen-go`, `protoc-gen-go-grpc`) *are* Go tools and belong in the `tool` block.

```go
//go:generate go tool stringer -type=Status
//go:generate go tool mockgen -source=interfaces.go -destination=mocks/mocks.go
//go:generate protoc --go_out=. --go-grpc_out=. api.proto

package main

type Status int

const (
    StatusPending Status = iota
    StatusActive
    StatusCompleted
    StatusFailed
)
```

```bash
# Run all generators
go generate ./...

# Run for specific package
go generate ./internal/...

# Verbose mode
go generate -v ./...

# Show commands without running
go generate -n ./...
```

### Embed Files

The `//go:embed` directive bundles files and directories into the compiled binary at build time using the `embed.FS` type. Embedding static assets, configuration files, or HTML templates eliminates the need to deploy them separately alongside the binary, producing a truly self-contained executable. `fs.Sub` extracts a subdirectory of an embedded FS, which is useful for serving embedded static files at a path-stripped URL prefix.

Three patterns that look equivalent are not, and the difference decides whether you ship your secrets:

| Pattern | `app.js` | `.hidden` | `_internal.js` |
|---|---|---|---|
| `//go:embed static` | yes | no | no |
| `//go:embed static/*` | yes | **yes** | **yes** |
| `//go:embed all:static` | yes | yes | yes |

Naming a directory excludes entries beginning with `.` or `_`, and `all:` explicitly opts back in. But `static/*` is a glob, and a glob matches dotfiles like any other name, so it quietly behaves like `all:`. That is the trap: a stray `.env`, `.git`, or `.DS_Store` under `static/` gets compiled into your binary and shipped, and an embedded file is trivially recoverable with `strings`. Nothing warns you.

Prefer `//go:embed static` unless you have a reason to want the dotfiles, keep build inputs in a directory that contains only build inputs, and if you must glob, verify what landed inside:

```go
fs.WalkDir(staticFiles, ".", func(p string, d fs.DirEntry, err error) error {
    if err == nil && !d.IsDir() {
        fmt.Println("embedded:", p) // run once, read it, then delete this
    }
    return nil
})
```

```go
package main

import (
    "embed"
    "fmt"
    "io/fs"
    "net/http"
)

//go:embed static/*
var staticFiles embed.FS

//go:embed config.yaml
var configFile string

//go:embed templates/*.html
var templateFiles embed.FS

func main() {
    // Serve embedded static files
    staticFS, _ := fs.Sub(staticFiles, "static")
    http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))

    // Use embedded config
    fmt.Println(configFile)
}
```

### Staff Lens: Generated Code Is Code

Generated code belongs in source control. CI should regenerate and compare to detect drift. Never hand-edit generated files. Changes are lost on regeneration.

---
