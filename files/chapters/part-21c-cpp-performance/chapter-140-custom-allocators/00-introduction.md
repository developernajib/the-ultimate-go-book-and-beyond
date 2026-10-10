# Chapter 140: Custom Memory Allocators

> The fastest allocation is the one you never make. The second fastest is the one you planned for.

Every call to `malloc` or `new` travels through a general-purpose allocator designed to handle every possible allocation pattern well, and none of them optimally. When your profiler points at allocation overhead, or when you need deterministic latency, general-purpose is no longer good enough. This chapter teaches you to build and use custom allocators that exploit knowledge about your specific workload to achieve order-of-magnitude speedups. We cover the full spectrum from the simplest bump allocator to production-grade replacements like jemalloc, and we compare everything back to Go's runtime allocator so you understand the design space completely.

---
