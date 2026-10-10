## Complete Reference: 50 Shades of Go (Kyle Quest)

The following gotchas are from Kyle Quest's *"50 Shades of Go: Traps, Gotchas, and Common Mistakes for New Golang Devs"*, organized by developer experience level. These gotchas focus on language-level surprises that trip up developers coming from other languages like Python, Java, or C++. The beginner sections cover compile-time rules that Go enforces strictly, while the intermediate and advanced sections address runtime behaviors that can cause subtle bugs if you are not aware of them.

### Total Beginner Gotchas

| Gotcha | Description | Solution |
|--------|-------------|----------|
| Opening brace placement | Can't place `{` on separate line | Keep `{` on same line as function/if/for |
| Unused variables | Unused local variables cause compile error | Use `_` or remove the variable |
| Unused imports | Unused imports cause compile error | Use `goimports` or blank identifier |
| Short declaration scope | `:=` only works inside functions | Use `var` at package level |
| Redeclaring variables | Can't use `:=` without new variable | Use `=` for reassignment |
| Short declaration for fields | Can't use `:=` with struct fields | Use `var` and `=` |
| Accidental variable shadowing | `:=` in inner scope creates new variable | Use `go vet -shadow` |
| nil without type | Can't use `nil` without explicit type | Specify the type |
| nil slices vs maps | Append to nil slice OK, write to nil map panics | Initialize maps with `make()` |
| Map capacity | Can create map with capacity but can't query it | Capacity is optimization hint only |
| nil strings | Strings can't be nil | Use empty string `""` |
| Array function arguments | Arrays are copied when passed | Use slices or pointers |
| Range clause values | First value is index, second is copy of element | Use `for _, v := range` |
| One-dimensional slices/arrays | Go only has 1D slices, multi-D requires nesting | Create slice of slices |
| Non-existing map keys | Missing key returns zero value | Use comma-ok idiom |
| Immutable strings | Can't modify string characters directly | Convert to `[]byte` first |
| String/byte slice conversion | Conversion creates a copy | Avoid unnecessary conversions |
| String index operator | Index returns byte, not character | Use range for rune iteration |
| Strings not always UTF-8 | Strings can contain arbitrary bytes | Validate with `utf8.ValidString()` |
| String length | `len()` returns bytes, not runes | Use `utf8.RuneCountInString()` |
| Multi-line literal commas | Trailing comma required on last element | Always include trailing comma |
| log.Fatal/log.Panic | These functions exit the program | Use only for true fatal errors |
| Unsynchronized data structures | Maps/slices not thread-safe | Use sync primitives |
| String range iteration | Index is byte position, not rune index | Be aware when working with non-ASCII |
| Map iteration order | Map iteration order is random | Sort keys if order needed |
| Switch fallthrough | Cases don't fall through by default | Use `fallthrough` keyword |
| Increment/decrement | No prefix `++i`, can't use in expressions | Use postfix only, separate statement |
| Bitwise NOT operator | Use `^` not `~` for bitwise NOT | `^x` for unary NOT |
| Operator precedence | Different from C/C++ | Use parentheses when in doubt |
| Unexported fields encoding | Lowercase fields not serialized | Capitalize or use json tags |
| App exits with goroutines | Main doesn't wait for goroutines | Use sync.WaitGroup or channels |
| Unbuffered channel send | Send returns when receiver ready, not done | Account for this in design |
| Send to closed channel | Causes panic | Coordinate channel closure carefully |
| nil channels | Send/receive block forever | Use as disable mechanism in select |
| Value receiver methods | Can't modify original value | Use pointer receiver |

### Intermediate Beginner Gotchas

| Gotcha | Description | Solution |
|--------|-------------|----------|
| HTTP response body | Must close even for empty responses | `defer resp.Body.Close()` after error check |
| HTTP connection reuse | Not reading body prevents reuse | Drain body: `io.Copy(io.Discard, resp.Body)` |
| JSON encoder newline | `json.Encoder` adds trailing newline | Use `json.Marshal` for exact output |
| JSON HTML escaping | `<`, `>`, `&` escaped by default | Use `SetEscapeHTML(false)` |
| JSON number to interface | Numbers become `float64` | Use `UseNumber()` or decode to struct |
| JSON non-UTF-8 strings | Only UTF-8 escape sequences valid | Ensure valid UTF-8 |
| Struct/array comparison | Can compare if fields comparable | Slices/maps not comparable |
| Panic recovery | Only works in same goroutine | Recover in deferred function |
| Range value update | Updating range variable doesn't modify original | Use index to modify |
| Hidden slice data | Subslice shares backing array | Use `copy()` for independence |
| Slice data corruption | Multiple slices sharing backing array | Be aware of shared storage |
| Stale slices | Append may not affect original slice | Return new slice from function |
| Type declarations | New types don't inherit methods | Must redefine methods |
| Break in for-switch/for-select | Break only exits switch/select | Use labeled break |
| Loop variable capture | Closure captures variable, not value | Copy or use Go 1.22+ |
| Deferred argument evaluation | Arguments evaluated at defer, not call | Use closure for late binding |
| Deferred call execution | Executed in LIFO order at function return | Be aware of order |
| Failed type assertions | Panics without comma-ok | Always use two-value form |
| Blocked goroutines | Can cause resource leaks | Ensure goroutines can exit |
| Zero-sized variables | May share same address | Don't rely on address uniqueness |
| iota first value | First iota not always zero | Explicit about enum values |

### Advanced Beginner Gotchas

| Gotcha | Description | Solution |
|--------|-------------|----------|
| Pointer receiver on value | Go auto-dereferences for method calls | Understand addressability |
| Map value field update | Can't modify fields of map values directly | Use pointer values or reassign |
| nil interface vs nil concrete | Interface with nil concrete != nil interface | Check concrete value |
| Stack vs heap variables | Compiler decides allocation location | Don't assume, profile |
| GOMAXPROCS default | Defaults to number of CPUs | May need tuning |
| Read/write reordering | Compiler/CPU may reorder operations | Use sync primitives |
| Preemptive scheduling | Goroutines can be preempted | Don't assume execution order |

### Cgo Gotchas

| Gotcha | Description | Solution |
|--------|-------------|----------|
| Import C block | Must be single-line import | Use separate import statement |
| Cgo comment spacing | No blank line before `import "C"` | Keep comment attached |
| C variadic functions | Can't call C variadic functions directly | Use C wrapper |

---
