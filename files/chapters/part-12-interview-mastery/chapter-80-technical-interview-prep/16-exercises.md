## Exercises

### Exercise 1: Fix the Bug

This function launches a goroutine per item but closes over the loop variable `item`, which is a classic Go concurrency pitfall: by the time the goroutine runs, the loop may have advanced `item` to a later value. There is also a data race on `result` since multiple goroutines append to it concurrently without synchronization. Spot both issues, then apply the standard fixes, pass `item` as a parameter to the goroutine literal and protect `result` with a `sync.Mutex` or replace the goroutine pattern with a `sync.WaitGroup` combined with a channel.

```go
// This code has a bug. Find and fix it.
func processItems(items []string) []string {
    var result []string
    for _, item := range items {
        go func() {
            result = append(result, strings.ToUpper(item))
        }()
    }
    return result
}
```

### Exercise 2: Implement a Simple Connection Pool
Design and implement a connection pool with:
- Maximum connections limit
- Connection timeout
- Connection reuse

### Exercise 3: Write a Generic Cache
Implement a thread-safe generic cache with:
- Get/Set operations
- TTL support
- LRU eviction

---

**Next Chapter: System Design Interviews** - We'll cover how to approach system design questions with Go, including designing distributed systems and explaining trade-offs.

---

### Junior → FAANG: Exercises as the Real Preparation Unit

Reading this chapter is preparation for the exercises. The exercises are the actual preparation. For junior candidates, the temptation is to skim exercises and return to reading more content. Resist this. One completed exercise under timed conditions teaches you more about your real interview readiness than ten sections of text.

For the bug-finding exercise: resist the urge to run the code. Train yourself to read Go statically, which is a skill that accelerates all code review work and is directly tested in some FAANG debug-focused rounds.

First-job habit: treating exercises as the real unit of learning applies to all technical skill development, not just interview preparation. Engineers who build things (even small things) every day improve faster than engineers who only read. Use the exercises as a baseline and extend them: change the constraints, add concurrency, add error handling, add tests.

### Senior @ FAANG: Designing Exercises as an Interview Quality Signal

For senior candidates, the ability to evaluate and design exercises is itself an interview signal. If asked "what would you add to this interview to better assess senior candidates," having a specific, well-reasoned answer demonstrates that you understand what senior engineering looks like from the outside.

A well-designed senior-level Go exercise has these properties: it has an obvious solution that is correct but not optimal, it has a less obvious solution that requires knowledge of Go-specific primitives (e.g., `sync.Pool`, `atomic`, or a specific use of `select`), and it has at least one follow-up that introduces a constraint that invalidates the first solution (e.g., "now make it thread-safe" or "now make it work within a 1ms latency budget"). Exercises with this structure assess pattern recognition, Go fluency, and adaptability under changing constraints.

Governance application: if you become an interviewer, periodically revisit the exercises your team uses. Interview questions have a half-life: once a question circulates on Glassdoor or Blind, candidates can rehearse it without understanding it. The discipline of retiring stale questions and designing fresh ones that test the same skills at the same level is part of maintaining a high-quality interview process.
