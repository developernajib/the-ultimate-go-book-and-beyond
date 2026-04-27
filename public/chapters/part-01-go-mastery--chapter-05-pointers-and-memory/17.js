export default `## Exercises

1. **Pointer Arithmetic Limitations**: Go does not support pointer arithmetic the way C does. Write a program that demonstrates this restriction by attempting to advance through an array using pointer offsets. Then implement the idiomatic Go alternative using slice indexing and range loops. Document why Go's design choice improves memory safety, and benchmark both approaches to show there is no meaningful performance difference for typical workloads.

2. **Stack vs Heap Escape Analysis**: Write five small functions that each allocate a local variable differently, returning a pointer, storing in a global, capturing in a closure, passing to an interface, and keeping it purely local. Run \`go build -gcflags="-m"\` on your code and record which variables escape to the heap for each case. Write a short explanation for each outcome, then refactor the escaping cases where possible to keep allocations on the stack without changing correctness.

3. **unsafe.Pointer Zero-Copy Conversion**: Using \`unsafe.Pointer\`, implement two utility functions: \`StringToBytes(s string) []byte\` and \`BytesToString(b []byte) string\` that avoid copying the underlying memory. Add a suite of unit tests that verify correctness, confirm that the byte slice and string share the same backing memory address, and include a benchmark comparing the unsafe version against a standard \`[]byte(s)\` conversion to quantify the allocation savings.

4. **Memory-Efficient Struct Design**: Given the following field list - \`bool\`, \`int32\`, \`string\`, \`float64\`, \`bool\`, \`int16\`, \`*int64\` - lay them out in a struct in the worst possible order (maximum padding) and in the optimal order (minimum padding). Use \`unsafe.Sizeof\` and \`unsafe.Offsetof\` to print the size and field offsets of both versions. Explain the alignment rules that drive each layout decision, and calculate how much memory would be saved per instance if one million structs were allocated.

5. **Pointer Receivers vs Value Receivers**: Implement a \`Counter\` type backed by an \`int64\` field with two method sets: one using value receivers (\`Increment\`, \`Value\`, \`Reset\`) and one using pointer receivers. Write tests that demonstrate the behavioral difference, specifically that value receiver methods cannot mutate the original and that only the pointer receiver version satisfies a \`Mutable\` interface you define. Then show which receiver set is required for a type to be stored in a \`sync.Pool\` and explain why.

6. **Memory Pool with sync.Pool**: Build a reusable \`ByteBufferPool\` that wraps \`sync.Pool\` to manage \`bytes.Buffer\` instances. The pool must reset buffers before returning them to the pool and must expose \`Get() *bytes.Buffer\` and \`Put(*bytes.Buffer)\` methods. Write a benchmark that compares throughput (operations per second) and heap allocations per operation between using the pool and allocating fresh buffers directly. The pool implementation should demonstrate at least a 50% reduction in allocations under concurrent load using \`b.RunParallel\`.

The next chapter covers interfaces, Go's primary mechanism for polymorphism and abstraction.

### Senior at FAANG Track

7. **Production memory budget review.** For one of your team's services, define an explicit memory budget: target RSS, target GC CPU percentage, target allocation rate. Measure the current state. Identify the gap. Write a one-page proposal for the work needed to close it. The deliverable is the proposal plus the measurements that justify the prioritisation.

8. **\`weak.Pointer[T]\` cache evaluation.** Identify a cache in your team's codebase that uses explicit eviction. Build a parallel implementation using \`weak.Pointer[T]\`. Benchmark hit rate, allocation rate, and worst-case eviction latency under sustained load. Document the trade-offs. The deliverable is the comparison plus the recommendation.

9. **Continuous profiling rollout proposal.** If your team does not run continuous profiling, write the proposal to roll it out. Cover the tooling choice (Pyroscope, Parca, hosted equivalent), the integration cost, the operational model (who owns dashboards, who reviews regressions), and the expected diagnostic value over the next year.

10. **Team review checklist authorship.** Take the patterns from this chapter (typed-nil interfaces, slice aliasing, pool reset discipline, struct alignment, weak references) and write your team's review checklist. Reference the specific lint rules that catch each. The deliverable is the document, with the rules wired into CI.
`;
