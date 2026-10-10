## Quick Reference Tables

### Built-in Functions

| Function | Purpose |
|----------|---------|
| `append` | Add elements to slice |
| `cap` | Capacity of slice/channel |
| `close` | Close a channel |
| `copy` | Copy slice elements |
| `delete` | Remove map key |
| `len` | Length of collection |
| `make` | Create slice/map/channel |
| `new` | Allocate memory |
| `panic` | Trigger panic |
| `recover` | Catch panic |

### Zero Values by Type

| Type | Zero Value |
|------|------------|
| Numeric | `0` |
| Boolean | `false` |
| String | `""` |
| Pointer | `nil` |
| Slice | `nil` |
| Map | `nil` |
| Channel | `nil` |
| Interface | `nil` |
| Function | `nil` |

### Common Directives

Go compiler directives are special comments that control compilation behavior at the source level, they are processed before the AST is built, meaning they influence the binary without modifying runtime logic. Unlike build tags in older versions, `//go:build` replaces the `// +build` syntax and uses boolean expressions directly. Directives like `//go:noinline` and `//go:linkname` are escape hatches for performance tuning and low-level runtime access, and should be used only when profiling justifies overriding the compiler's decisions.

```go
//go:build linux           // Build constraint
//go:generate mockgen      // Code generation
//go:embed config.json     // Embed file
//go:noinline              // Disable inlining
//go:linkname localName    // Link to runtime symbol
```

---
