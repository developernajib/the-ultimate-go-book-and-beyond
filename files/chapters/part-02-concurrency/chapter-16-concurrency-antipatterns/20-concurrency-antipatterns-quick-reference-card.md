## Concurrency Antipatterns Quick Reference Card

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   CONCURRENCY ANTIPATTERNS QUICK REFERENCE                       │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  QUICK DIAGNOSTIC:                                                               │
│  ┌───────────────────────┬────────────────────┬────────────────────────────┐     │
│  │ Symptom               │ Likely Cause       │ Detection Tool             │     │
│  ├───────────────────────┼────────────────────┼────────────────────────────┤     │
│  │ Memory grows forever  │ Goroutine leak     │ pprof/goroutine, goleak    │     │
│  │ Intermittent bad data │ Data race          │ go run -race               │     │
│  │ System hangs, NO CPU  │ Deadlock           │ pprof/goroutine?debug=2    │     │
│  │ System hangs, CPU 100%│ Livelock/retry storm│ CPU profile + 2 dumps     │     │
│  │ Panic on channel send │ Send on closed     │ Code review: who closes?   │     │
│  │ Slow under load       │ Lock contention    │ pprof/mutex (enable first!)│     │
│  └───────────────────────┴────────────────────┴────────────────────────────┘     │
│                                                                                  │
│  DATA RACE FIXES:                                                                │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  // BAD: Race condition                                                 │     │
│  │  var counter int                                                        │     │
│  │  go func() { counter++ }()                                              │     │
│  │  go func() { counter++ }()                                              │     │
│  │                                                                         │     │
│  │  // FIX 1: Atomic                                                       │     │
│  │  var counter atomic.Int64                                               │     │
│  │  go func() { counter.Add(1) }()                                         │     │
│  │                                                                         │     │
│  │  // FIX 2: Mutex                                                        │     │
│  │  var mu sync.Mutex                                                      │     │
│  │  go func() { mu.Lock(); counter++; mu.Unlock() }()                      │     │
│  │                                                                         │     │
│  │  // FIX 3: Channel -- ONE goroutine owns the counter; others send       │     │
│  │  //         deltas to it. Only worth it if state must be owned.         │     │
│  │  go func() { for d := range ch { counter += d } }()  // sole writer     │     │
│  │  ch <- 1                                                                │     │
│  │                                                                         │     │
│  │  NOTE: -race finds DATA races only. A check-then-act between two        │     │
│  │  correctly-locked ops has NO data race and passes -race every time.     │     │
│  │  Assert invariants in tests, not just "no race reported".               │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  DEADLOCK PREVENTION:                                                            │
│  ├── Consistent lock ordering by a STABLE id (never by pointer address)          │
│  ├── Guard the self-case (from==to): Mutex is NOT reentrant; same lock twice     │
│  │   = permanent hang, and ordering cannot save you                              │
│  ├── NEVER hold a lock across a blocking op (chan, I/O, Cond.Wait)               │
│  ├── No lock upgrade exists: RUnlock, Lock, then RE-CHECK                        │
│  ├── Recursive RLock deadlocks if a writer queues between the two                │
│  ├── Timeouts help CHANNELS, not mutexes: there is no timed mu.Lock()            │
│  └── Avoid nested locks; prefer errgroup, sync.Map, single-owner goroutines      │
│                                                                                  │
│  GOROUTINE LEAK PREVENTION:                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  // BAD: unbuffered resultCh; goroutine parks forever on timeout        │     │
│  │  resultCh := make(chan Result)                                          │     │
│  │  go func() { resultCh <- slowOperation() }()                            │     │
│  │                                                                         │     │
│  │  // TRAP: this does NOT respect cancellation                            │     │
│  │  go func() {                                                            │     │
│  │      select {                                                           │     │
│  │      case <-ctx.Done(): return                                          │     │
│  │      case resultCh <- slowOperation():  // runs FIRST, always           │     │
│  │      }                                                                  │     │
│  │  }()                                                                    │     │
│  │  // select evaluates send EXPRESSIONS before choosing a case, so        │     │
│  │  // slowOperation() completes even if ctx was cancelled long ago.       │     │
│  │                                                                         │     │
│  │  // GOOD: buffer of 1. Send can't block, so goroutine always exits.     │     │
│  │  resultCh := make(chan Result, 1)                                       │     │
│  │  go func() { resultCh <- slowOperation() }()                            │     │
│  │  select {                                                               │     │
│  │  case r := <-resultCh: return r                                         │     │
│  │  case <-ctx.Done():    return ctx.Err()                                 │     │
│  │  }                                                                      │     │
│  │                                                                         │     │
│  │  // BEST: make the work itself cancellable                              │     │
│  │  return slowOperationCtx(ctx)                                           │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  CHANNEL SAFETY RULES:                                                           │
│  ├── One owner closes; the owner is the sender. Many senders => NOBODY closes    │
│  ├── Never send on a closed channel (panics). `select`+`default` does NOT        │
│  │   help: default handles FULL, not CLOSED                                      │
│  ├── Don't close to signal senders. Use a separate `done` chan they select on    │
│  ├── Buffer result channels to the number of senders (leak fix)                  │
│  └── Check for closed channels: val, ok := <-ch  (ok is NOT optional)            │
│                                                                                  │
│  CONTEXT USAGE RULES:                                                            │
│  ├── Pass context as first parameter: func Foo(ctx context.Context, ...)         │
│  ├── Don't store context in structs (usually)                                    │
│  ├── Check ctx.Done() in long operations                                         │
│  ├── Wrap cancellation for cleanup: defer cancel()                               │
│  └── Use context.WithTimeout for network calls                                   │
│                                                                                  │
│  DEBUGGING COMMANDS:                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐     │
│  │  # Run with race detector                                               │     │
│  │  go test -race ./...                                                    │     │
│  │  go run -race main.go                                                   │     │
│  │                                                                         │     │
│  │  # Goroutine profiling                                                  │     │
│  │  curl http://localhost:6060/debug/pprof/goroutine?debug=2               │     │
│  │                                                                         │     │
│  │  # Mutex profiling -- EMPTY unless you enabled it at startup:           │     │
│  │  #   runtime.SetMutexProfileFraction(5)                                 │     │
│  │  #   runtime.SetBlockProfileRate(10000)                                 │     │
│  │  curl http://localhost:6060/debug/pprof/mutex                           │     │
│  │                                                                         │     │
│  │  # Stack dump WITHOUT killing the process (prefer this)                 │     │
│  │  curl 'http://localhost:6060/debug/pprof/goroutine?debug=2'             │     │
│  │                                                                         │     │
│  │  # Stack dump that DUMPS AND KILLS. Not a way to peek at a live service.│     │
│  │  kill -SIGQUIT <pid>                                                    │     │
│  │                                                                         │     │
│  │  # Scheduler tracing                                                    │     │
│  │  GODEBUG=schedtrace=1000 ./myapp                                        │     │
│  │                                                                         │     │
│  │  # Test for goroutine leaks                                             │     │
│  │  import "go.uber.org/goleak"                                            │     │
│  │  defer goleak.VerifyNone(t)                                             │     │
│  └─────────────────────────────────────────────────────────────────────────┘     │
│                                                                                  │
│  COMMON PATTERNS:                                                                │
│  ├── Worker pool:    Fixed goroutines consuming from job channel                 │
│  ├── Fan-out/fan-in: Multiple workers, merge results                             │
│  ├── Pipeline:       Stages connected by channels                                │
│  ├── Semaphore:      Buffered channel as counting semaphore                      │
│  ├── Heartbeat:      Periodic signals to detect stuck goroutines                 │
│  └── Done channel:   Signaling shutdown with close(done)                         │
│                                                                                  │
│  PRODUCTION CHECKLIST:                                                           │
│  □ Race detector in CI: go test -race ./...                                      │
│  □ Goroutine leak tests: goleak in test teardown                                 │
│  □ Context propagation: All blocking operations use context                      │
│  □ Timeouts everywhere: No unbounded waits in production                         │
│  □ Monitor goroutine count: prometheus gauge in /metrics                         │
│  □ Lock ordering documented: Comments on mutex fields                            │
│  □ Channel ownership clear: Who closes, who sends, who receives                  │
│                                                                                  │
│  QUICK FIXES:                                                                    │
│  ├── Race detected → Add mutex or use atomic                                     │
│  ├── Deadlock → Fix the lock ORDER. You cannot bolt a timeout onto               │
│  │   mu.Lock(); there is no timed Lock in Go                                     │
│  ├── Goroutine leak → Buffer the result channel; check ctx.Done()                │
│  ├── Panic on send-to-closed → Stop closing it. Use a done channel               │
│  └── Contention → Shard first. Lock-free only with profile evidence              │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Staff Lens: Print This Card for the Team

A literal printout of this reference card on every engineer's desk. Small, unglamorous intervention. Measurable effect: the next time an engineer is writing concurrent code, the anti-patterns are one glance away. Catch rate at review time increases because reviewers scan the card mentally before approving. This works.

---
