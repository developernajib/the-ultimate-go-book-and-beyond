## Open-Source FAANG C++ Projects

Here is a reference table of major open-source C++ projects from FAANG companies. As a staff engineer, you should know what these are and when your team might use them.

| Project | Company | What It Does | GitHub |
|---------|---------|-------------|--------|
| Abseil | Google | C++ standard library extensions (containers, strings, time, sync) | `abseil/abseil-cpp` |
| gRPC (C++ core) | Google | High-performance RPC framework | `grpc/grpc` |
| Protobuf | Google | Language-neutral serialization | `protocolbuffers/protobuf` |
| TensorFlow | Google | ML framework (C++ core) | `tensorflow/tensorflow` |
| LevelDB | Google | Embedded sorted key-value store | `google/leveldb` |
| Flatbuffers | Google | Zero-copy serialization | `google/flatbuffers` |
| Filament | Google | Real-time physically based rendering engine | `google/filament` |
| Folly | Meta | High-performance C++ library components | `facebook/folly` |
| RocksDB | Meta | Embedded key-value store (LevelDB fork, SSD-optimized) | `facebook/rocksdb` |
| Thrift | Meta | RPC framework and serialization | `apache/thrift` |
| Proxygen | Meta | HTTP framework powering Meta's load balancers | `facebook/proxygen` |
| HHVM | Meta | PHP/Hack virtual machine with JIT | `facebook/hhvm` |
| Watchman | Meta | File watching service | `facebook/watchman` |
| CacheLib | Meta | Pluggable caching engine | `facebook/CacheLib` |
| LLVM/Clang | Apple + community | Compiler infrastructure and C/C++ compiler | `llvm/llvm-project` |
| WebKit | Apple + community | Browser engine (Safari) | `WebKit/WebKit` |
| Swift (compiler) | Apple | Swift language compiler (written in C++) | `swiftlang/swift` |
| STL | Microsoft | C++ Standard Library implementation for MSVC | `microsoft/STL` |
| ONNX Runtime | Microsoft | Cross-platform ML inference | `microsoft/onnxruntime` |
| Terminal | Microsoft | Windows Terminal application | `microsoft/terminal` |
| Calculator | Microsoft | Windows Calculator (modern C++) | `microsoft/calculator` |
| AWS SDK for C++ | Amazon | AWS service interfaces for C++ | `aws/aws-sdk-cpp` |
| s2n-tls | Amazon | TLS implementation | `aws/s2n-tls` |

### Why This Matters for Go Engineers

You will encounter these C++ projects as dependencies, as inspirations for Go designs, or as systems you need to interface with via CGo or FFI. Understanding their purpose helps you:

1. **Design systems**: RocksDB's LSM-tree architecture influenced Go databases like Pebble (CockroachDB's Go storage engine, explicitly modeled on RocksDB).
2. **Debug performance**: If your Go service calls a C++ library via CGo, understanding the C++ side helps you diagnose latency.
3. **Interview well**: Staff-level interviews at FAANG companies assume familiarity with these projects.

---

### Junior → FAANG: Using the Reference Table as Interview Prep

The table in this section is not trivia. It is your vocabulary for staff-level conversations. When a senior engineer mentions "we use CacheLib for our hot tier," you need to know that is Meta's pluggable caching engine, not some internal acronym. When a design doc references Proxygen as the HTTP layer, you need to know it is Meta's battle-tested framework handling billions of daily requests.

Study exercise: pick five projects from the table, find their README on GitHub, and write one sentence per project answering: what problem does it solve, what is the key design decision that makes it different from the naive solution, and when would a Go engineer encounter or care about it?

First-job habit: when your team's C++ service pulls in any of these libraries, read the changelog for the version you are on. Library upgrade decisions at FAANG often span months because of migration complexity. Understanding what changed in each version helps you contribute to upgrade planning.

### Senior @ FAANG: Open-Source Strategy and Internal-to-External Governance

At the staff level, open-source C++ libraries are both a dependency concern and a strategic asset. Many of these projects (Abseil, Folly, RocksDB) began as internal tools and were open-sourced as talent acquisition and ecosystem influence strategies.

**Consuming open-source in a production codebase.** A staff engineer owns the policy for how open-source C++ libraries are vendored, updated, and patched. The options are: live-at-head (Google's internal model for Abseil), pin-and-review (most external teams), or fork-and-own (when upstream diverges from your needs). Each has a maintenance cost that compounds over time. The fork-and-own path is particularly dangerous: within two years, your fork is incompatible with upstream and you have lost access to security patches without manual backporting.

**Contributing back.** At L6, you may be expected to contribute patches upstream to projects your team depends on rather than accumulating internal hacks. This requires understanding the governance model of each project (Abseil uses Google's internal review process mirrored externally, RocksDB uses GitHub PRs with a Meta-employed maintainer team, LLVM has a complex committer model). Knowing these governance models is part of being effective at this level.

**Open-source as a hiring signal.** Companies that open-source high-quality C++ work (Abseil, Folly, RocksDB) use those projects as proof of engineering culture to recruit. A staff engineer who can point to contributions to these projects in an interview has a concrete signal of depth. Bar-raisers at Meta, Google, and Apple actively look for Folly, RocksDB, and LLVM contributions on resumes because it signals that the candidate has engaged with production-scale C++ at the level those codebases demand.

**L7 concern: open-sourcing internal C++ work.** If your team has built a high-value C++ library internally, the decision to open-source it involves legal review (license compatibility with your dependencies), security review (does the public API expose internal infrastructure details?), support commitment (who answers GitHub issues?), and strategic alignment (does open-sourcing this help or hurt your competitive position?). This is a principal-engineer-level decision that requires coordinating across legal, security, engineering, and product leadership.
