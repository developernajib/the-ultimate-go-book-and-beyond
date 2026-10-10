## eBPF Architecture

eBPF (extended Berkeley Packet Filter) splits execution across two privilege domains: a Go user-space loader that calls the `bpf()` syscall to inject compiled ELF programs, and the kernel-space eBPF VM that runs them after the verifier proves they terminate safely and cannot corrupt kernel memory. Once verified, the JIT compiler translates eBPF bytecode to native machine instructions, achieving near-native performance. Communication between the two domains flows through shared eBPF maps, typed key/value stores that both the kernel program and the Go process can read and write concurrently without locking.

```
┌──────────────────────────────────────────────────────────────────┐
│                        eBPF Architecture                         │
│                                                                  │
│  User Space                    Kernel Space                      │
│  ──────────                    ────────────                      │
│  Go Program                    eBPF VM                           │
│  ┌──────────┐                  ┌────────────────────────┐        │
│  │ Load ELF │──── bpf() ──────►│ Verifier (safety check)│        │
│  │ Attach   │                  │ JIT Compiler           │        │
│  │ Read Maps│◄─── events ─────│ Program execution      │         │
│  └──────────┘                  └────────────────────────┘        │
│                                         │                        │
│  eBPF Program Types:            eBPF Maps (shared state):        │
│  • kprobe/kretprobe             • Hash map                       │
│  • tracepoint                   • Array                          │
│  • XDP (network)                • Ring buffer                    │
│  • tc (traffic control)         • Per-CPU array                  │
│  • socket filter                • LRU hash                       │
│  • perf event                   • Stack trace                    │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Understanding eBPF Architecture from First Principles

The two-domain split (user space loader and kernel VM) is the conceptual anchor for everything else in eBPF. Juniors often conflate the eBPF program with the Go program that loads it, which leads to confusion about where execution happens and which side owns data. The mental model to internalize: your Go process is a control plane that sends instructions and reads results. The eBPF bytecode is a data plane that runs inside the kernel at hook points. They communicate exclusively through maps and ring buffers, never through shared memory or function calls.

The verifier is the most important architectural component to understand deeply before writing production eBPF. It performs abstract interpretation of every possible execution path through the program, tracking the type and bounds of every register at every instruction. When it rejects a program, the error message names the instruction index and the violated constraint. Practice reading verifier output by intentionally writing programs that dereference a map value without checking for NULL, access a stack offset out of bounds, or use an uninitialized register. Fixing these errors teaches the verifier's rules faster than reading documentation.

The JIT compiler transforms verified bytecode to native instructions for the host architecture (x86-64, ARM64, s390x). The practical consequence is that eBPF programs run at roughly the same speed as compiled C, not at interpreter speed. This is why XDP programs can process packets at 10-100 Gbps on commodity hardware. For interview purposes, the key point is that the verifier proof is what makes JIT safe: without the verifier, running arbitrary user-supplied code in the kernel at native speed would be catastrophic.

In FAANG interviews, eBPF architecture questions often take the form: "How does eBPF compare to kernel modules for observability?" The answer: eBPF is safer (verifier prevents crashes and invalid memory access), more portable (CO-RE allows single binary across kernel versions), easier to deploy (no module signing, no reboot), and has a higher-level toolchain (Go loaders, bpftool, libbpf). Kernel modules are appropriate only when you need arbitrary kernel access that the BPF instruction set cannot express.

### Senior @ FAANG: Architectural Constraints and Platform Design Implications

Understanding eBPF architecture at the staff level means understanding its constraints as design boundaries, not just its capabilities. The 512-byte stack limit is the most impactful constraint for complex programs. When you need to process a large struct from kernel memory (such as a full `task_struct`), you cannot place it on the BPF stack. The solution is to use a single-entry `BPF_MAP_TYPE_PERCPU_ARRAY` as a scratch buffer, accessed by index 0, which acts as a heap allocation. Designing your eBPF data structures to work within this constraint from the beginning avoids painful refactors later.

The complexity limit (originally 4096 instructions, now higher with bounded loops) affects program structure for sophisticated use cases. Tail calls (`bpf_tail_call`) allow chaining up to 33 programs together, each within the limit, to implement logic that would otherwise be too large. Platform teams need to document the tail call chain architecture in ADRs because the call depth limit (33) and the shared map used for the tail call table are constraints that affect all programs in the chain. Changes to one program in the chain can break others in non-obvious ways.

Map type selection is an architectural decision with performance and correctness consequences. `BPF_MAP_TYPE_HASH` uses a spinlock on concurrent updates, which creates contention on multi-core systems. `BPF_MAP_TYPE_PERCPU_HASH` eliminates the lock by giving each CPU its own hash table, but requires the user-space consumer to sum across all CPUs when reading aggregated counters. `BPF_MAP_TYPE_LRU_HASH` evicts entries when full, which is correct for connection tracking but wrong for a configuration store. Documenting the map type rationale in code comments is a senior engineering discipline because the wrong map type causes subtle bugs that appear only under load.

The ring buffer architecture (`BPF_MAP_TYPE_RINGBUF`) is the correct choice for event streaming in programs written against kernel 5.8+. Unlike perf event arrays, a ring buffer is shared across all CPUs, which simplifies the Go consumer (one reader goroutine instead of N per-CPU readers), and supports in-kernel reservation (the program can reserve space, fill it, then commit, avoiding partial writes). Designing your event pipeline around ring buffers also enables backpressure: if the Go consumer falls behind, the ring buffer fills and `bpf_ringbuf_reserve` returns NULL, allowing the eBPF program to increment a drop counter rather than silently losing data.

At the L7 level, eBPF architecture discussions center on the interaction between eBPF and the kernel's memory subsystem. Every map lookup that touches a cache line not in L1 costs 40-100 cycles. On a high-throughput XDP path processing millions of packets per second, map access patterns dominate performance. Staff engineers profile map access with `bpftool prog profile` and redesign map schemas to maximize cache locality: using fixed-size arrays instead of hash maps where the key space is bounded, sizing entries to be cache-line-aligned, and co-locating frequently accessed fields within the same cache line. This is the kind of optimization that requires both kernel internals knowledge and systems programming intuition.

---
