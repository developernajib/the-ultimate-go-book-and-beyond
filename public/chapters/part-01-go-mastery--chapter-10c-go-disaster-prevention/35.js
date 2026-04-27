export default `## 10C.34 Using log.Fatal and log.Panic in Goroutines

\`log.Fatal\` calls \`os.Exit(1)\` after writing the log message. \`os.Exit\` terminates the **entire program immediately** - deferred functions do **not** run. This is acceptable in \`main()\` during startup, but using it in goroutines silently skips cleanup, leaves resources leaked, and makes debugging impossible because no stack trace is printed for the goroutines that were running.

### The Disaster

\`log.Fatal\` calls \`os.Exit(1)\` immediately after logging, bypassing all deferred functions. In a goroutine this means open files are not flushed, database connections are not closed, and in-progress writes may be truncated. The entire program terminates with no stack trace from the other goroutines, making post-mortem debugging extremely difficult.

\`\`\`go
package main

import (
    "fmt"
    "log"
    "os"
    "sync"
)

// WRONG: log.Fatal in a goroutine kills the entire program silently
func processJobBroken(id int, wg *sync.WaitGroup) {
    defer wg.Done()

    // This defer NEVER runs because log.Fatal calls os.Exit
    defer func() {
        fmt.Printf("cleaning up job %d\\n", id)
        // Close files, release locks, flush buffers, etc.
    }()

    if id == 3 {
        log.Fatal("job 3 encountered a critical error")
        // os.Exit(1) is called - ALL goroutines die, ALL defers are skipped
        // No cleanup, no graceful shutdown, no chance to save state
    }

    fmt.Printf("job %d completed\\n", id)
}

func main() {
    var wg sync.WaitGroup

    for i := range 5 {
        wg.Add(1)
        go processJobBroken(i, &wg) // job 3 kills the ENTIRE program
    }

    wg.Wait() // never reached - os.Exit already terminated the process
    fmt.Println("all jobs done") // never printed
}
\`\`\`

### Why It's Dangerous

- \`os.Exit\` bypasses all deferred functions in **all goroutines**, not just the current one
- Database connections, file handles, network connections are never properly closed
- Temporary files, lock files, and PID files are never cleaned up
- In-progress transactions are left in an inconsistent state
- No stack trace is printed for the other goroutines, debugging is extremely difficult
- \`log.Panic\` is slightly better (it runs defers in the current goroutine) but still crashes

### The Fix: Return Errors from Goroutines

Return errors through channels or use \`golang.org/x/sync/errgroup\` to propagate failures from goroutines back to the coordinator. This preserves deferred cleanup and gives the main goroutine control over shutdown behavior.

\`\`\`go
package main

import (
    "errors"
    "fmt"
    "log"
    "sync"
)

// CORRECT: Return errors through a channel instead of using log.Fatal
func processJob(id int, errCh chan<- error) {
    // Deferred cleanup WILL run because we're not calling os.Exit
    defer func() {
        fmt.Printf("cleaning up job %d\\n", id)
    }()

    if id == 3 {
        errCh <- fmt.Errorf("job %d: encountered a critical error", id)
        return // return instead of calling log.Fatal
    }

    fmt.Printf("job %d completed\\n", id)
    errCh <- nil
}

// CORRECT: Using errgroup (production pattern)
func processJobErrorGroup(id int) error {
    defer func() {
        fmt.Printf("cleaning up job %d\\n", id)
    }()

    if id == 3 {
        return fmt.Errorf("job %d: encountered a critical error", id)
    }

    fmt.Printf("job %d completed\\n", id)
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

    if len(errs) > 0 {
        log.Printf("completed with %d errors:", len(errs))
        for _, err := range errs {
            log.Printf("  - %v", err)
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

    // log.Fatal is acceptable ONLY in main() during startup:
    if len(errs) > 0 {
        fmt.Println("program completed with errors")
        // os.Exit(1) is acceptable here - we're in main, cleanup is done
    }

    // RULE OF THUMB:
    // log.Fatal → only in main() or init()
    // log.Panic → almost never (use explicit panic if needed)
    // Goroutines → always return errors via channels, errgroup, or callbacks

    _ = errors.Join(errs...) // Go 1.20+: combine multiple errors
}
\`\`\`

**The Rule:** Never use \`log.Fatal\` or \`log.Panic\` inside goroutines. Return errors through channels or use \`errgroup\`. Reserve \`log.Fatal\` for \`main()\` startup failures where deferred cleanup is not needed.

---
`;
