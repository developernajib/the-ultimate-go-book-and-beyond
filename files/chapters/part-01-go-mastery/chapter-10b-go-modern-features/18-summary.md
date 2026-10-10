## Summary

Go 1.23 through 1.27 improved every layer at once: language expressiveness (iterators, generic methods), runtime performance (Swiss Tables, Green Tea GC, the size-specialized allocator), build-time optimization (PGO), developer ergonomics (errors.AsType, the goroutineleak profile, json/v2), and security modernization (post-quantum key exchange).

**Iterators** are the most impactful language feature since generics. They enable custom types to integrate with `for range`, enable lazy pipelines without goroutines, and solve the long-standing problem of composable, memory-efficient iteration over custom data structures. Start using them for any collection type you write.

**Swiss Tables and Green Tea GC** are free performance wins, just upgrade your Go version. Swiss Tables make map-heavy code measurably faster and smaller, and Green Tea GC cuts GC CPU overhead by 10 to 40 percent on allocation-intensive services. No code changes required. Measure your own workload rather than budgeting on someone else's numbers.

**PGO** requires investment (setting up profile collection, CI integration) but delivers 2-14% CPU reduction on compute-bound services. The investment is justified for services where CPU is a cost driver or latency bottleneck. Establish the pipeline once and it improves automatically as production behavior evolves.

**Post-quantum crypto** in TLS is automatic. `X25519MLKEM768` has been in the default TLS 1.3 key exchange set since Go 1.24, and Go 1.26 adds the P-curve hybrid `SecP256r1MLKEM768` alongside it. Your HTTPS servers and clients negotiate hybrid ML-KEM without any code changes. For applications needing explicit PQ crypto (sealing secrets, end-to-end encryption), `crypto/mlkem` and `crypto/hpke` provide standards-compliant implementations.

**Key upgrade priority:**
1. Go 1.24 for Swiss Tables (free map performance)
2. Go 1.26 for Green Tea GC (free GC improvement) plus the goroutineleak profile
3. PGO for CPU-bound services (requires pipeline setup)
4. Go 1.27 for json/v2, now GA (avoid v1's surprising behaviors in new services)
5. SIMD once it exits experimental status, no release has been committed to yet
