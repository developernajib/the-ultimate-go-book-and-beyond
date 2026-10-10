## Exercises

1. **Measure the layout.** Write the AoS loop from section 03 over 1,000,000 entities, then the SoA version. Benchmark both and use `perf stat -e cache-misses,cache-references` (or the platform equivalent) to show *why* they differ. Report the speedup and the miss-rate change. Then check whether the compiler vectorized the SoA loop by reading the assembly, and if it did not, find out what stopped it.

2. **Frame arena.** Implement the arena from section 05 with alignment handling and a debug mode that poisons freed memory (fill with `0xDD` on reset) so use-after-reset fails loudly. Benchmark 10,000 allocations per frame against `new`. Report both the mean and the maximum single allocation time, since the maximum is the entire point.

3. **Fixed timestep.** Build the loop from section 02 with interpolation. Then deliberately break it: remove the clamp and put a 5-second breakpoint in the middle to watch the spiral of death - remove the interpolation and render at 144 Hz with a 60 Hz sim to see the judder. Understanding each failure by causing it is the exercise.

4. **Generational handles.** Implement the handle table from section 04. Write a test that destroys an entity, allocates a new one that reuses the slot, and asserts the stale handle resolves to `nullptr` rather than the new entity's data. That test is the whole reason the generation counter exists.

5. **Archetype ECS.** Build a minimal ECS: entity IDs, component registration, archetype storage, and a query that iterates all entities with a given component set. Benchmark a Position+Velocity pass over 100,000 entities and compare it to a `std::vector<std::unique_ptr<GameObject>>` with a virtual `Update()`. Report the multiple and explain which of the two effects (layout or devirtualization) contributed more, which you can isolate by testing a non-virtual AoS version as a third case.

6. **Work stealing.** Implement the deque from section 06. Test it under ThreadSanitizer. Then measure the thing that justifies it: run a parallel-for of 1,000 tiny jobs on 8 threads with (a) one mutex-guarded queue and (b) work stealing, and report utilization for each. Vary the grain size and find where scheduling overhead overtakes the work.

7. **Determinism harness.** Take a small physics sim, run it twice with identical inputs, hash the state every step, and assert the hashes match. Now break it on purpose in three ways: iterate a `std::unordered_map` keyed by pointer, use `rand()`, and compile one run with `-ffast-math`. Confirm each produces a divergence and note the step at which it first appears. This is the harness real deterministic games run in CI.

8. **Hunt a spike.** Add scoped instrumentation to any of the above and render a frame timeline. Then inject a hitch: allocate 50 MB on a random frame. Verify your timeline finds it and that a 60-second `perf` aggregate does not. This is section 09's argument, demonstrated.

### What Success Looks Like

Exercise 5 is the one to do first if you only do one, because it produces the number that explains the whole chapter. Expect something in the 5-20x range depending on your machine and how fat you make the object. When you have it, you will understand why engines are built this way, and you will not need to take section 03 on faith.

Exercise 7 is the one that will surprise you. Most engineers believe their code is deterministic and it is not. Finding out that a `std::unordered_map` iteration silently desynced your simulation at step 4,000 is a lesson that transfers directly to distributed systems, where the same class of nondeterminism produces the same class of unreproducible bug.

### Staff Extensions

**Exercise 2 as a budget system.** Extend the arena into a per-subsystem budget: each subsystem gets a named arena with a fixed size, exhaustion is a hard error naming the subsystem, and peak usage is reported to CI. Then make CI fail when a subsystem exceeds its budget. Deliverable: the budget table, the enforcement mechanism, and an argument for who negotiates changes to it. This is section 05's organizational point made real, and it is the artifact that keeps a console title inside its memory limit for three years.

**Exercise 6 as a frame graph.** Extend the job system so systems declare their reads and writes, then compute the dependency graph, schedule automatically, and report the critical path. Deliverable: a visualization of the graph with the critical path highlighted, and an answer to "if we had 64 cores instead of 8, what would our frame time be?" The answer is the critical path, and most teams have never computed it.

**Bar-raiser: the perf ratchet.** Build the CI gate from section 09. A fixed scene, fixed hardware, deterministic playback, frame-time percentiles recorded per commit, and a build failure on regression beyond a threshold. The engineering is almost entirely in making the measurement stable enough that the signal exceeds the noise: pin clocks, disable turbo, run enough iterations to bound variance, and report a confidence interval rather than a number. Deliverable: the gate, plus a written analysis of your measurement noise floor, because a perf gate whose noise exceeds its threshold gets disabled within a month and then you have nothing.
