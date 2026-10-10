## 102Q.11 WebAssembly Component Model and WASI 2.0

The original WASM module system treats every `.wasm` file as an isolated unit. Sharing data between two modules required memory tricks and manual ABI negotiation. WASI Preview 2 (WASIp2) and the **Component Model** fix this at the standard level, enabling WASM modules from different languages to compose together as cleanly as linking shared libraries.

### WASI Preview 2 (WASIp2)

WASI Preview 1 (`wasip1`) exposed a flat POSIX-like syscall table. WASIp2 replaces that with a **typed capability interface** modeled around the Component Model. Key differences:

| Feature | WASI Preview 1 | WASI Preview 2 |
|---------|---------------|----------------|
| Interface style | POSIX-like flat ABI | Typed, interface-driven |
| Memory sharing | Manual pointer passing | Component-level value types |
| Composability | None | First-class via `wasm-tools compose` |
| Async support | None | `wasi:io/poll` with streams |
| Language support | Go, Rust, C | Rust (stable), Go (TinyGo WIP), Python |

As of early 2025, TinyGo has experimental WASIp2 support via the `wasip2` build target. Standard `gc` Go is expected to follow in a later release cycle.

### The WebAssembly Component Model

The Component Model defines a **two-layer architecture**:

1. **Core modules** - classic `.wasm` binaries with linear memory and numeric types only.
2. **Components** - wrappers around one or more core modules that expose rich typed interfaces (strings, records, variants, lists) and import/export capabilities described in WIT.

Think of components like LEGO bricks: each exposes typed connectors, and the runtime snaps them together without manual glue code.

```
┌─────────────────────────────────────────┐
│            Component (Go)               │
│  ┌───────────────────────────────────┐  │
│  │     Core Module (TinyGo wasm)     │  │
│  └───────────────────────────────────┘  │
│  exports: process-record(Record) → bool │
│  imports: wasi:logging/log              │
└─────────────────────────────────────────┘
          ▼ composed with ▼
┌─────────────────────────────────────────┐
│           Component (Rust)              │
│  exports: wasi:logging/log              │
└─────────────────────────────────────────┘
```

### WIT: WebAssembly Interface Types

WIT (Wasm Interface Type) is the IDL (Interface Definition Language) for components. You define your component's contract in a `.wit` file. tooling generates the host/guest bindings for each language.

```wit
// validator.wit
package example:validator@1.0.0;

interface types {
    record user-record {
        id: u64,
        email: string,
        age: u8,
    }

    variant validation-error {
        invalid-email(string),
        underage(u8),
        missing-field(string),
    }
}

world validator {
    use types.{user-record, validation-error};

    export validate: func(record: user-record) -> result<bool, validation-error>;
}
```

WIT supports: primitive scalars, `string`, `list<T>`, `option<T>`, `result<T, E>`, `record`, `variant`, `enum`, `flags`, and resource handles (for reference-counted objects).

### Building a Go Component with TinyGo

TinyGo's `wasip2` target (experimental, ≥0.33) can produce Component Model-compatible output when combined with `wit-bindgen` for Go.

```bash
# Prerequisites
go install github.com/bytecodealliance/wit-bindgen-go/cmd/wit-bindgen-go@latest
tinygo version   # >= 0.33

# Generate Go bindings from the WIT file
wit-bindgen-go generate --world validator --out ./bindings ./validator.wit

# Resulting files:
#   bindings/validator/validator.go      (imports/exports stubs)
#   bindings/example/validator/types/    (generated type definitions)
```

The generated bindings expose typed Go functions you implement:

```go
// main.go - TinyGo component implementing the validator world
package main

import (
    "example.com/myvalidator/bindings/example/validator/types"
    validatorworld "example.com/myvalidator/bindings/validator"
)

// Compile-time assertion that we implement the interface
var _ validatorworld.Exports = (*ValidatorImpl)(nil)

type ValidatorImpl struct{}

func (v *ValidatorImpl) Validate(r types.UserRecord) (bool, *types.ValidationError) {
    if r.Age < 18 {
        err := types.ValidationErrorUnderage(r.Age)
        return false, &err
    }
    if !isValidEmail(r.Email) {
        err := types.ValidationErrorInvalidEmail(r.Email)
        return false, &err
    }
    return true, nil
}

func isValidEmail(email string) bool {
    // simplified check
    for _, ch := range email {
        if ch == '@' {
            return true
        }
    }
    return false
}

func main() {} // required by TinyGo; component entry point is the WIT export

func init() {
    validatorworld.SetExports(&ValidatorImpl{})
}
```

```bash
# Build the component
tinygo build \
  -target=wasip2 \
  -o validator.wasm \
  -scheduler=none \
  -no-debug \
  .

# Inspect the component
wasm-tools component wit validator.wasm
```

### Composing Go + Rust + Python Components

`wasm-tools compose` wires components together at build time by matching exported names from one component to imported names in another:

```bash
# validator.wasm  - Go (validates records)
# logger.wasm     - Rust (implements wasi:logging/log)
# pipeline.wasm   - Python (orchestrates: calls validator, logs result)

wasm-tools compose \
  pipeline.wasm \
  --adapt logger.wasm \
  --adapt validator.wasm \
  -o composed.wasm

# Run the composed component
wasmtime run composed.wasm
```

No shared memory tricks, no FFI, no ABI mismatch - the runtime links the typed interfaces automatically. This is the primary mechanism for **plugin systems** in Go applications: ship a `.wasm` component, and the host loads it with guaranteed interface compliance.

### Wasmtime and the WASI SDK for Server-Side WASM

Wasmtime is the reference implementation for running WASM components outside the browser:

```go
// Embedding Wasmtime in a Go host application (server-side plugin host)
// go get github.com/bytecodealliance/wasmtime-go/v23

package plugin

import (
    "fmt"
    "os"

    wasmtime "github.com/bytecodealliance/wasmtime-go/v23"
)

// PluginHost loads and runs a WASM component as a sandboxed plugin
type PluginHost struct {
    engine *wasmtime.Engine
    store  *wasmtime.Store
    module *wasmtime.Module
}

func NewPluginHost(wasmPath string) (*PluginHost, error) {
    cfg := wasmtime.NewConfig()
    cfg.SetWasmComponent(true)        // enable Component Model
    cfg.SetConsumeFuel(true)          // enable fuel (CPU budgeting)

    engine := wasmtime.NewEngineWithConfig(cfg)
    store := wasmtime.NewStore(engine)

    // Budget: 1 billion fuel units ≈ ~1s of compute on modern hardware
    if err := store.SetFuel(1_000_000_000); err != nil {
        return nil, fmt.Errorf("set fuel: %w", err)
    }

    wasmBytes, err := os.ReadFile(wasmPath)
    if err != nil {
        return nil, fmt.Errorf("read wasm: %w", err)
    }

    mod, err := wasmtime.NewModule(engine, wasmBytes)
    if err != nil {
        return nil, fmt.Errorf("compile wasm module: %w", err)
    }

    return &PluginHost{engine: engine, store: store, module: mod}, nil
}

// Remaining fuel can be checked after each call for metering
func (h *PluginHost) RemainingFuel() (uint64, error) {
    return h.store.GetFuel()
}
```

### Use Cases Beyond the Browser

| Use Case | Why WASM/WASI |
|----------|--------------|
| Plugin systems | Sandboxed untrusted code, typed interfaces via Component Model |
| Serverless portability | Same binary runs on Fastly, Cloudflare, Fermyon Spin |
| Language-neutral microservices | Compose Go + Rust + Python logic without containers |
| Edge functions | Sub-millisecond startup, no OS, tiny footprint |
| Data pipeline transforms | User-supplied transforms executed safely inside the server |
| CI/CD script runners | Run arbitrary build scripts without Docker overhead |

---

### Junior → FAANG: Component Model as the Future Architecture for Edge and Plugin Systems

The WebAssembly Component Model is in active development and is not yet mainstream, but understanding it now provides a significant advantage. The core insight is that the Component Model solves the problem that made WASM composition difficult: the ABI negotiation problem. Without the Component Model, two WASM modules sharing data had to agree on a shared memory layout and byte encoding by convention. With the Component Model, interfaces are defined in WIT (WebAssembly Interface Types), and the toolchain generates the serialization code automatically. This is the same problem that protobuf solved for gRPC, and the Component Model's WIT solves it for WASM composition.

The practical learning path: understand WIT interface definitions (they read like a combination of Go interfaces and protobuf service definitions), understand the `wasm-tools` and `wit-bindgen` toolchain for generating Go bindings from WIT, and understand how `wasmtime serve` uses the Component Model to implement WASI HTTP for running WASM-based web services. These three concepts together cover the Component Model's current practical surface.

### Senior @ FAANG: Component Model as a Platform Architecture Investment

At staff level, the Component Model changes the cost-benefit calculation for WASM adoption in platform systems. The original WASM module format was well-suited for single-language sandboxed computation but required significant engineering to compose modules written in different languages. The Component Model's WIT interface system reduces the composition problem to writing interface definitions and running a code generator, which is a 10x reduction in integration effort.

The strategic implication for platform teams: the Component Model makes it feasible to build plugin systems where plugin authors work in their language of choice (Go, Rust, Python, JavaScript) and the platform composes the plugins without language-specific integration code. This is architecturally similar to how gRPC enables polyglot services without language-specific transport code. The organizations that invest in Component Model expertise now will have a significant advantage when the ecosystem reaches maturity, because they will have the toolchain, the interface design experience, and the operational patterns in place.

The use case table in this section (plugin systems, serverless portability, language-neutral microservices) is an input to an organizational evaluation: which of these use cases does the organization currently solve with a more expensive solution? Plugin systems built with process isolation (each plugin runs in a container) have significant overhead compared to WASM sandboxing. Language-neutral microservices composed via REST or gRPC have serialization overhead at every service boundary that WASM composition eliminates for in-process calls. The staff engineer's job is to identify the one or two use cases where the Component Model's properties match an organizational pain point, prototype the solution, measure the improvement, and use the evidence to justify a broader investment.
