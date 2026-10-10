# Appendix H: Go Glossary

**Definitive Systems, Compiler, and Runtime Terminology Reference**

---

### Overview & How to Use This Glossary

Whether you are preparing for senior and staff-level FAANG technical interviews, reviewing architecture design documents, or debugging low-level runtime traces, having precise, systems-level definitions for Go terminology is essential.

This glossary provides deep, authoritative definitions spanning the Go compiler, the M:N scheduler, memory management, garbage collection, concurrency primitives, and distributed systems architecture. Entries avoid superficial summaries and focus on actual runtime mechanics and operational implications.

### Key Conceptual Areas Covered

- **The Runtime & Scheduler**: M:N GMP model (Goroutines, Machines, Processors), runqueues (local vs. global), work stealing, sysmon preemption, netpoller (epoll/kqueue), and stack allocation (copying stacks, split stacks, 2KB initial bounds).
- **Memory & Garbage Collection**: Tri-color mark-and-sweep, write barriers, stop-the-world (STW) phases, GC pacing, GOGC, GOMEMLIMIT, memory spans, size classes, mcache, mcentral, mheap, escape analysis, and sync.Pool.
- **Type System & Compiler**: Interfaces, runtime.itab, dynamic dispatch, type assertions, reflection (reflect.Type, reflect.Value), monomorphization vs. gcshape stenciling in generics, and unsafe pointer arithmetic.
- **Concurrency Primitives**: Channels (hchan, waitq, sudog), select state machine, mutexes (sync.Mutex, sync.RWMutex), starvation mode, atomics (sync/atomic), and data races under the Go memory model.
- **Alphabetical A–Z Terms**: Exhaustive terminology indexed from A to Z, supplemented with quick-reference comparison tables and company-specific nomenclature from Google, Uber, and Cloudflare.

---
