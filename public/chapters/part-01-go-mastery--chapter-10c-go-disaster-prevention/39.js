export default `## 10C.38 Complete Disaster Prevention Checklist

Use this checklist during code review and self-review:

\`\`\`
┌──────────────────────────────────────────────────────────────────────┐
│              Go Disaster Prevention Checklist                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  NUMERIC SAFETY                                                      │
│  ☐ Integer arithmetic uses int64 for large values                   │
│  ☐ Financial values use int64 cents, never float                    │
│  ☐ Integer conversions have bounds checks                           │
│  ☐ Division checks b != 0 before dividing                           │
│  ☐ Float comparisons use epsilon, never ==                          │
│  ☐ Float results checked for NaN/Inf before use                     │
│                                                                       │
│  NIL SAFETY                                                          │
│  ☐ Functions returning error return nil (not typed nil)             │
│  ☐ Pointer fields checked before dereference                        │
│  ☐ Maps initialized before first write                              │
│  ☐ Nil interface != nil pointer - never conflate them               │
│                                                                       │
│  SLICE SAFETY                                                        │
│  ☐ Subslices passed to functions use [low:high:high] or copy        │
│  ☐ Index accesses are bounds-checked                                │
│  ☐ Append result is always assigned back (s = append(s, v))        │
│  ☐ for range modifies use index (s[i].field = ...) not copy         │
│                                                                       │
│  MAP SAFETY                                                          │
│  ☐ Maps accessed from multiple goroutines use sync.RWMutex          │
│  ☐ Map keys are not relied upon for ordering                        │
│                                                                       │
│  CHANNEL SAFETY                                                      │
│  ☐ Only the sender closes a channel                                 │
│  ☐ Multi-sender close uses sync.Once                                │
│  ☐ Every goroutine has an exit path (ctx.Done or close check)       │
│  ☐ time.After() uses timer.Stop() to prevent leaks                  │
│                                                                       │
│  TYPE SAFETY                                                         │
│  ☐ Type assertions use comma-ok form                                │
│  ☐ any/interface{} unmarshaling checks type before assertion        │
│  ☐ JSON integer fields use json.Number for large values             │
│                                                                       │
│  STRING SAFETY                                                       │
│  ☐ String length operations use utf8.RuneCountInString              │
│  ☐ String indexing uses range (rune) not s[i] (byte)               │
│                                                                       │
│  CONCURRENCY SAFETY                                                  │
│  ☐ sync types (Mutex, WaitGroup) are never copied after use         │
│  ☐ WaitGroup.Add() called before goroutine launch                   │
│  ☐ go vet ./... passes (catches mutex copy, WaitGroup issues)       │
│  ☐ go test -race ./... passes                                       │
│                                                                       │
│  CONTEXT SAFETY                                                      │
│  ☐ context.Background() used, never nil                             │
│  ☐ Context value keys are unexported struct types                   │
│  ☐ Goroutines check ctx.Done() for cancellation                     │
│  ☐ Context is not stored in struct fields                           │
│                                                                       │
│  DEFER SAFETY                                                        │
│  ☐ No defer inside loops (use helper function)                      │
│  ☐ Defer argument vs closure capture is intentional                 │
│  ☐ recover() is directly in the deferred function                   │
│                                                                       │
│  ERROR SAFETY                                                        │
│  ☐ All errors are handled (errcheck linter)                         │
│  ☐ err variable not shadowed by := in inner scope                   │
│                                                                       │
│  TOOLS                                                               │
│  ☐ go vet ./...                  (static analysis)                  │
│  ☐ go test -race ./...           (race detector)                    │
│  ☐ golangci-lint run             (comprehensive linting)            │
│  ☐ goleak in unit tests          (goroutine leak detection)         │
│  ☐ staticcheck ./...             (additional static checks)         │
└──────────────────────────────────────────────────────────────────────┘
\`\`\`

---
`;
