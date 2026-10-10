## Case Studies

A note on how to read this chapter's case studies, because it determines whether they help you or hurt you.

Public GC war stories are unusually prone to number drift. A figure from one company's 2016 blog post, running a Go version four major releases behind the current one, on hardware that no longer exists, gets repeated until it becomes "the" number, and eventually somebody puts it in a book as if it were a law of nature. This section is explicit about which numbers are published by the companies named, which are illustrative, and which are simply not knowable from outside. Where a figure is not verifiable, it is not invented to fill the gap.

The techniques transfer. The numbers do not.

### Case Study 1: Twitch and the low-latency GC hunt

**Source**: Twitch published "Go's march to low-latency GC" in 2016, still the best public account of hunting GC latency in a high-fan-out chat system.

**What is genuinely instructive**: Twitch was serving millions of concurrent chat users, and their problem was not GC throughput, it was pause-driven latency in a system where a stalled goroutine meant delayed message fan-out. Their write-up walks through the same order of operations this chapter recommends: measure first, attack allocation at the source, and only then reach for knobs.

**Important context before you borrow any number from it**: that post describes Go 1.5 and 1.6, a runtime whose GC is not the one you are running. In that era stop-the-world pauses were a genuine, ongoing engineering problem and a multi-millisecond pause was a realistic thing to hunt. The hybrid write barrier (Go 1.8) later removed the stop-the-world stack rescan that made pauses scale with goroutine count, and pauses on a modern runtime are typically tens of microseconds. So the *shape* of the Twitch investigation is timeless and its *pause figures* are historical artifacts. Anyone quoting "8ms GC pauses in Go" at you today is quoting a runtime from a decade ago.

**The transferable lesson**: their biggest wins came from allocating less and from flattening pointer-heavy structures, not from tuning. That part has aged perfectly.

### Case Study 2: Discord's move from Go to Rust

**Source**: Discord published "Why Discord is switching from Go to Rust" in 2020, about their Read States service.

**The one detail everyone gets wrong, and it is verifiable**: Discord observed latency spikes on a clean two-minute cadence. This was not their allocation pattern and not a coincidence. The Go runtime forces a garbage collection if none has occurred for two minutes, and you can read the constant in the runtime source yourself:

```go
// runtime/proc.go
// forcegcperiod is the maximum time in nanoseconds between garbage
// collections. If we go this long without a garbage collection, one
// is forced to run.
var forcegcperiod int64 = 2 * 60 * 1e9
```

`sysmon`, the runtime's monitoring thread, checks this and forces the cycle. Their service held a large LRU cache, so every forced cycle had a big live heap to mark, and every two minutes the tail latency moved.

**Why this detail matters more than the migration**: it explains why raising `GOGC` could not save them. People routinely propose "just set `GOGC=1600` and the GC will run every N minutes instead," and any statement of that form with N greater than 2 is arithmetically impossible on a stock runtime. `GOGC` controls the *heap ratio* trigger. It has no effect whatsoever on the two-minute forced trigger. Raising `GOGC` on an idle-ish service with a big cache buys you nothing except a bigger heap to mark when the forced cycle arrives anyway.

**Why they actually migrated**: not throughput. They met their throughput goals in Go. They moved for tail-latency predictability, which is the honest and narrow claim. Discord's own published charts are the source to read for the magnitude, rather than any ratio quoted second-hand.

**Lesson**: Go's GC is excellent for the overwhelming majority of workloads. A rewrite is justified only when you have measured that GC *variance* rather than throughput is your bottleneck, you have exhausted the data-structure work, and your organization can carry a second language forever. Most teams clear none of those three bars, let alone all of them.

### Case Study 3: Uber's fleet-wide GOGC tuning

**Source**: Uber's engineering blog documented a fleet-wide, semi-automated GOGC tuning program across a very large Go deployment. The headline result they published is roughly **70,000 CPU cores** reclaimed.

**Why it worked, and why it is not a template**: Uber's win did not come from finding one magic GOGC value. It came from noticing that a fleet-wide default of `GOGC=100` was wrong *per service*, in different directions, and that many services had enormous headroom to trade memory for CPU. They automated the per-service decision instead of making it by hand. The generalizable insight is that the default is a starting point rather than a considered choice, and at fleet scale the aggregate of unconsidered defaults is measured in tens of thousands of cores.

**What does not transfer**: the 70,000 figure is a property of Uber's fleet size and workload mix. It is evidence that fleet-level GC tuning is worth staffing, not a number you can pro-rate onto your own service.

### Case Study 4: Datadog, Swiss Tables, and RSS

**Source**: Datadog published a detailed investigation of the memory impact of Go 1.24's Swiss Tables map implementation across a large fleet.

**Why it is the right anchor for map memory questions**: it is one of very few public datasets large enough to show that the effect is *workload-dependent* rather than a single headline percentage. Services with many small maps and services with a few large maps did not move in the same direction or by the same amount. That nuance is the whole value of the post, and it is exactly what gets flattened when the result is repeated as "Swiss Tables save X percent."

**The operational lesson**: when a runtime-level change lands in a Go release, your baseline moves. Re-measure your own service after the upgrade instead of adopting a number from anyone's fleet, including Datadog's. The rebuild is free, the assumption is not.

### An illustrative walkthrough (not a company, not a measurement)

The following is a **constructed teaching example**. No company is named because none is being described, and the figures are illustrative arithmetic rather than measurements. It exists to show the order of operations end to end.

**Scenario**: a graph service holds a large in-memory routing graph and serves steady read traffic. The p99 correlates with GC cycles.

**Diagnosis**: a heap profile (`-sample_index=inuse_objects`) shows the live set is dominated by `*Node` and `*Edge` objects held in `map[NodeID]*Node` and `[]*Edge` adjacency lists.

**The reasoning that follows, which is the part worth internalizing**:

1. The problem is stated in terms of *pointer count*, not bytes. Every `*Edge` is an edge the mark phase must traverse on every cycle. A slice of a million pointers is a million pointer follows per cycle, forever, no matter how fast the machine is.
2. `map[NodeID]*Node` becomes `[]Node` indexed by a dense integer ID. This removes the per-entry pointer and improves lookup locality at the same time.
3. `[]*Edge` adjacency lists become a CSR (compressed sparse row) layout: one `[]int32` of offsets and one `[]int32` of target IDs. Two pointer-free slices replace millions of pointers, and pointer-free slices are skipped by the collector entirely.
4. Only then is `GOMEMLIMIT` set, as a backstop sized to the working set plus burst plus headroom, with `GOGC` left on.

**How to verify each step, since you should not trust the story**: read `/gc/scan/heap:bytes` from `runtime/metrics` before and after each change. It reports scannable bytes directly, it is deterministic, and it does not care how loaded the machine is. Section 5.3 shows a measured example of this effect: a million-element value slice added about 2.8 KB of scannable heap while a million-element pointer slice added about 8.4 MB.

**Lesson**: the most valuable GC work is at the data-structure layer, not at the pacer knob. Pointer density is a choice you make at design time and pay for on every GC cycle.

### On `GOMEMLIMIT` as a fleet-wide safety net

A pattern worth stating on its own, without attributing invented numbers to a company that has not published them.

`GOMEMLIMIT` is more valuable as a fleet-wide safety net than as a per-service tuning lever. The reasoning: OOMKills in a container orchestrator are cascading failures, because a restart arrives with cold caches and takes more traffic from siblings that are also near their limit. A soft limit converts "the kernel kills the process" into "the GC works harder," which is nearly always the better failure mode.

Three implementation details decide whether the rollout helps or hurts:

- **Set it from the cgroup limit yourself.** `GOMEMLIMIT` is not container-aware. `GOMAXPROCS` has been since Go 1.25, which makes the asymmetry surprising, but as of 1.27.1 the memory limit still defaults to effectively off regardless of your container's limit. A common formula is the container memory limit minus 10 to 20 percent headroom.
- **Leave `GOGC` on.** If the ratio trigger is disabled, the limit becomes the only trigger, and a service whose live heap approaches the limit will collect continuously without making progress. That is the death spiral, and it is worse than an OOMKill because nothing restarts and nothing pages.
- **Alert on the case where it engages.** The limit is supposed to be a backstop that rarely fires. A service persistently near it is a sizing mistake wearing a disguise. Alert on GC CPU share (`rate(go_cpu_classes_gc_total_cpu_seconds_total[5m])` over the CPU total), not on the fictitious `go_gc_cpu_fraction`, and treat a trip as a capacity conversation.

**Lesson**: set it high enough that it rarely engages, and let the alert on engagement expose the pre-existing sizing bug. The platform win comes from the alerting as much as from the limit.

### Cross-case patterns

Reading these in sequence, three patterns hold up.

First, the single most useful wins come from data structures, not from `GOGC`. Twitch flattened pointer-heavy message structures. The CSR walkthrough above removes pointers wholesale. Pointer density reduction buys more than any pacer tuning, and it does not have to be re-litigated every time you upgrade Go.

Second, order matters. Measure, reduce allocations, flatten structures, set `GOMEMLIMIT`, and only then consider `GOGC`. Teams that reach for `GOGC` first tend to move the symptom while leaving the cause in place, which is how a service ends up with a mysterious tuning constant nobody dares change three years later.

Third, be ruthless about the provenance of numbers, including the ones in this chapter. Every figure above is either attributed to a public source, labeled illustrative, or measured and labeled with the toolchain and hardware. When you find a GC statistic in the wild, ask which Go version it was measured on, what the live heap was, and whether the author measured it or repeated it. A striking number with no provenance is not evidence, and in a field where the runtime changes meaningfully every six months, it has a short shelf life even when it was once true.

### Senior @ FAANG: your own internal case study

The most valuable case study is the one your team writes about your own service. A well-maintained internal case study, refreshed quarterly, includes: baseline metrics (RSS, GC CPU, pause distribution, allocation rate), the three most impactful tuning changes and their measured effect, the three rejected changes and why, the open problems and who owns them, and the projected impact of the next Go version upgrade on each metric.

Include the Go version and hardware on every number, and re-measure rather than re-quote after each upgrade. This document is the difference between tribal knowledge that walks out the door with attrition and a durable artifact the next engineer inherits. Writing it forces the clarity that separates "we tuned the GC" from "we understand why the GC behaves this way on this workload." The second is a senior-level claim. The first is a guess.

---
