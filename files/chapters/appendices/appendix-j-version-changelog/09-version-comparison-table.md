## Version Comparison Table

The following matrix summarizes the progression of major language features, runtime capabilities, and standard library packages introduced from Go 1.18 through Go 1.24.

| Feature / Capability | Go 1.18 | Go 1.19 | Go 1.20 | Go 1.21 | Go 1.22 | Go 1.23 | Go 1.24 |
|----------------------|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|:-------:|
| **Generics (Type Parameters)** | ✓ | - | - | - | - | - | - |
| **Native Fuzz Testing (`testing.F`)** | ✓ | - | - | - | - | - | - |
| **Multi-Module Workspaces (`go.work`)** | ✓ | - | - | - | - | - | - |
| **Netip Package (`net/netip`)** | ✓ | - | - | - | - | - | - |
| **Atomic Types (`sync/atomic.Int64`)** | - | ✓ | - | - | - | - | - |
| **Revised Memory Model** | - | ✓ | - | - | - | - | - |
| **Soft Memory Limit (`GOMEMLIMIT`)** | - | ✓ | - | - | - | - | - |
| **Profile-Guided Optimization (PGO)** | - | - | Preview | GA | Enhanced | Enhanced | Enhanced |
| **Multi-Error Wrapping (`errors.Join`)** | - | - | ✓ | - | - | - | - |
| **Slice-to-Array Pointer Conversion** | - | - | ✓ | - | - | - | - |
| **Built-ins: `min`, `max`, `clear`** | - | - | - | ✓ | - | - | - |
| **Structured Logging (`log/slog`)** | - | - | - | ✓ | - | - | - |
| **Standard `slices` & `maps` Packages** | - | - | - | ✓ | - | - | - |
| **Toolchain Management (`GOTOOLCHAIN`)** | - | - | - | ✓ | - | - | - |
| **For-Loop Per-Iteration Variable Scoping**| - | - | - | - | ✓ | - | - |
| **Enhanced `net/http.ServeMux` Routing** | - | - | - | - | ✓ | - | - |
| **Range Over Integer (`range 10`)** | - | - | - | - | ✓ | - | - |
| **New PRNG Package (`math/rand/v2`)** | - | - | - | - | ✓ | - | - |
| **Range-Over-Func Iterators (`iter.Seq`)**| - | - | - | - | - | ✓ | - |
| **Timer / Ticker Channel Leak Resolution**| - | - | - | - | - | ✓ | - |
| **Value Interning (`unique.Make`)** | - | - | - | - | - | ✓ | - |
| **Generic Type Aliases** | - | - | - | - | - | - | ✓ |
| **SwissMap Internal Hash Table** | - | - | - | - | - | - | ✓ |
| **Weak Pointers (`weak.Pointer`)** | - | - | - | - | - | - | ✓ |
| **Directory-Scoped Benchmarks (`b.Loop`)** | - | - | - | - | - | - | ✓ |
| **Tool Dependencies (`tool` in `go.mod`)** | - | - | - | - | - | - | ✓ |

---
