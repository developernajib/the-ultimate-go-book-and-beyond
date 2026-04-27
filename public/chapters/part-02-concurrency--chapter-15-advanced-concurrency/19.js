export default `## Summary

This chapter covered the techniques that separate systems handling thousands of requests per second from those handling millions. Each comes with a specific complexity cost, and the right choice depends on profiling data, not intuition.

| Technique | Use Case | Complexity |
|-----------|----------|------------|
| Lock-Free | High contention, simple operations | High |
| Work Stealing | Load balancing, parallelism | High |
| Sharding | Reduce lock contention | Medium |
| Hazard Pointers | Safe memory reclamation | Very High |
| Bounded Parallelism | Resource control | Low |
| Backpressure | Handle overload | Medium |
| Parallel Algorithms | CPU-bound computation | Medium |

**Guidelines for production systems:**

1. **Profile first**: Don't optimize without data
2. **Start simple**: Mutex is often good enough
3. **Understand the memory model**: Incorrect code is worse than slow code
4. **Test under load**: Concurrency bugs appear at scale
5. **Use established patterns**: Don't reinvent work stealing
6. **Monitor in production**: Metrics reveal real-world behavior

### For the Senior-at-FAANG Track

The leverage is rejecting premature advanced concurrency in review. Most PRs that introduce lock-free techniques, sharding, or padding do not pass the "show me the profile" test. Rejecting them prevents years of maintenance pain.

### For the Staff and Principal Track

The deliverable is the org's review bar for advanced concurrency: when can engineers introduce these techniques, with what evidence, under what maintenance commitment. Without the bar, the codebase accumulates complexity faster than it gains performance. With the bar, the advanced techniques stay in the narrow places they genuinely help.

### Mental Model to Take Away

Advanced concurrency is a scalpel, not a hammer. Used in the right place it produces measured performance gains. Used broadly it produces bugs and maintenance burden. The instinct to develop: when contention appears, reach for the simpler tool first. Shard before going lock-free. Use stdlib before writing custom. Measure after every change. Revert if the numbers do not improve. These are unglamorous disciplines that separate Go codebases that scale from those that collapse under their own complexity.

---
`;
