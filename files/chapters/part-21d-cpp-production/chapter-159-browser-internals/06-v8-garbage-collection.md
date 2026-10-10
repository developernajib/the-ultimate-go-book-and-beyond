## 159.6 V8 Garbage Collection

V8's garbage collector, called Orinoco, is one of the most-tuned production GCs in any language runtime. It is generational, mostly-concurrent, partially parallel, and incremental. The design is documented in `src/heap/` and in the V8 team's blog posts.

### The Generational Hypothesis

Most JS objects die young: temporary closures, intermediate strings, allocations inside a tight loop. Generational GC exploits this by collecting young objects often and old objects rarely.

V8 splits the heap into:

- **New generation (young).** Two semi-spaces, called from-space and to-space.
- **Old generation.** Long-lived objects, promoted from young after surviving two minor GCs.

### Scavenger: Minor GC

The Scavenger collects new generation. Algorithm: Cheney's semi-space copy.

```
Initial state:
  to-space:    [ ] [ ] [ ] [ ] [ ]   (empty)
  from-space:  [A] [B] [C] [D] [E]   (live + dead, mixed)

Roots point into from-space. For each root:
  if target in from-space and not yet copied:
    copy target to to-space, leave forwarding pointer
  update root to to-space address

Then walk to-space breadth-first, scanning copied objects'
fields and recursively forwarding their references.

Final state:
  to-space:    [A'] [C'] [E']        (only live objects, compacted)
  from-space:  [garbage]              (entirety reclaimed in one shot)

Swap roles of from-space and to-space.
```

Scavenges run when the new generation fills up, typically every few hundred milliseconds on a busy page. Pauses are typically 1 to 5 ms. The Scavenger is parallel: multiple worker threads each claim slices of the work.

Surviving objects go through "intermediate generation" first. After surviving twice, they get promoted to old generation.

### Remembered Sets and Write Barriers

The Scavenger is fast because it scans only roots and new-generation objects. But old-generation objects can hold pointers to young objects (`oldObj.field = youngObj`), and those pointers are roots from the Scavenger's perspective.

V8 tracks these "old-to-young" pointers in a remembered set. The write barrier records every pointer write from old to young:

```cpp
// Conceptual - actual code is generated inline by the JIT.
void WriteBarrier(HeapObject* host, ObjectSlot slot, HeapObject* value) {
  if (HostInOldGen(host) && InYoungGen(value)) {
    Page* page = Page::FromAddress(host);
    page->RememberedSet<OLD_TO_NEW>().Insert(slot);
  }
}
```

Every pointer-typed property write in JavaScript inlines a fast-path check. The cost is a branch and a few loads, baked into hot code.

### Mark-Compact: Major GC

When old generation grows past a threshold, V8 runs Mark-Compact:

1. **Mark.** Trace the live object graph from roots. Set a mark bit on each reachable object.
2. **Compact.** Move marked objects to compact pages, updating pointers in place.

A naive stop-the-world Mark-Compact of a 500 MB heap is several hundred milliseconds, which is unacceptable on the main thread. Orinoco breaks the work up.

### Incremental Marking

Instead of marking in one phase, the marker runs in slices interleaved with mutator (JS) execution. Each slice marks a budget's worth of objects, then yields. Total wall time is longer than a stop-the-world mark, but no individual pause exceeds a few milliseconds.

The challenge: the mutator can break the marking invariant. If the marker has marked `A` (black) and not yet marked `B` (white), and the mutator does `A.field = B`, the marker may never visit `B` and falsely collect a live object.

V8 uses the Dijkstra-style tricolor write barrier:

```
white: not yet seen
gray:  seen but children not yet scanned
black: seen, children scanned

Invariant: a black object never points to a white object.

Write barrier: when host->slot = value, if host is black and
value is white, mark value gray (push it on the marking worklist).
```

Same write barrier handles both remembered set and incremental marking duties.

### Concurrent Marking

Beyond incremental, V8 runs marking on background threads concurrently with the main thread. Worker threads pull objects off a shared marking worklist and scan them. The main thread's write barrier pushes objects onto the worklist, workers consume.

Concurrent marking moves the bulk of mark work off the main thread, so the main-thread cost of a major GC is dominated by the final atomic pause (re-scan of stack roots and finalization), typically 5 to 30 ms on a large heap.

### Sweeping

After mark-compact, dead memory is reclaimed by sweeping (for non-compacted pages) or by simply abandoning evacuated pages. Sweeping is concurrent: background threads walk pages, build free lists, and return.

### Compaction

Long-running pages fragment the old generation. Compaction selects evacuation candidates (pages with high fragmentation) and moves live objects out. Pointers are updated using the remembered sets.

V8 compacts only a fraction of pages per major GC, balancing pause time against fragmentation. Page selection uses a heuristic on free-list quality and age.

### Tracing Finalizers

Some objects need cleanup at GC time: external memory, ArrayBuffers backed by native memory, V8-API `Persistent` slots with weak callbacks. V8 supports these through:

- `WeakPersistent<T>` with a callback fired during the atomic pause.
- `EmbedderHeapTracer` (legacy) and the newer `cppgc::Heap` integration for tracing C++ objects whose lifetimes are tied to V8 objects (this is how Blink's Oilpan integrates with V8).
- ArrayBuffer backing stores accounted via `ExternalMemoryAccounting` so the GC knows about external bytes.

### Orinoco Scheduler

The decisions about when to run minor GC, when to start incremental marking, when to run a mark-compact pause are made by the Orinoco scheduler in `src/heap/incremental-marking.cc` and `src/heap/heap.cc`. Inputs:

- Allocation rate (bytes per second).
- Promotion rate (bytes promoted from young to old per second).
- Available embedder idle time (`v8::Platform::IdleTask`).
- Memory pressure signals from the embedder.

The scheduler tries to schedule expensive marking work into idle slots between frames. If the renderer is idle for 4 ms between frames at 60 fps, the GC takes 3 ms of that for incremental marking.

### Pointer Compression and GC

With pointer compression, every pointer is a 32-bit offset into the cage. The GC operates on these compressed pointers throughout. Decompression (adding the cage base) happens at use sites. The Scavenger and Mark-Compact loops are fully aware of compression.

### Memory Pressure API

When the OS or the embedder detects memory pressure (Android low-memory killer warning, browser memory pressure signal), the embedder calls:

```cpp
isolate->MemoryPressureNotification(v8::MemoryPressureLevel::kCritical);
```

V8 responds with an aggressive major GC, including compaction, even if it would not have run otherwise. The trade-off: the user pays a longer pause but avoids being killed.

### Allocation Sites and Pretenuring

V8 attaches allocation site feedback to literal expressions:

```js
function makePoint() {
  return { x: 0, y: 0 };  // allocation site
}
```

After the same allocation site has produced many objects that all survive to old generation, V8 marks the site as "pretenuring": new allocations from that site go directly to old generation, skipping the scavenge entirely. This avoids copying objects that the GC has empirically learned will survive.

### Performance Numbers

- Scavenge: 1 to 5 ms, runs every few hundred ms.
- Major GC main-thread time with concurrent marking: 5 to 30 ms.
- Major GC total wall time: 50 to 300 ms (mostly off main thread).
- Pretenuring decision delay: kicks in after ~1000 allocations from a site.
- Write barrier inline overhead: ~2 ns per pointer write on hot paths.

### Embedder Integration with cppgc

`cppgc` is V8's general-purpose C++ garbage collector library, exposed at `include/cppgc/`. Blink's Oilpan is a fork-and-evolution of cppgc. The embedder allocates a `cppgc::Heap`, declares `GarbageCollected` classes, and the unified heap walks both V8 and cppgc objects in a single GC cycle. This is how a `Member<v8::Object>` field on a Blink DOM node correctly keeps the V8 object alive.

### Senior Interview Material

- "Walk me through a major GC cycle from start to finish, including which work runs concurrently."
- "What is the tricolor write barrier and why is it needed for incremental marking?"
- "Why does V8 have generational GC? What workload would not benefit from it?"
- "Explain pretenuring with an allocation site example."
- "How does Blink's Oilpan integrate with V8's GC such that cycles between DOM nodes and JS objects are collected?"

GC is the silent partner to every JavaScript performance optimization. The next section walks through the embedder API: how Chromium and other embedders actually drive V8.

---
