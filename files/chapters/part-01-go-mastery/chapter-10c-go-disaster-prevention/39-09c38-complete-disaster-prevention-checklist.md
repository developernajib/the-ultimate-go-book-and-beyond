## 10C.38 Complete Disaster Prevention Checklist

Use this checklist during code review and self-review. Most of it is habit, but three lines below are worth more than the rest combined, because a machine enforces them: `go vet`, `-race`, and the two linters that are off by default. Everything a tool can catch should be caught by a tool, and the checklist reserved for what only a human can see.

```
┌───────────────────────────────────────────────────────────────────────┐
│              Go Disaster Prevention Checklist                         │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  NUMERIC SAFETY                                                       │
│  ☐ Integer arithmetic uses int64 for large values                     │
│  ☐ Financial values use int64 cents, never float                      │
│  ☐ Integer conversions have bounds checks                             │
│  ☐ Division checks b != 0 before dividing                             │
│  ☐ Float comparisons use epsilon, never ==                            │
│  ☐ Float results checked for NaN/Inf before use                       │
│                                                                       │
│  NIL SAFETY                                                           │
│  ☐ Functions returning error return nil (not typed nil)               │
│  ☐ Pointer fields checked before dereference                          │
│  ☐ Maps initialized before first write                                │
│  ☐ Nil interface and nil pointer are never conflated                  │
│                                                                       │
│  SLICE SAFETY                                                         │
│  ☐ Subslices passed to functions use [low:high:high] or copy          │
│  ☐ Index accesses are bounds-checked                                  │
│  ☐ Append result is always assigned back (s = append(s, v))           │
│  ☐ for range modifies use index (s[i].field = ...) not copy           │
│                                                                       │
│  MAP SAFETY                                                           │
│  ☐ Maps accessed from multiple goroutines use sync.RWMutex            │
│  ☐ Map keys are not relied upon for ordering                          │
│                                                                       │
│  CHANNEL SAFETY                                                       │
│  ☐ Only the sender closes a channel                                   │
│  ☐ Multi-sender shutdown closes a done channel, not the data one      │
│  ☐ Every goroutine has an exit path (ctx.Done or close check)         │
│  ☐ Every blocking SEND has a cancellation path too, not just work     │
│  ☐ Reused deadlines use one time.NewTimer, not time.After per loop    │
│                                                                       │
│  TYPE SAFETY                                                          │
│  ☐ Type assertions use comma-ok form                                  │
│  ☐ any/interface{} unmarshaling checks type before assertion          │
│  ☐ JSON integer fields use json.Number for large values               │
│                                                                       │
│  STRING SAFETY                                                        │
│  ☐ len(s) is bytes: correct for buffers, wrong for "how many chars"   │
│  ☐ Code point counts use utf8.RuneCountInString, not len              │
│  ☐ Substrings kept long-term are strings.Clone'd off the big string   │
│                                                                       │
│  CONCURRENCY SAFETY                                                   │
│  ☐ sync types (Mutex, WaitGroup) are never copied at all              │
│  ☐ WaitGroup.Add() called before goroutine launch (or use wg.Go)      │
│  ☐ Closures capture only per-iteration or copied values               │
│  ☐ go vet ./... passes (catches mutex copy, WaitGroup issues)         │
│  ☐ go test -race ./... passes                                         │
│                                                                       │
│  CONTEXT SAFETY                                                       │
│  ☐ context.Background() used, never nil                               │
│  ☐ Context value keys are unexported struct types                     │
│  ☐ Goroutines check ctx.Done() for cancellation                       │
│  ☐ Context is not stored in struct fields                             │
│                                                                       │
│  DEFER SAFETY                                                         │
│  ☐ No defer inside loops (use helper function)                        │
│  ☐ Defer argument vs closure capture is intentional                   │
│  ☐ recover() is directly in the deferred function                     │
│                                                                       │
│  ERROR SAFETY                                                         │
│  ☐ All errors are handled (errcheck linter)                           │
│  ☐ err variable not shadowed by := in inner scope                     │
│  ☐ Every HTTP error reply is followed by return                       │
│                                                                       │
│  INPUT SAFETY                                                         │
│  ☐ Request bodies capped (http.MaxBytesHandler / MaxBytesReader)      │
│  ☐ Server has Read/Write/Idle timeouts set, not just size limits      │
│                                                                       │
│  TOOLS                                                                │
│  ☐ go vet ./...                  (copylocks, printf, loopclosure)     │
│  ☐ go test -race ./...           (race detector: the highest-value    │
│                                   check on this entire list)          │
│  ☐ golangci-lint run             (comprehensive linting)              │
│  ☐ predeclared linter enabled    (shadowed built-ins - OFF by default)│
│  ☐ shadow analyzer enabled       (shadowed err - NOT in go vet)       │
│  ☐ goleak in unit tests          (goroutine leaks, per test)          │
│  ☐ /debug/pprof/goroutineleak    (1.27 GA, 1.26 experiment: leaks     │
│                                   in production, by reachability)     │
└───────────────────────────────────────────────────────────────────────┘
```

---
