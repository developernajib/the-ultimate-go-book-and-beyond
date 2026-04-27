export default `## 11.1 Concurrency vs Parallelism

This distinction trips up even experienced developers, so get it right before writing any concurrent Go.

### Concurrency: Structure for Managing Complexity

Concurrency is about **structure** - designing your program to handle multiple tasks that can make progress independently. A concurrent program is organized to handle many things, but does not necessarily execute them simultaneously.

\`\`\`go
// Concurrent: handling multiple connections
// Each connection is independent, but they might all run on one CPU
func handleConnections(listener net.Listener) {
    for {
        conn, err := listener.Accept()
        if err != nil {
            log.Printf("accept error: %v", err)
            continue
        }
        go handleConnection(conn)  // Each connection handled independently
    }
}

func handleConnection(conn net.Conn) {
    defer conn.Close()

    buffer := make([]byte, 4096)
    for {
        n, err := conn.Read(buffer)
        if err != nil {
            return
        }
        // Process the data
        _, _ = conn.Write(buffer[:n])
    }
}
\`\`\`

In this example, even if the server runs on a single CPU core, it can handle thousands of connections concurrently. The connections are not processed in parallel, they are time-sliced, but the program is structured to deal with many things at once.

### Parallelism: Execution for Speed

Parallelism is about **execution** - actually running multiple tasks simultaneously on multiple CPU cores. Parallelism requires hardware support (multiple cores) and is about computational throughput.

\`\`\`go
// Parallel: processing data on multiple cores simultaneously
func processInParallel(data []int) []int {
    numCPU := runtime.NumCPU()
    chunks := splitIntoChunks(data, numCPU)
    results := make([]int, len(data))

    var wg sync.WaitGroup

    resultIndex := 0
    for _, chunk := range chunks {
        wg.Add(1)
        startIdx := resultIndex
        go func(c []int, idx int) {
            defer wg.Done()
            for i, v := range c {
                results[idx+i] = processValue(v)  // CPU-intensive work
            }
        }(chunk, startIdx)
        resultIndex += len(chunk)
    }

    wg.Wait()
    return results
}

func splitIntoChunks(data []int, n int) [][]int {
    chunks := make([][]int, 0, n)
    chunkSize := (len(data) + n - 1) / n

    for i := 0; i < len(data); i += chunkSize {
        end := i + chunkSize
        if end > len(data) {
            end = len(data)
        }
        chunks = append(chunks, data[i:end])
    }
    return chunks
}
\`\`\`

### The Key Insight: Concurrency Enables Parallelism

Rob Pike's insight is profound: **concurrency is about structure, parallelism is about execution**. A concurrent program can run on a single core (time-slicing between tasks) or multiple cores (parallel execution). Concurrency is about your program's design. Parallelism is about hardware execution.

\`\`\`
Concurrency (Single Core):
    Task A: ████░░░░████░░░░████
    Task B: ░░░░████░░░░████░░░░
    Time →  (tasks interleaved)

Parallelism (Multiple Cores):
    Core 1: ████████████████████
    Core 2: ████████████████████
    Time →  (tasks simultaneous)

Concurrent + Parallel (Multiple Cores):
    Core 1: Task A ████ Task B ████
    Core 2: Task C ████ Task D ████
    Time →  (concurrent tasks distributed)
\`\`\`

### When to Use Each

| Use Concurrency For | Use Parallelism For |
|---------------------|---------------------|
| I/O-bound operations | CPU-bound computations |
| Handling multiple connections | Data processing pipelines |
| Managing timeouts and cancellation | Scientific computing |
| Coordination between components | Image/video processing |
| Event-driven systems | Large dataset operations |

### Real-World Example: Web Server

A web server beautifully illustrates both concepts:

\`\`\`go
func main() {
    // Concurrency: handle many requests independently
    http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Each request is a separate goroutine

        // Parallelism: CPU-intensive work uses multiple cores
        result := computeExpensiveResult(r.URL.Query().Get("input"))

        w.Write([]byte(result))
    })

    log.Fatal(http.ListenAndServe(":8080", nil))
}

func computeExpensiveResult(input string) string {
    // This function might use parallelism internally
    // for CPU-bound work
    return processParallel(input)
}
\`\`\`

The server uses **concurrency** to handle many requests, and individual handlers might use **parallelism** for CPU-intensive work.

### The Amdahl's Law Constraint

Parallelism has hard limits. Amdahl's law: the speedup from parallelising is bounded by the fraction of the program that can be parallelised. A program that is 90% parallelisable runs at most 10 times faster on infinite cores. The remaining 10% sequential work dominates. In practice, most Go services are I/O-bound, and the "speedup" from adding cores is not a matter of parallel computation but a matter of handling more concurrent I/O. This is why Go's goroutine-per-request server scales to tens of thousands of concurrent connections on a four-core machine. The bottleneck is I/O latency, not CPU cycles.

### Staff Lens: Choose the Right Abstraction for the Bottleneck

The concurrency vs parallelism distinction maps directly to design decisions.

- **I/O-bound service (API server, gateway, database client).** Concurrency dominates. Goroutines per request, channels for coordination, context for cancellation. \`GOMAXPROCS\` at the default (runtime.NumCPU()) is correct. Adding cores beyond what the network interface can saturate is waste.
- **CPU-bound service (image processing, compression, cryptography).** Parallelism dominates. Worker pools sized to CPU count, careful attention to goroutine scheduling, avoidance of heap allocation in hot paths. The service benefits from every core up to the problem size.
- **Mixed workload.** The hard case. Different code paths have different profiles. A CPU-bound fan-out pattern inside an I/O-bound request handler is subtly wrong and hard to tune. Instrument both axes (CPU utilisation and goroutine counts) and size the concurrency accordingly.

### Principal Lens: Concurrency Models Beyond Goroutines

Go's goroutines are one concurrency model. The principal-level horizon includes the alternatives and when to reach for them.

- **Event loops (Node.js, Python asyncio).** Single-threaded by default. Goroutines win when the workload can tolerate multiple cores.
- **Actor models (Erlang, Akka).** Goroutines plus channels approximate actors. The absence of supervision trees and formal failure semantics is a real gap. Some teams layer their own actor framework on Go for this.
- **Data-parallel (MapReduce, Spark).** Large-scale batch processing. Go is a bad fit for this at scale. Specialised frameworks win.
- **Stream processing (Flink, Kafka Streams).** Real-time event processing. Go can do it but the ecosystem is thin compared to JVM alternatives.

Principal-level judgment: Go's concurrency model is excellent for request-response services and coordination-heavy workloads. It is not universally the best choice. The service architecture sometimes calls for a different runtime. Knowing when to recommend Go and when to recommend something else is part of the staff-and-above job.

---
`;
