## Architecture Overview

Go's recent releases represent a deliberate shift from language additions toward runtime and toolchain performance. Go 1.23 introduced range-over-func iterators, enabling lazy, composable sequences without heap-allocating a slice first. Go 1.24's Swiss Table map implementation replaced the bucket-chaining hash map with an open-addressing design that uses SWAR probing (SIMD-within-a-register) to achieve an 87.5% load factor with lower memory overhead and faster lookups. Go 1.26's Green Tea GC targets the most common latency complaint in production Go services, excessive GC overhead, by reducing it 10-40% through span-based scanning with better memory locality.

```
┌──────────────────────────────────────────────────────────────────────────┐
│              Go 1.23-1.27 Feature Map                                    │
│                                                                          │
│  Go 1.23 ─────────────────────────────────────────────────────────       │
│  ├── Range-over-func (rangefunc)                                         │
│  ├── iter.Seq / iter.Seq2 types                                          │
│  ├── slices.All, slices.Values, maps.All iterators                       │
│  └── Timer/Ticker fixes (stop/reset behavior)                            │
│                                                                          │
│  Go 1.24 ─────────────────────────────────────────────────────────       │
│  ├── Swiss Table maps (87.5% load factor, SWAR probe)                    │
│  ├── Generic type aliases                                                │
│  ├── Tool dependencies in go.mod                                         │
│  └── Weak pointers (weak.Pointer[T])                                     │
│                                                                          │
│  Go 1.25 ─────────────────────────────────────────────────────────       │
│  ├── Container-aware GOMAXPROCS (respects cgroup CPU limit)              │
│  ├── Better escape analysis                                              │
│  └── testing/synctest stable (synctest.Test)                             │
│                                                                          │
│  Go 1.26 ─────────────────────────────────────────────────────────       │
│  ├── Green Tea GC (10-40% GC overhead reduction)                         │
│  ├── Goroutine leak pprof profile                                        │
│  ├── json/v2 experimental (GA in Go 1.27)                                │
│  ├── SIMD experimental (simd/archsimd)                                   │
│  ├── errors.AsType[T] generic helper                                     │
│  ├── Post-quantum crypto (crypto/mlkem, crypto/hpke)                     │
│  └── go fix modernizers (automated idiom updates)                        │
└──────────────────────────────────────────────────────────────────────────┘
```

---
