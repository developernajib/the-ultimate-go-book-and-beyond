export default `## Interview Questions

**Q1: What problem do Go 1.23 iterators solve that previous patterns didn't?**

A: Before 1.23, custom collection types had three options: callback functions (not composable, non-idiomatic), channels (goroutine overhead, goroutine leak risk on early termination), or materializing all values (memory overhead for large collections). None worked with the standard \`for ... range\` syntax.

Go 1.23 iterators (\`iter.Seq[V]\`) allow custom types to use range-over-function syntax, are lazy (compute values on demand), support early termination safely (yield returns false), require no goroutines, and compose via iterator combinators. The mental model: an iterator is just a function that calls a provided yield function for each element. This is a push model, the iterator pushes values to the consumer via the yield callback. For pull-style consumption (e.g., merging two sorted sequences), \`iter.Pull\` converts push to pull.

---

**Q2: How do Swiss Tables improve map performance in Go 1.24?**

A: The old Go map used a bucket-and-overflow layout: a bucket array where each bucket held up to 8 slots plus an \`overflow\` pointer to another bucket when full. Lookups walked the chain, which meant cache-unfriendly pointer chasing once the load factor climbed.

Swiss Tables use open addressing organized into groups of 8 slots. Each group has a parallel 8-byte control word where each byte stores either empty, deleted, or the 7-bit fingerprint (H2, the low 7 bits of the hash) of that slot's key. On lookup, the hash is split into a group index (upper bits) and a fingerprint. The group's 8 control bytes are scanned in parallel with a single SIMD instruction on amd64 and arm64, and only fingerprint matches trigger a full key compare. Benefits: the 2-cache-line group footprint means one cache fill per probe, overflow buckets are gone (linear probing plus extendible hashing handles growth), and microbenchmarks show roughly 30 to 60 percent faster lookups and inserts, with iteration around 50 percent faster. Datadog publicly reported hundreds of gigabytes of RSS savings across their Go fleet after the 1.24 upgrade with no code changes.

---

**Q3: What is PGO and when should you use it in Go?**

A: Profile-Guided Optimization compiles the code using data from actual production execution. The compiler learns which functions are hot (frequently called) and makes them eligible for normally-too-expensive optimizations: inlining hot call sites, devirtualizing frequent interface method calls, optimizing branch prediction.

Use PGO when: your service is CPU-bound (>20% CPU in profiling), hot functions are currently above the inlining budget (too large to inline without PGO), or you have interface-heavy code with a limited number of concrete implementations. Don't expect significant gains for I/O-bound services. Typical improvements: 2-14% CPU reduction. Setup: expose \`/debug/pprof/profile\`, collect 30-second profile during peak production traffic, build with \`go build -pgo=default.pgo\`.

---

**Q4: What is the Green Tea GC in Go 1.26 and what does it improve?**

A: Green Tea is not a replacement algorithm. Go's collector is still the tri-color concurrent mark-sweep. What Green Tea changes is the mark-phase organization. The collector was opt-in via \`GOEXPERIMENT=greenteagc\` in Go 1.25 and became the default in Go 1.26.

Key differences from the pre-1.25 mark phase:
1. **Group-based marking**: the mark worker scans small-object groups together instead of following per-object pointers one at a time, improving cache locality.
2. **SIMD scan**: on amd64 and arm64, group control bytes are checked in parallel with a single hardware instruction.
3. **Unchanged contracts**: the tri-color invariant, the write barrier, and user-facing GC semantics (GOGC, GOMEMLIMIT, \`debug.SetGCPercent\`) behave exactly as before.

Typical observed impact: 10 to 40 percent reduction in GC CPU overhead and slightly shorter mark-assist p99, on allocation-heavy services. Services dominated by object pools see less improvement because the GC barely runs. There is no runtime flag to toggle collectors in a 1.26 binary, the choice is set at build time. Always pair with \`GOMEMLIMIT\` in containers to keep GC pacing aligned with the pod's memory budget.

---

**Q5: How do you detect goroutine leaks in production?**

A: Go 1.26 adds a \`goroutineleak\` pprof profile accessible at \`/debug/pprof/goroutineleak?seconds=N\`. It captures goroutines that have been blocked for more than N seconds, a strong indicator of leaks.

Common leak patterns: (1) goroutine blocked on unbuffered channel with no sender, fix with buffered channel or context cancellation. (2) \`sync.WaitGroup\` never called \`Done()\` due to panic, fix with \`defer wg.Done()\`. (3) HTTP requests with no timeout, fix by always using context with deadline. (4) goroutines leaking on server shutdown, fix by cancelling contexts and waiting for graceful termination.

In tests: check \`runtime.NumGoroutine()\` before and after the test, or use the \`goleak\` library which integrates with \`testing.T\`.

---

**Q6: What are the key behavioral changes in encoding/json/v2?**

A: Four major changes:
1. **Case-sensitive field matching**: \`json:"name"\` only matches \`"name"\`, not \`"Name"\` or \`"NAME"\`. Use \`json:"name,nocase"\` to opt into case-insensitive matching for external JSON.
2. **\`omitzero\` instead of \`omitempty\`**: more predictable zero-value omission using \`v == zero(T)\` which works correctly for all types including custom types.
3. **No HTML escaping by default**: \`<\`, \`>\`, \`&\` are not escaped. This is correct for JSON APIs. Use \`MarshalOptions{EscapeHTML: true}\` for HTML contexts.
4. **Unknown fields cause error**: by default, unknown JSON fields return a decode error. Use \`json:",unknown"\` to capture them. This is safer for strict API contracts.

Migration: keep v1 in existing code, use v2 for new code, and use \`UnmarshalOptions{RejectUnknownMembers: false}\` for v1-compatible behavior when needed.

---

**Q7: What is the difference between iter.Seq and a channel-based iterator in Go?**

A: Both provide lazy iteration, but:

| | iter.Seq | Channel-based |
|--|--|--|
| Goroutines | None | 1 per iterator |
| Early termination | yield returns false, stops cleanly | Goroutine leak (blocked on send) |
| Stack overhead | One function call deep | Full goroutine stack (~2KB min) |
| Composition | Combinators are straightforward | Complex, channels don't compose |
| Backpressure | Natural (synchronous) | Needs buffering or complex coordination |

Channel-based iterators also have a subtle correctness bug: if the consumer breaks early from a \`for range ch\` loop, the producer goroutine remains blocked on \`ch <- value\` forever (goroutine leak). \`iter.Seq\` avoids this entirely, when the consumer stops calling yield, the iterator function simply returns.

---

**Q8: How does ML-KEM differ from ECDH for key exchange?**

A: ECDH (Elliptic Curve Diffie-Hellman) is based on the discrete logarithm problem, believed to be hard for classical computers but solvable in polynomial time by Shor's algorithm on a sufficiently powerful quantum computer.

ML-KEM (Module Lattice Key Encapsulation Mechanism, formerly Kyber) is based on the Module Learning With Errors (MLWE) problem, believed to be hard for both classical and quantum computers. It's a KEM (Key Encapsulation Mechanism) rather than a key agreement protocol: one party generates a keypair, the other encapsulates a random shared secret using the public key, and only the private key holder can decapsulate it.

Go 1.26 enables hybrid key exchange in TLS 1.3 by default: \`SecP256r1MLKEM768\` = P-256 ECDH + ML-KEM-768. Both must be broken to compromise the session, classical computers can't break ML-KEM, quantum computers can't (currently) break classical ECDH in real-time.

---

**Q9: What does the //go:fix inline directive do?**

A: It marks a function as a candidate for source-level inlining by \`go fix\`. When you run \`go fix -fix=inline ./...\`, all call sites of functions marked with \`//go:fix inline\` are replaced with the function body in the source code. This enables library authors to:
1. Mark a deprecated wrapper function as \`//go:fix inline\`
2. Users run \`go fix\` to automatically migrate their call sites
3. The deprecated function can then be removed in the next major version

It's different from compiler inlining (\`//go:noinline\`, \`//go:inline\`): \`//go:fix inline\` transforms source code, while compiler directives affect the compiled binary.

---

**Q10: When would you use iter.Pull vs iter.Seq directly?**

A: Use \`iter.Seq\` (push iteration) when: implementing a custom iterator, composing iterators with combinators (map/filter/take), or consuming an iterator with \`for range\` - the default for most use cases.

Use \`iter.Pull\` (pull iteration) when: you need to advance two iterators in lockstep (e.g., merge-sort two sorted sequences, zip two sequences), you need to interleave iteration with other logic between \`next()\` calls, or you're wrapping a Go iterator for consumption by a library that expects a \`(next func() (V, bool))\` interface. The key: \`iter.Pull\` creates goroutine-free pull-style iteration from any push iterator. Always defer the \`stop\` function to ensure cleanup.

---

**Q11: How should you benchmark the impact of Swiss Table maps?**

A: Three-level approach:
1. **Micro-benchmark**: directly benchmark \`map\` get/set/delete operations with your typical key types and map sizes using \`testing.B\`. Compare Go 1.23 vs 1.24.
2. **Memory measurement**: use \`runtime.ReadMemStats()\` before and after filling maps. Compare \`HeapInuse\` between versions.
3. **Service-level measurement**: deploy Go 1.24 to canary traffic, compare CPU usage and memory consumption in production dashboards.

What to look for: improvements are most visible with string keys (SIMD string comparison), large maps (>1000 entries), and high-concurrency read workloads. Maps with pointer keys or large value types may see less improvement due to cache pressure.

---

**Q12: What is HPKE and when should you use it?**

A: HPKE (Hybrid Public Key Encryption, RFC 9180) is a modern standard for asymmetric encryption. It combines:
1. KEM (Key Encapsulation Mechanism), like ECDH, establishes a shared secret from a public key
2. KDF (Key Derivation Function), derives encryption and authentication keys from the shared secret
3. AEAD (Authenticated Encryption with Associated Data), encrypts the message

Use HPKE instead of: raw RSA encryption (use RSA-OAEP at minimum, HPKE if possible), manual ECDH + symmetric encryption (roll-your-own is error-prone), or NaCl \`box\` package (HPKE is more standardized and configurable).

HPKE in Go 1.26 (\`crypto/hpke\`) supports multiple cipher suites including ML-KEM-based post-quantum variants. Use for: encrypting data at rest with a recipient's public key, end-to-end encryption in messaging apps, sealing API tokens for specific recipients.

---

**Q13: How do you safely migrate a large codebase from encoding/json to encoding/json/v2?**

A: Incremental approach:
1. **Audit**: identify all places that use \`encoding/json\`. Find patterns that will break: unknown fields being silently ignored, case-insensitive matching relied upon, HTML-escaped output expected.
2. **Add build tags**: create a \`json.go\` file that wraps either v1 or v2 based on a build tag, allowing testing with both.
3. **Test with v2 semantics**: add tests that specifically exercise: unknown field handling (expect error in v2), case-insensitive matching (fails in v2 without \`nocase\` tag), HTML escaping (different output in v2).
4. **Migrate field by field**: add \`nocase\` tag to fields receiving external JSON, add \`Unknown map[string]any \\\`json:",unknown"\\\`\` to structs that currently silently ignore extra fields, update tests to reflect v2 semantics.
5. **Gradual rollout**: switch new services to v2, migrate existing services during refactoring passes.

---

**Q14: What is the goroutineleak pprof profile and how does it differ from the goroutine profile?**

A: The standard \`goroutine\` pprof profile captures ALL goroutines at a point in time, including healthy goroutines actively processing requests. Useful for counting goroutines and seeing what they're doing, but hard to distinguish leaks from normal goroutines.

The new \`goroutineleak\` profile (Go 1.26) captures only goroutines that have been blocked for longer than the specified duration (the query parameter \`seconds\`). These long-blocked goroutines are likely leaks, a healthy goroutine processing a request should not be blocked for >30 seconds. The profile shows the stack trace and block reason (waiting on channel, mutex, cond), making it much easier to identify the exact leak location.

---

**Q15: What are the performance implications of Go 1.24 generic type aliases?**

A: Generic type aliases have zero runtime performance impact, they're a purely compile-time feature. \`type StringMap[V any] = map[string]V\` generates the exact same code as writing \`map[string]V\` directly. There's no wrapper, no indirection, no boxing.

Performance considerations are all at the developer experience level: generic aliases can improve code clarity (naming complex generic types), reduce copy-paste errors in type annotations, and enable gradual migration of non-generic code to generic code without changing the API signature. They do add compile-time type checking for the alias, but this is negligible.

---

**Q16: How do you collect a representative PGO profile in production?**

A: Key requirements for a good PGO profile:
1. **Representative traffic**: collect during normal business hours at typical load. Avoid: startup, incidents, load tests, maintenance windows.
2. **Duration**: 30-120 seconds is typically sufficient. Longer profiles converge but add storage overhead.
3. **Multiple samples**: average several profiles collected at different times to reduce sampling noise.
4. **Correct service**: the profile must come from the service binary you're optimizing. Profile from a different binary gives no benefit.

Collection command: \`curl -o pgo.prof "http://prod-host:6060/debug/pprof/profile?seconds=60"\`. Store in version control or object storage. Rebuild with \`-pgo=pgo.prof\`. Validate: the new binary should show measurable CPU improvement vs the non-PGO binary under the same load.

---

**Q17: What are the security implications of Go 1.26's default hybrid TLS key exchange?**

A: Go 1.26 enables \`SecP256r1MLKEM768\` (P-256 ECDH + ML-KEM-768) in TLS 1.3 by default, without any code changes.

Security implications:
1. **Harvest-now-decrypt-later protection**: traffic encrypted today cannot be decrypted by future quantum computers, since ML-KEM is quantum-resistant
2. **No security regression**: hybrid means BOTH classical ECDH AND ML-KEM must be broken to compromise the key exchange. A quantum computer breaks ECDH but not ML-KEM. a classical attack breaking ML-KEM still hits ECDH.
3. **Handshake size increase**: ML-KEM-768 key exchange adds ~1-2KB to the TLS handshake. Negligible for most services.
4. **Compatibility**: only TLS 1.3 clients that support the hybrid curves will use it. Older clients fall back to classical curves, no compatibility breakage.

For services handling sensitive data with long-term confidentiality requirements (healthcare, financial), this default is a significant security improvement.

---

**Q18: How do you implement zero-cost iterator combinators in Go?**

A: The key insight: all iterator combinators are just functions returning closures over other iterators. Since each layer is a simple function call (no goroutines, no channels, no heap allocations when the compiler inlines them), the overhead approaches zero.

\`\`\`go
// This chain has no heap allocations on amd64 with sufficient inlining:
total := Reduce(
    Map(
        Filter(slices.Values(nums), isPositive),
        square,
    ),
    0, add,
)
\`\`\`

The compiler inlines \`Filter\`, \`Map\`, \`Reduce\`, and the lambda functions if they're simple enough. The result is equivalent to a single hand-written loop. Verify with: \`go build -gcflags="-m=2" ./...\` to see which functions are inlined.

When combinators don't inline (complex closures, too many levels): use \`iter.Pull\` to convert to a for-loop which the compiler can optimize more aggressively.

---

**Q19: What is the difference between GOGC and GOMEMLIMIT for GC tuning?**

A: \`GOGC=N\` controls GC trigger: run GC when heap size reaches \`(1 + N/100) * live_heap_bytes\`. Default 100 means GC when heap doubles. Higher values = less frequent GC, higher memory usage. Setting \`GOGC=200\` allows heap to triple before GC - 50% less frequent GC cycles, but up to 3x the live heap in memory.

\`GOMEMLIMIT=N\` (Go 1.19+) sets a soft cap: the GC becomes more aggressive as memory approaches the limit, regardless of GOGC. The GC will run as often as needed to keep total memory under the limit.

Best practice with Green Tea GC in containers: \`GOGC=200 GOMEMLIMIT=1800MiB\` (container limit 2GB), allows heap to grow larger before GC (reducing CPU overhead), but GOMEMLIMIT prevents OOM. Green Tea GC handles the resulting larger heaps more efficiently than the old GC.

---

**Q20: When would you adopt the experimental SIMD package in production?**

A: Current Go 1.26 SIMD (\`GOEXPERIMENT=simd\`) is experimental. Production adoption criteria:

Use in production when: the target architecture is exclusively amd64, the performance benefit is measured and significant (>20% improvement on the bottleneck), you have scalar fallback via build tags for other architectures, you're willing to maintain build complexity as the API stabilizes, and you've load-tested the SIMD code path thoroughly.

Avoid if: supporting non-amd64 platforms, the API stability is critical for your release cadence, or the scalar code is already fast enough.

Practical timeline: expect SIMD to exit experimental status by Go 1.28-1.29 with stable API and arm64 support. For new projects starting today, design with SIMD in mind but implement scalar first and profile before adding SIMD.

---
`;
