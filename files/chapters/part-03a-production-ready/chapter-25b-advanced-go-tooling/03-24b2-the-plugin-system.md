## 25B.2 The Plugin System

### Loading Go Plugins at Runtime

Go's `plugin` package loads shared objects (`.so` files) at runtime and resolves exported symbols by name. The plugin binary is compiled separately with `-buildmode=plugin` and must export either variables or functions, not types, as top-level package-level symbols.

What `Lookup` hands back depends on the kind of symbol, and getting this wrong is the first thing that bites people. For a **variable** it returns a *pointer* to that variable, so `PluginName string` comes back as `*string` and you dereference it. For a **function** it returns the function value itself, so `Process` comes back as `func(string) string` with no pointer involved. Assert the wrong shape and you get a panic from the type assertion, not a helpful error:

```go
sym, _ := p.Lookup("PluginName")  // *string        (variable  -> pointer)
fs, _ := p.Lookup("Process")      // func(string) string (function -> value)
```

```go
// file: myplugin/plugin.go
// Build with: go build -buildmode=plugin -o myplugin.so ./myplugin
package main

import "fmt"

// Exported symbol - must be a variable or function (not a type)
var PluginName = "my-plugin-v1"

// Exported function
func Process(input string) string {
    return fmt.Sprintf("[plugin processed]: %s", input)
}

// A constructor and its type. Read the note below before copying this:
// as written, the host cannot actually use either.
type Processor struct{ prefix string }
func NewProcessor(prefix string) *Processor { return &Processor{prefix: prefix} }
func (p *Processor) Run(s string) string { return p.prefix + ": " + s }
```

That last pair looks useful and is a dead end. Types are not symbols, so `p.Lookup("Processor")` fails with `symbol Processor not found`. The constructor *is* findable, but it comes back typed as `func(string) *main.Processor`, and `main.Processor` here means *the plugin's* `main` package. The host has no such type and no way to name it, so there is nothing to assert to.

The way out is the one that makes plugins usable at all: define the interface in a **shared package** that host and plugin both import, have the plugin export a constructor returning that interface, and assert to the interface in the host.

```go
// file: shared/shared.go - imported by BOTH host and plugin
package shared

type Processor interface {
    Run(s string) string
}
```

```go
// in the plugin: return the SHARED interface, not a plugin-local type
func NewProcessor(prefix string) shared.Processor { return &processor{prefix: prefix} }
```

```go
// in the host: assert to the shared interface
newSym, _ := p.Lookup("NewProcessor")
newProc := newSym.(func(string) shared.Processor)
proc := newProc("svc")
fmt.Println(proc.Run("hello"))
```

Note what this costs: `shared` is now part of the ABI. Both sides must compile it from the identical version, which is the toolchain coupling below arriving in your architecture.

The host program calls `plugin.Open` to load the `.so` file, then `Lookup` to retrieve individual symbols by name. Each symbol comes back as `interface{}`, so a type assertion is required to recover the actual function signature or variable pointer.

```go
// file: main.go - loads the plugin
package main

import (
    "fmt"
    "plugin"
)

func main() {
    // Load the plugin
    p, err := plugin.Open("./myplugin.so")
    if err != nil {
        panic(fmt.Sprintf("failed to open plugin: %v", err))
    }

    // Look up an exported variable
    sym, err := p.Lookup("PluginName")
    if err != nil {
        panic(err)
    }
    name := *sym.(*string) // a VARIABLE comes back as a pointer, so dereference
    fmt.Println("Plugin name:", name)

    // Look up an exported function
    processSym, err := p.Lookup("Process")
    if err != nil {
        panic(err)
    }
    // A FUNCTION comes back as the function value itself, NOT a pointer:
    // asserting to *func(string) string here would panic.
    process := processSym.(func(string) string)
    result := process("hello")
    fmt.Println(result) // [plugin processed]: hello
}
```

### Plugin Limitations: Why Most Go Code Avoids Them

> **Senior track (April 2026)**: The built-in `plugin` package is still Linux, FreeBSD, and macOS only. Windows remains unsupported (`plugin.Open` returns `ErrNotSupported`). The ABI is fragile across Go versions, even patch releases can break a plugin built against an earlier toolchain because internal packages (e.g. `internal/abi`, `internal/goarch`) must match byte-for-byte. Go 1.26 did not change this. If you see the error "plugin was built with a different version of package internal/goarch" you have a toolchain mismatch, there is no workaround other than rebuilding both sides in lockstep. For any new system, default to out-of-process extensibility (hashicorp/go-plugin, gRPC, or WebAssembly via wazero) rather than the `plugin` package.

Go's built-in plugin system carries a set of hard constraints that make it unsuitable for most production use cases. The most critical is the strict toolchain coupling: both the host binary and every plugin must be compiled with the exact same Go version, the same build flags, and the same transitive dependency graph. A mismatch is caught at `plugin.Open` rather than at compile time.

Be precise about the failure mode, because it changes how you handle it: `plugin.Open` **returns an error**, it does not panic. A corrupt or mismatched object yields something like `plugin.Open("./p.so"): ELF file version does not match current one`, or the familiar `plugin was built with a different version of package internal/goarch`, and your program keeps running and can decide what to do. That makes the failure survivable, which is the one piece of good news in this list: a plugin that will not load can be skipped and reported rather than taking the host down. The panics people remember come from the *type assertion* after a successful `Lookup`, not from `Open`.

Combined with the absence of an unload mechanism (loaded plugins occupy memory for the process lifetime) and support limited to Linux, macOS, and FreeBSD, these restrictions push production systems toward subprocess-based alternatives like `hashicorp/go-plugin`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              Go Plugin System Limitations                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  RESTRICTION 1: Linux, macOS and FreeBSD only                           │
│  - Windows is NOT supported (plugin package returns ErrNotSupported)    │
│                                                                         │
│  RESTRICTION 2: Same Go toolchain version                               │
│  - Plugin and main binary must be built with the EXACT same             │
│    Go version, build flags, and module dependencies                     │
│  - Mismatch = plugin.Open returns an ERROR (it does not panic),         │
│    so the host can skip the plugin and keep running                     │
│                                                                         │
│  RESTRICTION 3: Once loaded, never unloaded                             │
│  - Go has no plugin.Unload()                                            │
│  - Loading many plugins causes unbounded memory growth                  │
│                                                                         │
│  RESTRICTION 4: Shared global state                                     │
│  - init() functions in the plugin run on load                           │
│  - Package-level variables are shared across plugin instances           │
│                                                                         │
│  RESTRICTION 5: CGO complications                                       │
│  - Plugins cannot use CGO if the main binary uses CGO differently       │
│                                                                         │
│  BETTER ALTERNATIVES:                                                   │
│  • gRPC/gRPC-plugin: run extensions as separate processes               │
│  • hashicorp/go-plugin: industrial-strength plugin over RPC             │
│  • WebAssembly (wazero): sandbox plugins with WASM                      │
│  • Interfaces: define behavior in shared package, compile statically    │
└─────────────────────────────────────────────────────────────────────────┘
```

### hashicorp/go-plugin: Production-Grade Plugin Pattern

`hashicorp/go-plugin` sidesteps every limitation of the Go `plugin` package by running each plugin as a subprocess communicating over gRPC or `net/rpc`. Plugins can be written in any language that speaks the wire protocol, they can be stopped and restarted without restarting the host, and a misbehaving plugin crashes its own process rather than taking down the host.

```go
// The hashicorp/go-plugin approach: plugins are separate processes
// communicating over gRPC or net/rpc. This avoids ALL Go plugin limitations.

// file: shared/interface.go - shared between host and plugin
package shared

// Greeter is the interface that plugins must implement
type Greeter interface {
    Greet(name string) string
}

// file: host/main.go
package main

import (
    "fmt"
    "os/exec"

    "github.com/hashicorp/go-plugin"
    "myapp/shared"
)

func main() {
    client := plugin.NewClient(&plugin.ClientConfig{
        HandshakeConfig: plugin.HandshakeConfig{
            ProtocolVersion:  1,
            MagicCookieKey:   "BASIC_PLUGIN",
            MagicCookieValue: "hello",
        },
        Plugins: map[string]plugin.Plugin{
            "greeter": &shared.GreeterPlugin{},
        },
        Cmd: exec.Command("./plugins/my-greeter"),
    })
    defer client.Kill()

    rpcClient, _ := client.Client()
    raw, _ := rpcClient.Dispense("greeter")

    greeter := raw.(shared.Greeter)
    fmt.Println(greeter.Greet("World")) // runs in the plugin process!
}
```

### Staff Lens: Go's Plugin Package Is Rarely the Answer

Go's `plugin` package works on Linux, macOS, and FreeBSD but not Windows, and it is fragile and hard to distribute: host and plugin must be built in lockstep, and nothing can ever be unloaded. Alternatives (subprocess plus gRPC, WebAssembly via wazero, hashicorp/go-plugin) are more reliable in most cases. Reach for `plugin` only when you genuinely need in-process runtime loading and you control both sides of the build.

---
