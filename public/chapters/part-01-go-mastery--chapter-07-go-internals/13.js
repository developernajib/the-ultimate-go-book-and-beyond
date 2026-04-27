export default `## 7.12 Exercises with Solutions

### Exercise 1: AST Exploration

**Problem**: Write a program that parses a Go file and prints all function declarations with their parameters.

**Solution**: This program uses \`go/parser\` to build an AST and \`ast.Inspect\` to walk it, extracting function names, parameter types, and return types. The \`formatType\` helper recursively handles nested types like \`*[]map[K]V\`.

\`\`\`go
package main

import (
    "fmt"
    "go/ast"
    "go/parser"
    "go/token"
    "os"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: go run main.go <file.go>")
        return
    }

    fset := token.NewFileSet()
    node, err := parser.ParseFile(fset, os.Args[1], nil, parser.ParseComments)
    if err != nil {
        fmt.Printf("Parse error: %v\\n", err)
        return
    }

    ast.Inspect(node, func(n ast.Node) bool {
        fn, ok := n.(*ast.FuncDecl)
        if !ok {
            return true
        }

        // Print function name
        fmt.Printf("func %s(", fn.Name.Name)

        // Print parameters
        if fn.Type.Params != nil {
            params := []string{}
            for _, field := range fn.Type.Params.List {
                typeStr := formatType(field.Type)
                for _, name := range field.Names {
                    params = append(params, fmt.Sprintf("%s %s", name.Name, typeStr))
                }
                if len(field.Names) == 0 {
                    params = append(params, typeStr)
                }
            }
            for i, p := range params {
                if i > 0 {
                    fmt.Print(", ")
                }
                fmt.Print(p)
            }
        }
        fmt.Print(")")

        // Print return types
        if fn.Type.Results != nil && len(fn.Type.Results.List) > 0 {
            fmt.Print(" ")
            if len(fn.Type.Results.List) > 1 {
                fmt.Print("(")
            }
            for i, field := range fn.Type.Results.List {
                if i > 0 {
                    fmt.Print(", ")
                }
                fmt.Print(formatType(field.Type))
            }
            if len(fn.Type.Results.List) > 1 {
                fmt.Print(")")
            }
        }
        fmt.Println()

        return true
    })
}

func formatType(expr ast.Expr) string {
    switch t := expr.(type) {
    case *ast.Ident:
        return t.Name
    case *ast.StarExpr:
        return "*" + formatType(t.X)
    case *ast.ArrayType:
        return "[]" + formatType(t.Elt)
    case *ast.SelectorExpr:
        return formatType(t.X) + "." + t.Sel.Name
    case *ast.MapType:
        return fmt.Sprintf("map[%s]%s", formatType(t.Key), formatType(t.Value))
    case *ast.InterfaceType:
        return "interface{}"
    case *ast.FuncType:
        return "func(...)"
    default:
        return fmt.Sprintf("%T", expr)
    }
}
\`\`\`

### Exercise 2: GC Analysis

**Problem**: Write a program that allocates significant memory and observe GC behavior.

**Solution**: This program allocates memory in 100MB waves, then releases half and forces a GC cycle. By reading \`runtime.MemStats\` before and after each operation, you can see exactly how the GC responds to allocation pressure and how pause times scale with heap size.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "runtime/debug"
    "time"
)

func main() {
    // Print GC settings
    gogc := debug.SetGCPercent(-1)
    debug.SetGCPercent(gogc)
    fmt.Printf("GOGC: %d\\n", gogc)

    // Baseline
    var m runtime.MemStats
    runtime.ReadMemStats(&m)
    fmt.Printf("Initial: HeapAlloc=%dMB, NumGC=%d\\n",
        m.HeapAlloc/1024/1024, m.NumGC)

    // Allocate memory in waves
    var data [][]byte

    for wave := 1; wave <= 5; wave++ {
        fmt.Printf("\\n=== Wave %d ===\\n", wave)

        // Allocate 100MB
        for i := 0; i < 100; i++ {
            data = append(data, make([]byte, 1024*1024)) // 1MB each
        }

        runtime.ReadMemStats(&m)
        fmt.Printf("After alloc: HeapAlloc=%dMB, NumGC=%d, LastPause=%v\\n",
            m.HeapAlloc/1024/1024, m.NumGC,
            time.Duration(m.PauseNs[(m.NumGC+255)%256]))

        // Release half
        data = data[:len(data)/2]
        runtime.GC()

        runtime.ReadMemStats(&m)
        fmt.Printf("After GC: HeapAlloc=%dMB, NumGC=%d, LastPause=%v\\n",
            m.HeapAlloc/1024/1024, m.NumGC,
            time.Duration(m.PauseNs[(m.NumGC+255)%256]))
    }

    // Print GC summary
    fmt.Printf("\\n=== Summary ===\\n")
    runtime.ReadMemStats(&m)
    fmt.Printf("Total GC cycles: %d\\n", m.NumGC)
    fmt.Printf("Total GC pause: %v\\n", time.Duration(m.PauseTotalNs))
    fmt.Printf("GC CPU fraction: %.2f%%\\n", m.GCCPUFraction*100)

    _ = data // Keep alive
}
\`\`\`

### Exercise 3: Scheduler Observation

**Problem**: Create a program with many goroutines and analyze scheduling.

**Solution**: This program spawns 1000 goroutines performing CPU-bound work with periodic yields via \`runtime.Gosched()\`. Run it with \`GODEBUG=schedtrace=100\` to observe how the scheduler distributes goroutines across Ps and how the global/local run queue depths change over time.

\`\`\`go
package main

import (
    "fmt"
    "runtime"
    "sync"
    "sync/atomic"
    "time"
)

func main() {
    runtime.GOMAXPROCS(4)

    fmt.Println("Run with: GODEBUG=schedtrace=100 go run main.go")
    fmt.Printf("GOMAXPROCS: %d\\n", runtime.GOMAXPROCS(0))

    var (
        totalOps   int64
        goroutines = 1000
        duration   = 2 * time.Second
    )

    var wg sync.WaitGroup
    stop := make(chan struct{})

    // Start goroutines
    for i := 0; i < goroutines; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            ops := int64(0)

            for {
                select {
                case <-stop:
                    atomic.AddInt64(&totalOps, ops)
                    return
                default:
                    // Mix of CPU and yield
                    sum := 0
                    for j := 0; j < 1000; j++ {
                        sum += j
                    }
                    _ = sum
                    ops++

                    // Occasionally yield
                    if ops%100 == 0 {
                        runtime.Gosched()
                    }
                }
            }
        }(i)
    }

    // Monitor goroutine count
    go func() {
        ticker := time.NewTicker(200 * time.Millisecond)
        defer ticker.Stop()
        for {
            select {
            case <-stop:
                return
            case <-ticker.C:
                fmt.Printf("Goroutines: %d\\n", runtime.NumGoroutine())
            }
        }
    }()

    // Run for duration
    time.Sleep(duration)
    close(stop)
    wg.Wait()

    fmt.Printf("\\nTotal operations: %d\\n", totalOps)
    fmt.Printf("Ops per goroutine: %d\\n", totalOps/int64(goroutines))
    fmt.Printf("Ops per second: %d\\n", totalOps/int64(duration.Seconds()))
}
\`\`\`

### Exercise 4: Escape Analysis Verification

**Problem**: Write functions with different escape behaviors and verify with compiler flags.

**Solution**: Each function below triggers a different escape analysis outcome. Compile with \`go build -gcflags="-m -m"\` to see the compiler's reasoning for each decision. The \`//go:noinline\` directive prevents inlining, which would otherwise mask escape behavior by folding the function body into the caller.

\`\`\`go
// escape_analysis.go
package main

import "fmt"

// Case 1: No escape (stack allocated)
//go:noinline
func stackOnly() int {
    x := 42
    return x
}

// Case 2: Escapes via return
//go:noinline
func escapesViaReturn() *int {
    x := 42
    return &x // x escapes
}

// Case 3: Escapes via interface
//go:noinline
func escapesViaInterface() {
    x := 42
    fmt.Println(x) // x escapes to any
}

// Case 4: Escapes via closure
//go:noinline
func escapesViaClosure() func() int {
    x := 42
    return func() int {
        return x // x escapes (captured by closure)
    }
}

// Case 5: No escape with slice
//go:noinline
func noEscapeSlice() int {
    s := make([]int, 10) // stays on stack
    s[0] = 42
    return s[0]
}

// Case 6: Escapes via slice append
//go:noinline
func escapesViaAppend() []int {
    s := make([]int, 0, 10)
    s = append(s, 1, 2, 3)
    return s // s escapes
}

// Case 7: No escape with known size
//go:noinline
func noEscapeArray() [3]int {
    arr := [3]int{1, 2, 3} // stack allocated
    return arr             // value copy, no escape
}

func main() {
    // Run: go build -gcflags="-m -m" escape_analysis.go
    fmt.Println("Build with -gcflags=\\"-m -m\\" to see escape analysis")

    _ = stackOnly()
    _ = escapesViaReturn()
    escapesViaInterface()
    _ = escapesViaClosure()
    _ = noEscapeSlice()
    _ = escapesViaAppend()
    _ = noEscapeArray()
}

// Expected output from -gcflags="-m -m":
// ./escape_analysis.go:10:2: x does not escape
// ./escape_analysis.go:16:2: moved to heap: x
// ./escape_analysis.go:22:13: x escapes to heap
// ./escape_analysis.go:28:2: moved to heap: x
// ./escape_analysis.go:35:11: make([]int, 10) does not escape
// ./escape_analysis.go:42:11: make([]int, 0, 10) escapes to heap
// ./escape_analysis.go:49:6: arr does not escape
\`\`\`

### Exercise 5: Trace Analysis

**Problem**: Create a program with concurrent work and analyze with \`go tool trace\`.

**Solution**: This program generates a trace file containing four distinct concurrency patterns: CPU-bound computation, simulated I/O, channel producer-consumer communication, and mutex contention. Opening \`trace.out\` with \`go tool trace\` shows goroutine scheduling, blocking events, and GC activity on an interactive timeline.

\`\`\`go
// trace_demo.go
package main

import (
    "context"
    "fmt"
    "os"
    "runtime/trace"
    "sync"
    "time"
)

func main() {
    // Create trace file
    f, err := os.Create("trace.out")
    if err != nil {
        panic(err)
    }
    defer f.Close()

    // Start tracing
    if err := trace.Start(f); err != nil {
        panic(err)
    }
    defer trace.Stop()

    fmt.Println("Recording trace to trace.out")
    fmt.Println("Analyze with: go tool trace trace.out")

    // Create context with task
    ctx, task := trace.NewTask(context.Background(), "main-work")
    defer task.End()

    // Simulate various work patterns
    var wg sync.WaitGroup

    // CPU-bound work
    trace.WithRegion(ctx, "cpu-work", func() {
        for i := 0; i < 4; i++ {
            wg.Add(1)
            go func(id int) {
                defer wg.Done()
                ctx, task := trace.NewTask(ctx, fmt.Sprintf("cpu-worker-%d", id))
                defer task.End()

                trace.WithRegion(ctx, "compute", func() {
                    sum := 0
                    for j := 0; j < 10000000; j++ {
                        sum += j
                    }
                    _ = sum
                })

                trace.Log(ctx, "result", "completed")
            }(i)
        }
    })

    // IO-bound work (simulated with sleep)
    trace.WithRegion(ctx, "io-work", func() {
        for i := 0; i < 4; i++ {
            wg.Add(1)
            go func(id int) {
                defer wg.Done()
                ctx, task := trace.NewTask(ctx, fmt.Sprintf("io-worker-%d", id))
                defer task.End()

                trace.WithRegion(ctx, "io-wait", func() {
                    time.Sleep(100 * time.Millisecond)
                })

                trace.Log(ctx, "result", "io completed")
            }(i)
        }
    })

    // Channel communication
    ch := make(chan int, 10)

    trace.WithRegion(ctx, "channel-work", func() {
        wg.Add(2)

        // Producer
        go func() {
            defer wg.Done()
            ctx, task := trace.NewTask(ctx, "producer")
            defer task.End()

            trace.WithRegion(ctx, "produce", func() {
                for i := 0; i < 100; i++ {
                    ch <- i
                }
                close(ch)
            })
        }()

        // Consumer
        go func() {
            defer wg.Done()
            ctx, task := trace.NewTask(ctx, "consumer")
            defer task.End()

            trace.WithRegion(ctx, "consume", func() {
                sum := 0
                for v := range ch {
                    sum += v
                }
                trace.Log(ctx, "sum", fmt.Sprintf("%d", sum))
            })
        }()
    })

    // Mutex contention
    var mu sync.Mutex
    trace.WithRegion(ctx, "mutex-work", func() {
        for i := 0; i < 10; i++ {
            wg.Add(1)
            go func(id int) {
                defer wg.Done()

                for j := 0; j < 100; j++ {
                    mu.Lock()
                    time.Sleep(time.Microsecond)
                    mu.Unlock()
                }
            }(i)
        }
    })

    wg.Wait()
    fmt.Println("Trace recording complete")
}
\`\`\`

### Senior at FAANG Track

6. **Incident reproduction exercise.** Build a deliberately-leaky service (unbounded goroutine spawn, unbounded map growth, GC-thrashing allocation pattern). Use \`go tool trace\` to diagnose each failure mode. Write a 300-word diagnosis for each. The deliverables are the writeups.

7. **GOMEMLIMIT tuning.** Pick a service. Measure GC CPU percentage, RSS, and p99 latency at three \`GOMEMLIMIT\` values (80%, 90%, 100% of container limit). Document the trade-off curve.

8. **Scheduler-trace workshop.** Run a canned workload with \`GODEBUG=schedtrace=1000\`. Annotate the output line-by-line for the team. The annotation is the teaching artifact.

9. **Runtime-pathology catalog.** Write the team's catalog of runtime-related incidents. Each entry: symptom, diagnosis path, fix, prevention. Seed with three past incidents.

10. **Team diagnostic playbook.** Write the team's on-call runbook for Go-runtime-related incidents. Cover: GC pressure, goroutine leak, scheduler gap, memory bloat. Include the specific tools and commands for each.

---
`;
