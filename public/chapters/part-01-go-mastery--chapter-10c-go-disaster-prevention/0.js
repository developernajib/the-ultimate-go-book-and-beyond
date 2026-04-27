export default `# Chapter 10C: Go Disaster Prevention, Avoiding Runtime Catastrophes

*"Every bug is a teacher. The best engineers learn from other people's bugs, not their own."* - Go Community

Go is famous for being simple and safe compared to C or C++. But "safe" does not mean "disaster-proof." Go has its own class of silent killers, integer overflow that silently corrupts financial data, nil interface traps that panic in production but never in tests, slice aliasing bugs that corrupt unrelated data, goroutine leaks that silently consume memory for days before OOM-killing a service. These are not theoretical: they have caused real outages at Cloudflare, Uber, Docker, and hundreds of smaller companies.

This chapter catalogs every class of Go runtime disaster. Each section shows you the exact failure mode, why Go behaves this way, what the bug looks like in code, what actually happens at runtime, and how to fix it. After reading this chapter, you should be able to spot these bugs in your own code and catch them during code review.

**What you will learn:**

- **Numeric disasters** - integer overflow, underflow, float NaN/Inf, division by zero, silent corruption
- **Nil disasters** - nil pointer panics, the infamous interface nil trap, nil map writes
- **Slice disasters** - append aliasing, out-of-bounds panics, slice header copy confusion
- **Map disasters** - concurrent write panics, nil map assignment, range ordering
- **Channel disasters** - send on closed channel, nil channel deadlock, unbuffered channel deadlock
- **Type system disasters** - type assertion panics, interface{} pitfalls, enum without iota
- **String disasters** - byte vs rune, invalid UTF-8, costly conversions in hot paths
- **Closure disasters** - goroutine variable capture, loop variable capture
- **Defer disasters** - defer in loops, argument evaluation timing, panic/recover misuse
- **Concurrency disasters** - mutex copy, WaitGroup misuse, double-close, select default traps
- **JSON disasters** - unexported fields, pointer vs value receiver, time.Time, json.Number
- **Time disasters** - time zone bugs, time.After leaks, monotonic clock confusion
- **Context disasters** - nil context, value key collisions, ignoring cancellation
- **Initialization disasters** - init() ordering, package-level race, circular imports
- **Error disasters** - swallowed errors, shadowed err, string-matching error messages
- **Memory disasters** - goroutine leaks, finalizer misuse, unsafe pointer rules

---
`;
