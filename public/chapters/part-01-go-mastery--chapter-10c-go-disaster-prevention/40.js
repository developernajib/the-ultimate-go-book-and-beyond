export default `## Summary

This chapter covered 38 classes of Go runtime disasters with concrete examples, root cause explanations, and fixes. Here is a quick reference for the most common ones:

| Disaster | Root Cause | Fix |
|----------|-----------|-----|
| Integer overflow | Silent two's complement wraparound | Bounds check before operation. Use int64 |
| Float NaN/Inf | IEEE 754 special values propagate silently | Check IsNaN/IsInf. Never use float for money |
| Division by zero | Int panics. Float returns Inf/NaN | Guard \`b != 0\` before every division |
| Interface nil trap | Interface has two fields: type + data | Return untyped \`nil\` from functions returning \`error\` |
| Nil pointer dereference | Accessing field through nil pointer | Check pointers before dereferencing |
| Slice append aliasing | Slices share backing array until reallocation | Use full slice expression \`s[l:h:h]\` or \`copy()\` |
| Map concurrent write | Go maps are not goroutine-safe | Use \`sync.RWMutex\` or \`sync.Map\` |
| Nil map write | nil map has no storage | \`make(map[K]V)\` before first write |
| Send on closed channel | Immediately panics | Sender owns the close. Use \`sync.Once\` for multi-sender |
| Type assertion panic | Direct assertion on wrong type | Always use comma-ok: \`v, ok := i.(T)\` |
| Stack overflow | Unbounded recursion exhausts stack memory | Base cases. Iterative alternatives for deep trees |
| Closure capture | Goroutine captures reference, not value | Pass as argument. Use \`v := v\` shadow in loop |
| Defer in loop | Defers run at function return, not iteration | Move logic to helper function |
| Mutex copy | sync types have internal state that breaks when copied | Always use pointer receivers for types with sync fields |
| WaitGroup misuse | Add after goroutine start races with Wait | Always \`Add\` before \`go\` |
| Shadowed error | \`:=\` creates new scope variable | Use \`=\` for already-declared \`err\` |
| Goroutine leak | Goroutine blocked forever on channel/IO | All goroutines must have a \`ctx.Done()\` exit path |
| Time zone bugs | \`time.Parse\` defaults to UTC. DST changes hours | \`time.ParseInLocation\`; \`AddDate\` for calendar math |
| JSON integer precision | float64 loses precision for large integers | Use \`json.Number\` or \`json.Decoder.UseNumber()\` |
| Context nil | Methods on nil context panic | Always pass \`context.Background()\` or \`context.TODO()\` |
| Context key collision | String keys collide across packages | Use unexported struct type as context key |

The most important tool: **run \`go test -race ./...\` and \`go vet ./...\` on every commit**. These two commands catch the majority of disasters before they reach production.

---

*Next chapter: Chapter 11, Concurrency Fundamentals*
`;
