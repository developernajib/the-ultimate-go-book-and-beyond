export default `## Summary

| Feature | Package | Use When | Avoid When |
|---------|---------|----------|------------|
| Pointer arithmetic | unsafe | Zero-copy string/bytes, field access by offset | Could use reflect or direct access |
| Type punning | unsafe | Binary protocol parsing, SIMD-compatible types | Safer alternatives exist |
| Type inspection | reflect | Libraries, serializers, validators | Static types known at compile time |
| Value manipulation | reflect | Config loaders, ORMs, DI frameworks | Hot paths (>1M ops/sec) |
| Struct tags | reflect | Defining metadata for fields | - (zero cost at compile time) |
| Dynamic creation | reflect | Factory patterns, deserialization | Performance-critical code |
| go:linkname | compiler | Accessing runtime internals, testing unexported code | Anything that might upgrade Go versions |

**Key rules for safe unsafe usage:**
1. Never store \`uintptr\` as the sole reference to live memory, GC does not see it
2. All pointer arithmetic must be in a **single expression** (GC cannot move memory mid-expression)
3. Zero-copy string/bytes conversions are safe only if the []byte is never modified
4. Always use \`unsafe.Pointer\` as the intermediary type in conversions, never \`uintptr\` across statement boundaries

**Key rules for safe reflect usage:**
1. Cache \`reflect.Type\` values at startup, type lookup is expensive
2. Cache field indices for frequently accessed struct fields
3. Check \`CanSet()\` before calling \`Set*()\`
4. Check \`IsNil()\` before dereferencing pointer/interface values
5. Use \`Interface()\` to extract a concrete value from \`reflect.Value\`
6. Prefer code generation (mockgen, sqlc, wire) over reflect in hot paths

---

*Next chapter: Chapter 7D, CGO and Go Assembly*

### What you should be able to do now

- Recognise \`unsafe\` and \`reflect\` in code review and decide whether each use is legitimate.
- Write a cached reflection helper that performs the reflection once and dispatches directly thereafter.
- Distinguish cases where generics replace reflection from cases where reflection is genuinely needed.
- Read standard library source that uses \`unsafe\` without fear.

### For the senior-at-FAANG track

The institutional artifact: the team's "when to use \`unsafe\` and \`reflect\`" discipline. Write it once. Apply it in code review. Update as Go evolves and generics cover more cases. The discipline is the leverage.

---
`;
