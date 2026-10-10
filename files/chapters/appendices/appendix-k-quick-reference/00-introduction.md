# Appendix K: Quick Reference Card

**Dense Systems Cheat Sheet: Syntax, Primitives, Runtime Limits, Memory Overheads, and Diagnostic Commands**

---

### Overview: High-Yield Production Cheat Sheet

When diagnosing high-severity production incidents, conducting architecture whiteboard reviews, or pairing on complex systems code, engineers need instant, authoritative access to Go syntax, concurrency primitives, runtime configurations, and diagnostic flags without sifting through pages of narrative documentation.

This appendix is a dense, high-yield reference card summarizing the entire Go language, runtime boundaries, standard library idioms, and operational commands.

### What Is Covered in This Quick Reference

- **Language Fundamentals**: Variable declarations, zero values, basic type representations, control flow syntax, and function return semantics.
- **Data Structures**: Slices (length, capacity, 3-index slicing, copy gotchas), maps (initialization, deletion, iteration), structs (tags, alignment, padding), interfaces (satisfaction, dynamic dispatch), and pointers.
- **Concurrency & Channels**: Channel states table (read/write/close behavior on nil, closed, and open channels), select multiplexing, and synchronization primitives (sync.Mutex, sync.RWMutex, sync.WaitGroup, sync.Once, sync.Pool, atomic).
- **Error Handling & Text**: Modern error wrapping (fmt.Errorf("%w"), errors.Is, errors.As, errors.Join), string manipulation, and format specifiers table (%v, %+v, %#v, %T, %q, %x).
- **I/O, JSON, & HTTP**: File I/O recipes, JSON struct tags and custom marshaling, HTTP server/client configuration with robust timeouts, and request body draining.
- **Testing & Benchmarking**: Table-driven test templates, subtest execution, memory benchmark flags (-benchmem), and race detection.
- **Tools & Environment Variables**: Essential go commands, build tags, and runtime environment controls (GOMAXPROCS, GOMEMLIMIT, GOGC, GODEBUG).
- **25 Golden Production Rules & Idioms**: Battle-tested rules for memory allocation, concurrency hygiene, error propagation, and context handling.
- **Company Code Standards & Official Specs Index**: Style standards from Google and Uber alongside official language and architecture references.

---
