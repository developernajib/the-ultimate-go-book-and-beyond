export default `## What's Next

Part 2 shifts from language idioms to Go's concurrency model, the feature that most distinguishes Go from other systems languages. The composition patterns from this chapter apply directly: middleware chains become pipeline stages, interfaces enable testable concurrent components, and functional options configure worker pools.

- **Chapter 11: Concurrency Fundamentals** - goroutines, channels, and the \`select\` statement
- **Chapter 12: Concurrency Patterns** - fan-out/fan-in, pipelines, and worker pools
- **Chapter 13: Synchronization Primitives** - mutexes, atomics, \`sync.Once\`, and \`sync.WaitGroup\`

The patterns from this chapter carry forward. Idiomatic concurrency code uses the same composition discipline, the same small-interface rule, the same functional options where configuration matters.

### What Staff Engineers Should Watch For in Part 2

Concurrency is where idiom violations cost the most. A non-idiomatic HTTP handler is a readability problem. A non-idiomatic goroutine is a correctness problem: goroutine leaks, data races, deadlocks. The patterns in this chapter (small interfaces, explicit dependencies, testability) are not optional for concurrent code. They are the only way to keep the code reviewable. When reading the next three chapters, watch especially for: goroutine-lifetime management via context, bounded concurrency via semaphores or worker pools, and the "one owner per channel" discipline. These are the idiomatic shapes that prevent the subtle bugs that take days to debug.

---
`;
