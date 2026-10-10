## 10C.34 Using log.Fatal and log.Panic in Goroutines

`log.Fatal` calls `os.Exit(1)` after writing the log message. `os.Exit` terminates the **entire program immediately**, and deferred functions do **not** run. Not in the calling goroutine, and not in any other. This is tolerable in `main()` at startup, where there is nothing to clean up yet. Anywhere else it skips cleanup, leaks resources, and prints no stack trace for the goroutines that were mid-flight.

### The Disaster

`log.Fatal` calls `os.Exit(1)` immediately after logging, bypassing all deferred functions. In a goroutine this means open files are not flushed, database connections are not closed, and in-progress writes may be truncated. The entire program terminates with no stack trace from the other goroutines, making post-mortem debugging extremely difficult.

```go
package main

import (
    "fmt"
    "log"
    "sync"
)

// WRONG: log.Fatal in a goroutine kills the entire program silently
func processJobBroken(id int, wg *sync.WaitGroup) {
    defer wg.Done()

    // This defer NEVER runs because log.Fatal calls os.Exit
    defer func() {
        fmt.Printf("cleaning up job %d\n", id)
        // Close files, release locks, flush buffers, etc.
    }()

    if id == 3 {
        log.Fatal("job 3 encountered a critical error")
        // os.Exit(1) runs. Every goroutine dies where it stands and every
        // defer is skipped, including wg.Done() and the cleanup above.
        // One job's failure ends the other four mid-write.
    }

    fmt.Printf("job %d completed\n", id)
}

func main() {
    var wg sync.WaitGroup

    for i := range 5 {
        wg.Add(1)
        go processJobBroken(i, &wg) // job 3 ends the process
    }

    wg.Wait()                    // reached, but never returns
    fmt.Println("all jobs done") // never printed
}
```

### Why It's Dangerous

- `os.Exit` bypasses all deferred functions in **all goroutines**, not just the current one
- Database connections, file handles, network connections are never properly closed
- Temporary files, lock files, and PID files are never cleaned up
- In-progress transactions are left in an inconsistent state
- No stack trace is printed for any goroutine. You get one log line and an exit code, from a process that was running fifty things.
- `log.Panic` behaves differently but is not the fix. It panics, so defers in *its own* goroutine do run, and then the unrecovered panic kills the process anyway, skipping every other goroutine's defers exactly like `log.Fatal`. It buys one goroutine's cleanup and at least prints a stack trace.
- The same trap applies to `log.Fatal` in `main()` itself once `main` has defers. `defer db.Close()` followed by `log.Fatal(err)` on the next error path does not close the database, because `os.Exit` does not run defers. If `main` has cleanup, it needs to return, and the exit code belongs in a thin wrapper.

### The Fix: Return Errors from Goroutines

Return errors through channels or use `golang.org/x/sync/errgroup` to propagate failures from goroutines back to the coordinator. This preserves deferred cleanup and gives the main goroutine control over shutdown behavior.

```go
package main

import (
    "errors"
    "fmt"
    "log"
)

// CORRECT: Return errors through a channel instead of using log.Fatal
func processJob(id int, errCh chan<- error) {
    // Deferred cleanup WILL run because we're not calling os.Exit
    defer func() {
        fmt.Printf("cleaning up job %d\n", id)
    }()

    if id == 3 {
        errCh <- fmt.Errorf("job %d: encountered a critical error", id)
        return // return instead of calling log.Fatal
    }

    fmt.Printf("job %d completed\n", id)
    errCh <- nil
}

// CORRECT: Using errgroup (production pattern)
func processJobErrorGroup(id int) error {
    defer func() {
        fmt.Printf("cleaning up job %d\n", id)
    }()

    if id == 3 {
        return fmt.Errorf("job %d: encountered a critical error", id)
    }

    fmt.Printf("job %d completed\n", id)
    return nil
}

func main() {
    // Pattern 1: Error channel
    const numJobs = 5
    errCh := make(chan error, numJobs)

    for i := range numJobs {
        go processJob(i, errCh)
    }

    // Collect errors from all goroutines
    var errs []error
    for range numJobs {
        if err := <-errCh; err != nil {
            errs = append(errs, err)
        }
    }

    // Note what this buys: every job ran its cleanup, every job reported,
    // and main decides what a failure means. One bad job no longer gets to
    // make that decision for the other four.
    if len(errs) > 0 {
        log.Printf("completed with %d errors:", len(errs))
        for _, err := range errs {
            log.Printf("  %v", err)
        }
    }

    // Pattern 2: errgroup (recommended for production)
    // import "golang.org/x/sync/errgroup"
    //
    // g, ctx := errgroup.WithContext(context.Background())
    // for i := range numJobs {
    //     g.Go(func() error {
    //         return processJobErrorGroup(i)
    //     })
    // }
    // if err := g.Wait(); err != nil {
    //     log.Printf("one or more jobs failed: %v", err)
    // }

    // Exiting nonzero is fine HERE, in main, after everything has been
    // cleaned up and reported. That is the only property that ever made
    // log.Fatal acceptable: not that it is main, but that nothing is left
    // to run.
    if len(errs) > 0 {
        fmt.Println("program completed with errors")
        // os.Exit(1)
    }

    // RULE OF THUMB:
    // log.Fatal → main() and init() only, and only where no defer is pending
    // log.Panic → almost never, and never as a substitute for returning an error
    // goroutines → always return errors, via channels, errgroup, or callbacks

    _ = errors.Join(errs...) // Go 1.20+: combine several errors into one
}
```

**The Rule:** Never use `log.Fatal` or `log.Panic` inside goroutines. Return errors through channels or use `errgroup`. Reserve `log.Fatal` for `main()` startup failures where deferred cleanup is not needed.

---
