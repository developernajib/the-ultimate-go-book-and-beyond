export default `## Learning Objectives

1. **Master Go 1.23 iterators** - Understand \`iter.Seq\`/\`iter.Seq2\` push/pull iterator patterns, range-over-func, and the full stdlib iterator methods on slices and maps
2. **Apply Swiss Table map knowledge** - Understand how Go 1.24's new map internals improve throughput and memory, and when map performance matters enough to optimize around
3. **Implement Profile-Guided Optimization** - Set up PGO in production CI/CD pipelines, measure improvements, and understand when PGO helps vs when it doesn't
4. **Understand the Green Tea GC** - Learn what changed in Go 1.26's garbage collector and how to measure its impact on latency-sensitive Go services
5. **Detect goroutine leaks** - Use the new goroutineleak pprof profile introduced in Go 1.26 to find and fix blocked goroutines in production
6. **Migrate to json/v2** - Understand the behavioral changes in \`encoding/json/v2\` and write migration-safe JSON code
7. **Use SIMD operations** - Apply the experimental \`simd\` package for batch processing, understanding the current amd64-only limitation and future portability
8. **Apply post-quantum cryptography** - Integrate ML-KEM and HPKE from Go 1.26's crypto packages for forward-secret TLS and hybrid key exchange

---
`;
