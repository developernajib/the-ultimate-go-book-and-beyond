export default `## Concurrency Antipatterns Quick Reference Card

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────────┐
│                   CONCURRENCY ANTIPATTERNS QUICK REFERENCE                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  QUICK DIAGNOSTIC:                                                              │
│  ┌───────────────────────┬────────────────────┬────────────────────────────┐   │
│  │ Symptom               │ Likely Cause       │ Detection Tool             │   │
│  ├───────────────────────┼────────────────────┼────────────────────────────┤   │
│  │ Memory grows forever  │ Goroutine leak     │ pprof/goroutine, goleak   │   │
│  │ Intermittent bad data │ Data race          │ go run -race               │   │
│  │ System hangs (no CPU) │ Deadlock           │ SIGQUIT stack dump         │   │
│  │ Panic on channel send │ Send on closed     │ Code review, recover       │   │
│  │ Slow under load       │ Lock contention    │ pprof/mutex                │   │
│  │ CPU 100%, no progress │ Live lock          │ CPU profile + code review  │   │
│  └───────────────────────┴────────────────────┴────────────────────────────┘   │
│                                                                                 │
│  DATA RACE FIXES:                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  // BAD: Race condition                                                  │   │
│  │  var counter int                                                          │   │
│  │  go func() { counter++ }()                                               │   │
│  │  go func() { counter++ }()                                               │   │
│  │                                                                           │   │
│  │  // FIX 1: Atomic                                                         │   │
│  │  var counter atomic.Int64                                                 │   │
│  │  go func() { counter.Add(1) }()                                          │   │
│  │                                                                           │   │
│  │  // FIX 2: Mutex                                                          │   │
│  │  var mu sync.Mutex                                                        │   │
│  │  go func() { mu.Lock(); counter++; mu.Unlock() }()                       │   │
│  │                                                                           │   │
│  │  // FIX 3: Channel                                                        │   │
│  │  ch := make(chan int, 1)                                                 │   │
│  │  go func() { ch <- 1 }()                                                 │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  DEADLOCK PREVENTION:                                                           │
│  ├── Consistent lock ordering (always lock A before B)                         │
│  ├── Use timeouts: select with time.After                                     │
│  ├── Use context with deadline                                                 │
│  ├── Avoid nested locks when possible                                         │
│  └── Use higher-level primitives (errgroup, sync.Map)                         │
│                                                                                 │
│  GOROUTINE LEAK PREVENTION:                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  // BAD: Goroutine leaks on timeout                                      │   │
│  │  go func() {                                                              │   │
│  │      result := slowOperation()  // Never cancelled                        │   │
│  │      resultCh <- result                                                   │   │
│  │  }()                                                                      │   │
│  │                                                                           │   │
│  │  // GOOD: Goroutine respects cancellation                                │   │
│  │  go func() {                                                              │   │
│  │      select {                                                             │   │
│  │      case <-ctx.Done():                                                   │   │
│  │          return                                                           │   │
│  │      case resultCh <- slowOperation():                                   │   │
│  │      }                                                                    │   │
│  │  }()                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  CHANNEL SAFETY RULES:                                                          │
│  ├── Only one goroutine should close a channel (use sync.Once)                │
│  ├── Never send on a closed channel (causes panic)                            │
│  ├── Use select with default for non-blocking operations                      │
│  ├── Use buffered channels to decouple producers/consumers                    │
│  └── Check for closed channels: val, ok := <-ch                              │
│                                                                                 │
│  CONTEXT USAGE RULES:                                                           │
│  ├── Pass context as first parameter: func Foo(ctx context.Context, ...)      │
│  ├── Don't store context in structs (usually)                                 │
│  ├── Check ctx.Done() in long operations                                      │
│  ├── Wrap cancellation for cleanup: defer cancel()                            │
│  └── Use context.WithTimeout for network calls                                │
│                                                                                 │
│  DEBUGGING COMMANDS:                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  # Run with race detector                                                 │   │
│  │  go test -race ./...                                                      │   │
│  │  go run -race main.go                                                     │   │
│  │                                                                           │   │
│  │  # Goroutine profiling                                                    │   │
│  │  curl http://localhost:6060/debug/pprof/goroutine?debug=2                │   │
│  │                                                                           │   │
│  │  # Mutex profiling                                                        │   │
│  │  curl http://localhost:6060/debug/pprof/mutex                            │   │
│  │                                                                           │   │
│  │  # Stack dump (send to running process)                                  │   │
│  │  kill -SIGQUIT <pid>                                                      │   │
│  │                                                                           │   │
│  │  # Scheduler tracing                                                      │   │
│  │  GODEBUG=schedtrace=1000 ./myapp                                         │   │
│  │                                                                           │   │
│  │  # Test for goroutine leaks                                              │   │
│  │  import "go.uber.org/goleak"                                             │   │
│  │  defer goleak.VerifyNone(t)                                              │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  COMMON PATTERNS:                                                               │
│  ├── Worker pool:    Fixed goroutines consuming from job channel              │
│  ├── Fan-out/fan-in: Multiple workers, merge results                          │
│  ├── Pipeline:       Stages connected by channels                             │
│  ├── Semaphore:      Buffered channel as counting semaphore                   │
│  ├── Heartbeat:      Periodic signals to detect stuck goroutines              │
│  └── Done channel:   Signaling shutdown with close(done)                      │
│                                                                                 │
│  PRODUCTION CHECKLIST:                                                          │
│  □ Race detector in CI: go test -race ./...                                   │
│  □ Goroutine leak tests: goleak in test teardown                              │
│  □ Context propagation: All blocking operations use context                   │
│  □ Timeouts everywhere: No unbounded waits in production                      │
│  □ Monitor goroutine count: prometheus gauge in /metrics                      │
│  □ Lock ordering documented: Comments on mutex fields                         │
│  □ Channel ownership clear: Who closes, who sends, who receives               │
│                                                                                 │
│  QUICK FIXES:                                                                   │
│  ├── Race detected → Add mutex or use atomic                                  │
│  ├── Deadlock → Add timeout with select + time.After                          │
│  ├── Goroutine leak → Ensure ctx.Done() is checked                           │
│  ├── Panic on close → Use sync.Once for closing                              │
│  └── Contention → Shard locks or use lock-free structures                    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Staff Lens: Print This Card for the Team

A literal printout of this reference card on every engineer's desk. Small, unglamorous intervention. Measurable effect: the next time an engineer is writing concurrent code, the anti-patterns are one glance away. Catch rate at review time increases because reviewers scan the card mentally before approving. This works.

---
`;
