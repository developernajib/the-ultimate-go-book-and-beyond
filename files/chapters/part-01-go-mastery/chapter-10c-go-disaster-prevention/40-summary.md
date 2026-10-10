## Summary

Here is a summary of 38 classes of Go runtime disasters with concrete examples, root cause explanations, and fixes for quick reference:

| Disaster | Root Cause | Fix |
|----------|-----------|-----|
| Integer overflow | Silent two's complement wraparound | Bounds check before operation. Use int64 |
| Float NaN/Inf | IEEE 754 special values propagate silently | Check IsNaN/IsInf. Never use float for money |
| Division by zero | Int panics. Float returns Inf/NaN | Guard `b != 0` before every division |
| Interface nil trap | Interface has two fields: type + data | Return untyped `nil` from functions returning `error` |
| Nil pointer dereference | Accessing field through nil pointer | Check pointers before dereferencing |
| Slice append aliasing | Slices share backing array until reallocation | Use full slice expression `s[l:h:h]` or `copy()` |
| Map concurrent write | Go maps are not goroutine-safe. The runtime's fatal check is a best-effort backstop, not a guarantee | Use `sync.RWMutex` or `sync.Map`. Prove it with `-race`, not with a clean run |
| Nil map write | nil map has no storage | `make(map[K]V)` before first write |
| Send on closed channel | Immediately panics | Sender owns the close. For multi-sender, close a done channel through `sync.Once` and leave the data channel open |
| Type assertion panic | Direct assertion on wrong type | Always use comma-ok: `v, ok := i.(T)` |
| Stack overflow | Unbounded recursion exhausts stack memory | Base cases. Iterative alternatives for deep trees |
| Closure capture | Loop variables are per-iteration since 1.22, but every OTHER captured variable is still shared | Pass values as arguments. Check `go.mod`, since the 1.22 semantics follow the module's go directive |
| Defer in loop | Defers run at function return, not iteration | Move logic to helper function |
| Mutex copy | sync types have internal state that breaks when copied | Always use pointer receivers for types with sync fields |
| WaitGroup misuse | Add after goroutine start races with Wait | Always `Add` before `go`, or use `wg.Go` (Go 1.25+), which pairs them for you |
| Shadowed error | `:=` creates new scope variable | Use `=` for already-declared `err` |
| Goroutine leak | Goroutine blocked forever on channel/IO | All goroutines must have a `ctx.Done()` exit path |
| Time zone bugs | `time.Parse` defaults to UTC. DST changes hours | `time.ParseInLocation`, `AddDate` for calendar math |
| JSON integer precision | float64 loses precision for large integers | Use `json.Number` or `json.Decoder.UseNumber()` |
| Context nil | Methods on nil context panic | Always pass `context.Background()` or `context.TODO()` |
| Context key collision | String keys collide across packages | Use unexported struct type as context key |

If you take one thing from this chapter, take this: **run `go test -race ./...` and `go vet ./...` on every commit**. They do not catch every disaster above, and no tool does. What they catch is the subset that is hardest for a human to see and most expensive to find in production, which is the whole point of spending machine time on it.

The pattern worth internalizing across all 38: none of these fail loudly at the moment you write them. Integer overflow returns a number. A nil map reads fine. A typed-nil error prints `<nil>`. A leaked goroutine consumes nothing you would notice. Go's disasters are quiet by construction, and that is exactly why a checklist and a CI pipeline beat vigilance.

---

*Next chapter: Chapter 11, Concurrency Fundamentals*
