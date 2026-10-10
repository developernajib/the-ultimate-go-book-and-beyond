## 07. Constraints and the Craft of Programming

The 1990s produced a disproportionate number of programmers whose work still shapes what we build
today. John Carmack, Linus Torvalds, Fabrice Bellard, Dave Plummer. The names cluster in that
decade for a specific reason: hardware constraints so severe that creativity was the only path
forward. Understanding what they built, and how, is directly applicable to writing better code
right now.

### The Hardware Reality

In 1990, a well-equipped home PC had 1 MB of RAM and a 33 MHz CPU. The cheapest smartphone on
Amazon today carries 2 GB of RAM, roughly 2000 times as much, and a processor running at 3 GHz
with 8 cores. The smartphone in your pocket is a more powerful computer than the supercomputers
of 1990.

RAM was so scarce that programmers counted bytes the way a long-distance cyclist counts grams.
Every variable declaration was a decision. Every string buffer was a negotiation. There was no
`malloc` and hope for the best. You had a fixed pool and you made it work.

There were no frameworks, no package registries, no Stack Overflow. If you needed a data
structure, you wrote it. If you needed a rendering algorithm, you invented one. When something
broke, you read hexadecimal memory dumps until you found the bad address. The tooling was minimal:
a compiler, a linker, and maybe a primitive debugger.

This was not romantic. It was painful and slow. But the constraints forced a style of thinking
that produced remarkable results.

### What Constraint-Driven Programming Produced

**Doom (1993)** ran on a 386 processor with 4 MB of RAM. It rendered a 3D-looking environment at
playable frame rates without a GPU. The entire game shipped on a set of floppy disks. John
Carmack did not have the hardware to render a real 3D scene, so he invented a different approach:
the BSP tree.

A Binary Space Partition (BSP) tree divides a 2D map into convex regions. For a given viewpoint,
the tree can be traversed to determine the back-to-front drawing order of all walls without
sorting. The algorithm is O(n) per frame once the tree is built. Carmack pre-computed the BSP
tree at compile time and stored it in the level data. The runtime paid almost nothing for
visibility ordering.

The renderer also exploited the fact that Doom's world was strictly 2.5D. Walls were always
vertical, floors and ceilings were always flat. This constraint eliminated the need for per-pixel
depth calculations. The renderer cast one ray per screen column and drew a vertical slice. A full
frame required only 320 ray casts on a 320-pixel-wide screen.

These are not workarounds. They are algorithms derived from careful analysis of what the hardware
could and could not do. The constraint revealed the algorithm.

**`.kkrieger` (2004)** is a complete first-person shooter that fits in 96 kilobytes, smaller than
most JPEG images. Every asset, texture, sound, and level geometry is procedurally generated at
runtime from compact mathematical descriptions. The demoscene group that made it spent years
compressing artistry into mathematics. The binary is smaller than this chapter.

The demoscene more broadly, a community that produces audiovisual demos as competitive art, still
exists and still runs under the same constraints by choice. They write effects that would make
most graphics engineers nervous, using techniques that require knowing exactly what the GPU's
shader units are doing at a cycle level.

### The Fast Inverse Square Root

One of the most famous examples of constraint-driven cleverness is the fast inverse square root
from the Quake III source code, attributed to several engineers including Carmack's team:

```c
float Q_rsqrt(float number) {
    long i;
    float x2, y;
    const float threehalfs = 1.5F;

    x2 = number * 0.5F;
    y  = number;
    i  = * ( long * ) &y;            // evil floating point bit level hacking
    i  = 0x5f3759df - ( i >> 1 );    // what the f***?
    y  = * ( float * ) &i;
    y  = y * ( threehalfs - ( x2 * y * y ) ); // 1st iteration of Newton's method
    return y;
}
```

Inverse square root (`1/sqrt(x)`) is needed constantly in 3D graphics for normalizing vectors.
The IEEE 754 floating-point representation stores numbers as `(-1)^s * 1.mantissa * 2^exponent`.
The key observation is that when you interpret a float's bit pattern as an integer, the exponent
part behaves logarithmically. The magic constant `0x5f3759df` exploits this to compute a good
initial estimate for `1/sqrt(x)` using only integer arithmetic (which was much faster than FPU
operations on that hardware). One iteration of Newton's method then refines the estimate to
sufficient precision for lighting calculations.

The result was roughly four times faster than calling `sqrt()` and dividing. On hardware where
every FPU cycle was expensive, this was the difference between a smooth frame and a stuttering one.

The insight required understanding floating-point representation at the bit level, knowing the
Newton-Raphson iteration for square roots, and having a hardware target where this optimization
made a measurable difference. None of that knowledge was produced by abundance. It was produced
by necessity.

### The Lesson: Knowing the Cost of Your Abstractions

Every abstraction has a cost. A garbage collector is an abstraction over manual memory management.
It pays a throughput and latency cost in exchange for safety and convenience. A dynamic dispatch
table is an abstraction over a direct function call. It pays a cache miss cost in exchange for
polymorphism. An `interface{}` in Go is an abstraction over a typed value. It pays an allocation
and indirection cost in exchange for generality.

90s programmers knew these costs because they had no choice. When you have 1 MB of RAM, you
cannot afford an abstraction whose overhead you do not understand. Today you can, and most of the
time you should, because the engineering time saved by an abstraction outweighs the runtime cost.

The 90s lesson is not "avoid abstractions." It is "know what you are paying." A senior engineer
reaches for an abstraction and can estimate what it costs. A junior engineer reaches for an
abstraction and assumes it is free.

### Modern Manifestations of the Same Mindset

**Google's resource budgets**: Large-scale services at Google are allocated CPU quotas, memory
caps, and network bandwidth limits. Engineers working in those environments profile continuously
and treat allocation as expensive because at their scale it is. The budget is artificial, but the
thinking it produces is the same thinking that came from real scarcity.

**Game console development**: Console platforms have fixed hardware. A PlayStation game runs on
exactly one GPU with exactly one amount of VRAM and exactly one CPU configuration. Console
engineers profile every frame, write allocation-free hot paths, and hand-tune shaders. The
constraint is the platform, not a budget document.

**Embedded systems**: A microcontroller for an IoT sensor might have 32 KB of flash and 4 KB of
RAM. Every library pulled in must justify its footprint. Stack depth is a design consideration.
Dynamic allocation is often forbidden entirely.

**The demoscene (still running)**: People today voluntarily write programs that fit in 4 KB or
64 KB as a creative and technical exercise. The constraint is self-imposed, but it produces the
same quality of analysis that 90s hardware scarcity produced.

### Applying This in Go

Go's runtime is generous by modern standards. The garbage collector handles memory. The scheduler
manages goroutines. Allocating a struct on the heap costs a handful of nanoseconds. For most
programs, these costs are irrelevant.

For high-throughput systems, they are not. In a hot path that processes millions of events per
second, the GC pressure from unnecessary allocations will show up in latency spikes. The 90s
mindset applied to Go means:

**Profile before optimizing.** The 90s programmer had no choice but to think about performance
from the start. You have `pprof`. Use it to find the actual bottleneck before spending time on it.

**Write allocation-free hot paths.** Pool objects with `sync.Pool`. Prefer value types over
pointer types where the struct is small. Use `[]byte` buffers that are reused, not reallocated.
Pre-allocate slices to their expected capacity.

**Know when to reach for `unsafe`.** The Go runtime does not let you look at the bit pattern of a
float directly, but `unsafe.Pointer` and `math.Float64bits` do. These are the modern equivalents
of the Quake trick: use them when you have profiled and found that the safe version is the
bottleneck.

**Understand the cost of `interface`.** An interface value carries two pointers: one to the type
descriptor, one to the data. A method call through an interface is an indirect call through the
vtable, which the branch predictor may miss. This is not a reason to avoid interfaces. It is a
reason to know when the hot path should use a concrete type.

**Budget goroutines.** A goroutine costs about 2 KB of initial stack and a scheduler slot.
Spawning thousands of goroutines per second for trivial work wastes that budget. The 90s
programmer counted memory. You can count goroutines.

### The Mindset, Not the Constraints

The constraints of the 1990s are gone. You will not ship a product on 4 MB of RAM. The mindset
they produced is not gone, and it is the part worth keeping.

The best engineers today operate as if they are resource-constrained even when they are not. They
know what their abstractions cost. They profile before they optimize. They treat CPU cycles and
memory allocations as finite resources to be spent deliberately, not assumed to be free.

Carmack did not write BSP trees because he loved data structures. He wrote them because the
hardware left him no other path to a working game. You have modern hardware. You also have
modern scale, modern concurrency, and modern user expectations. The craft the 90s produced is
the right tool for all of it.

---

Watch the original video: https://www.youtube.com/watch?v=E60bCKnkItM

---

| [◀ Chapter 168: CPU and OS Concurrency Foundations](../chapter-168-cpu-os-concurrency-foundations/00-introduction.md) | [Chapter 169: Computer Hardware and Software Foundations](00-introduction.md) | [Chapter 133: Concurrency in C++](../../part-21b-cpp-concurrency-systems/chapter-133-concurrency-cpp/00-introduction.md) ▶ |
