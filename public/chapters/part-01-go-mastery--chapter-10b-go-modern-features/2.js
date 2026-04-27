export default `## Architecture Overview

Go's recent releases represent a deliberate shift from language additions toward runtime and toolchain performance. Go 1.23 introduced range-over-func iterators, enabling lazy, composable sequences without heap-allocating a slice first. Go 1.24's Swiss Table map implementation replaced the bucket-chaining hash map with an open-addressing design that uses SIMD probing to achieve an 87.5% load factor with lower memory overhead and faster lookups. Go 1.26's Green Tea GC targets the most common latency complaint in production Go services, excessive GC pause overhead, by reducing it 10-40% through better region-based reclamation.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────┐
│              Go 1.23–1.26 Feature Map                                   │
│                                                                          │
│  Go 1.23 ─────────────────────────────────────────────────────────     │
│  ├── Range-over-func (rangefunc)                                         │
│  ├── iter.Seq / iter.Seq2 types                                          │
│  ├── slices.All, slices.Values, maps.All iterators                      │
│  └── Timer/Ticker fixes (stop/reset behavior)                           │
│                                                                          │
│  Go 1.24 ─────────────────────────────────────────────────────────     │
│  ├── Swiss Table maps (87.5% load factor, SIMD probe)                   │
│  ├── Generic type aliases                                               │
│  ├── Tool dependencies in go.mod                                        │
│  └── Weak pointers (weak.Pointer[T])                                    │
│                                                                          │
│  Go 1.25 ─────────────────────────────────────────────────────────     │
│  ├── PGO stable (profile-guided optimization, default auto)             │
│  ├── Better escape analysis                                             │
│  └── sync.Map improvements                                              │
│                                                                          │
│  Go 1.26 ─────────────────────────────────────────────────────────     │
│  ├── Green Tea GC (10-40% GC overhead reduction)                        │
│  ├── Goroutine leak pprof profile                                       │
│  ├── json/v2 (encoding/json/v2)                                         │
│  ├── SIMD experimental (simd/archsimd)                                  │
│  ├── errors.AsType[T] generic helper                                    │
│  ├── Post-quantum crypto (crypto/mlkem, crypto/hpke)                    │
│  └── go fix modernizers (source-level inliner)                         │
└─────────────────────────────────────────────────────────────────────────┘
\`\`\`

---
`;
