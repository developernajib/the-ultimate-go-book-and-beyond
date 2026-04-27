export default `## Summary

Go 1.23-1.26 represent a systematic improvement across all layers: language expressiveness (iterators), runtime performance (Swiss Tables, Green Tea GC), build-time optimization (PGO), developer ergonomics (errors.AsType, goroutineleak profile), and security modernization (post-quantum crypto, json/v2).

**Iterators** are the most impactful language feature since generics. They enable custom types to integrate with \`for range\`, enable lazy pipelines without goroutines, and solve the long-standing problem of composable, memory-efficient iteration over custom data structures. Start using them for any collection type you write.

**Swiss Tables and Green Tea GC** are free performance wins, just upgrade your Go version. Swiss Tables improve map-heavy code by 15-30%, and Green Tea GC reduces GC overhead by 10-40% for allocation-intensive services. No code changes required.

**PGO** requires investment (setting up profile collection, CI integration) but delivers 2-14% CPU reduction on compute-bound services. The investment is justified for services where CPU is a cost driver or latency bottleneck. Establish the pipeline once and it improves automatically as production behavior evolves.

**Post-quantum crypto** in TLS is automatic in Go 1.26, your HTTPS servers and clients use hybrid ML-KEM key exchange without any code changes. For applications requiring explicit PQ crypto (sealing secrets, end-to-end encryption), \`crypto/mlkem\` and \`crypto/hpke\` provide standards-compliant implementations.

**Key upgrade priority:**
1. Go 1.24 for Swiss Tables (free map performance)
2. Go 1.26 for Green Tea GC (free GC improvement) + goroutineleak profile
3. PGO for CPU-bound services (requires pipeline setup)
4. json/v2 for new services (avoid v1's surprising behaviors)
5. SIMD when it exits experimental status (watch Go 1.28-1.29)
`;
