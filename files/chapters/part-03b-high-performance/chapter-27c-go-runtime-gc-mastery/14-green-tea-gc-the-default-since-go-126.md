## Green Tea GC: The Default Since Go 1.26

Go 1.26 made the **Green Tea garbage collector** the default. It was introduced as an opt-in experiment in Go 1.25 (`GOEXPERIMENT=greenteagc`) and promoted to default in 1.26. You can still opt out with `GOEXPERIMENT=nogreenteagc`, which is the flag that makes an honest A/B comparison possible.

### What Green Tea Actually Is

Green Tea is **not** a new GC algorithm. Go still uses a concurrent tri-color mark-and-sweep collector with a hybrid write barrier. Green Tea restructures the **mark phase** to improve memory locality.

Classic Go GC (through Go 1.24) marked one object at a time. Each mark operation chased a pointer, loaded a cache line, set a bit in a per-span bitmap, and pushed children onto a work queue. Pointer chasing is close to a worst case for a modern CPU: the access pattern is unpredictable, the prefetcher cannot help, and each new object is likely a cache miss and possibly a TLB miss. For programs holding millions of small objects, the mark phase was memory-bound, and the machine spent most of it waiting on memory rather than computing.

Green Tea restructures mark work around **spans** instead of individual objects. When the collector finds a pointer into a span, it enqueues the span. When that span is drained, the collector processes the gray objects inside it together, in one pass over contiguous memory. Same graph, same result, dramatically friendlier access pattern.

```
Classic mark (Go <= 1.24):            Green Tea mark (1.25 experiment, 1.26 default):
Object-oriented work queue.            Span-oriented work queue.

queue = [obj_a, obj_b, obj_c, ...]     queue = [span_1, span_2, ...]
for obj in queue:                      for span in queue:
    scan_pointers(obj)                     # Process all grey objs in a span
    mark_children(obj)                     # together, over contiguous memory.
                                           # Prefetcher-friendly, fewer TLB
# One cache miss per object hop.           # and L1 misses.
# Poor locality on small objects.      scan_span_grey_objects(span)
```

### Measured Impact

The Go team reports a **10 to 40 percent reduction in GC CPU cost** on allocation-heavy workloads that stress the collector. Workloads dominated by a few large objects see less, because the mark phase was never their bottleneck.

Two claims about Green Tea circulate widely and are worth nailing down, because both are wrong and both are the kind of thing an interviewer will let you walk into.

**It does not make allocation faster.** Green Tea changes marking. Allocation goes through the same `mcache`/`mcentral`/`mheap` path it always did, at the same cost. The release that made small allocations cheaper is a different one: the size-specialized allocator in Go 1.27, worth up to 30 percent on small-object allocation. Two adjacent releases improved two different halves of the memory system, and conflating them is the most common Green Tea error.

**Be careful with the SIMD story.** You will read that Green Tea's gains come from vector instructions on recent CPUs, often with a specific percentage and a specific microarchitecture attached. Treat those figures as unverified. The mechanism the design is actually built on is the one described above: scanning contiguous memory span by span rather than chasing pointers object by object. That is what earns the win, and it is a win on any CPU, on any architecture Go targets, with no vector unit required. If you want to know what Green Tea is worth on your workload, the section below shows how to measure it in an afternoon, which beats any number you could quote from a blog post.

```go
// To confirm which GC your binary is running, inspect GODEBUG output.
// GODEBUG=gctrace=1 prints one line per GC cycle.
//
// Example (Go 1.27 default Green Tea):
// gc 12 @1.204s 3%: 0.18+1.9+0.03 ms clock, 1.4+0.41/1.8/0.0+0.24 ms cpu, ...
//
// The tri color invariants, write barrier model, and STW phases are
// unchanged. Only the mark phase work distribution and marking kernel
// have been restructured.
//
// To opt out for A/B comparison:
//   GOEXPERIMENT=nogreenteagc go build ./...
//
// To disable entirely at runtime for a single run:
//   GODEBUG=gctrace=1 GOEXPERIMENT=nogreenteagc ./service
```

### What Did Not Change

This matters for interview questions and for reasoning about correctness.

- **Algorithm**: still concurrent tri-color mark, sweep.
- **Write barrier**: still Yuasa-style deletion barrier plus Dijkstra-style insertion barrier (hybrid barrier introduced in Go 1.8).
- **STW phases**: still two short stop-the-world pauses per cycle (mark start, mark termination). Typical pauses remain sub-millisecond.
- **GOGC and GOMEMLIMIT semantics**: unchanged. Tuning knobs behave identically.
- **Pacer**: the GC pacer model that targets GOGC and respects GOMEMLIMIT is the same.

### When Green Tea Helps Most

Green Tea's benefit scales with the number of **live small objects the mark phase must visit**, and with how badly those objects were scattered in memory before. Ranked qualitatively, from most to least improvement:

| Workload | Why |
|----------|-----|
| Large live sets of small objects (JSON APIs, protobuf services, caches of small records) | Maximum pointer chasing to eliminate, so maximum locality to recover |
| Message consumers with high fan-out and many live objects | Same reason, moderated by how much of the heap is actually live at mark time |
| Batch jobs dominated by a few large allocations | Little to fix, the mark phase visits few objects regardless |
| Low-allocation services | Nothing to fix, GC was not the cost |

You will notice this table has no percentages. That is deliberate. Per-workload figures like "20 to 40 percent for a JSON API" imply a precision nobody can deliver for your service, since the outcome depends on your live set size, your object sizes, your pointer density, and your CPU's cache hierarchy. The published 10 to 40 percent range is a range across the Go team's benchmark suite, not a per-category forecast.

The useful rule is a sanity check rather than a prediction: **Green Tea can only reduce the GC's share of your CPU.** If GC is 2 percent of your CPU today, the absolute best case is recovering most of 2 percent, and it will not move your p99. Check what GC currently costs you before you form any expectation about what a collector change is worth.

### Measuring it on your own service

This is the part worth an afternoon, and it is the reason the opt-out flag matters:

```bash
# Baseline: the classic collector.
GOEXPERIMENT=nogreenteagc go test -bench=. -benchmem -count=10 ./... > classic.txt

# Green Tea (the 1.26+ default).
go test -bench=. -benchmem -count=10 ./... > greentea.txt

# Compare with statistical rigor rather than eyeballing two numbers.
benchstat classic.txt greentea.txt
```

Use `-count=10` and `benchstat` rather than a single run. A single benchmark comparison on a shared or loaded machine will happily show you a 30 percent "improvement" that is pure noise, and GC benchmarks are especially prone to it because they are sensitive to the timing of cycles. `benchstat` reports a p-value and variance, so it tells you when your data is not saying anything. For a serving workload, the equivalent is a canary: run one instance each way and compare GC CPU share and p99 over hours, not minutes.

### Green Tea and GOMEMLIMIT

Nothing to reconfigure. `GOMEMLIMIT` (soft memory limit, introduced in Go 1.19) still works as a hint to the pacer to run GC more aggressively as the heap approaches the limit. Because Green Tea lowers the marginal cost of each GC cycle, running with a tight `GOMEMLIMIT` in a memory-constrained container is slightly cheaper than before, but the tuning procedure is identical.

```go
// Production defaults that remain appropriate on Go 1.27:
//
//   GOGC=100          # Default. Trigger GC when heap doubles.
//   GOMEMLIMIT=1750MiB # Soft cap, ~85 percent of a 2 GiB container.
//   GODEBUG=gctrace=0  # Leave tracing off in production.
//
// If you previously raised GOGC to reduce GC frequency on a hot path,
// Green Tea may let you lower it again without hurting CPU. Measure.
```

> **Senior track**: the real interview trap on Green Tea is assuming it replaced the GC. It did not. The tri-color invariants, write barriers, and pacer are the same collector the Go team has been evolving since 1.5. Green Tea changed how mark work is scheduled and executed on the CPU, not what the collector computes. If you can explain that distinction, and why span-grouped marking improves cache locality, you have the answer a staff-level interviewer is looking for.

> [!NOTE]
> For a detailed architectural breakdown of span-marking work queues, distributed work-stealing GC workers, and L1/L2 cache locality gains under Green Tea GC, see Wesley Wei's deep dive [*Say Goodbye to Go GC Anxiety: Brewing Up Performance with Green Tea GC in Go 1.26!*](https://wesley-wei.medium.com/list/you-should-know-in-golang-e9491363cd9a).

### Adoption playbook for teams on Go 1.27

Upgrading to Go 1.27 is a one-line change in `go.mod` and a rebuild, but rolling Green Tea into production on a service you care about deserves the same discipline as any other runtime change. A reasonable plan: (1) build the service with Go 1.27 and run the existing test suite and benchmarks. Look specifically for `benchstat` deltas in allocation-heavy tests. (2) deploy to a canary with `GOEXPERIMENT=nogreenteagc` set so the canary runs the classic collector while the baseline runs Green Tea. Compare p99, GC CPU share as a rate, and RSS over 24 hours. (3) if Green Tea looks like a win, promote to the fleet and drop the experiment flag. If it does not, investigate why rather than shrugging. The common explanation is a large-object-dominated workload where Green Tea has nothing to optimize. Either way, the data tells you which story applies, and you now own a repeatable A/B procedure for the next runtime change.

### Junior → FAANG: what this means for your interview prep

If you are interviewing in 2026 or later, know four things about Green Tea. First, it is the default in Go 1.26. Second, it is an optimization of the mark phase, not a new algorithm. Third, the tri-color model, the hybrid write barrier, and the pacer are unchanged. Fourth, and this is the one that separates candidates, it does **not** make allocation faster. That was the size-specialized allocator in Go 1.27, a completely separate change.

Practice stating those four in under 30 seconds. Then be ready for "why does span-based marking improve locality," where the answer is contiguous memory access instead of pointer chasing, so fewer cache and TLB misses and a prefetcher that can actually predict the next access. And "when does Green Tea not help," where the answer is large-object-dominated workloads and services where GC was already cheap, since a change to the collector can only ever give back the CPU the collector was using.

If you are pushed for a number, the credible move is to give the published range (10 to 40 percent GC CPU reduction on allocation-heavy workloads) and immediately say how you would verify it on the workload in question with `nogreenteagc` and `benchstat`. Interviewers at this level are testing whether you know the difference between a number you read and a number you measured.

### Senior @ FAANG: the runtime upgrade policy

A quiet but important artifact at staff level is a written runtime upgrade policy for your team's services. It answers: who watches for new Go versions, how long do you wait after a minor release before adopting (typically 3 to 6 months), what is the canary plan, what are the rollback criteria, what benchmarks gate the rollout, and who signs off. Green Tea is a useful forcing function to write this policy if it does not exist yet, because the change is prominent enough to justify the conversation but safe enough that the cost of getting the process wrong is low. Once the policy exists for the 1.25-to-1.26 transition, it serves every future Go upgrade, and the team stops treating runtime updates as ad-hoc events. Predictable upgrade cadence is a staff-level property of a healthy engineering organization.

---
