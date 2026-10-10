## 6. I/O Optimization

I/O is often the bottleneck. Optimize carefully.

### 6.1 Buffering Strategies

**Buffered vs Unbuffered I/O**:

```go
package main

import (
    "bufio"
    "io"
    "os"
    "testing"
)

func writeUnbuffered(filename string, lines []string) error {
    f, err := os.Create(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    for _, line := range lines {
        if _, err := f.WriteString(line + "\n"); err != nil {
            return err
        }
    }

    return nil
}

func writeBuffered(filename string, lines []string) error {
    f, err := os.Create(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    w := bufio.NewWriter(f)
    defer w.Flush()

    for _, line := range lines {
        if _, err := w.WriteString(line + "\n"); err != nil {
            return err
        }
    }

    return nil
}

func BenchmarkIO(b *testing.B) {
    lines := make([]string, 1000)
    for i := range lines {
        lines[i] = "This is a test line"
    }

    b.Run("Unbuffered", func(b *testing.B) {
        for b.Loop() {
            writeUnbuffered("/tmp/test.txt", lines)
        }
    })

    b.Run("Buffered", func(b *testing.B) {
        for b.Loop() {
            writeBuffered("/tmp/test.txt", lines)
        }
    })
}

// Results:
// BenchmarkIO/Unbuffered-8      100    12.5 ms/op
// BenchmarkIO/Buffered-8       5000     0.3 ms/op
// ~40x faster with buffering
```

**Optimal Buffer Sizes**:

```go
// Reading files
func readFileOptimal(filename string) ([]byte, error) {
    f, err := os.Open(filename)
    if err != nil {
        return nil, err
    }
    defer f.Close()

    // Get file size for optimal buffer
    stat, err := f.Stat()
    if err != nil {
        return nil, err
    }

    // Allocate exact size
    data := make([]byte, stat.Size())

    // Use buffered reader
    reader := bufio.NewReaderSize(f, 32*1024) // 32KB buffer
    _, err = io.ReadFull(reader, data)

    return data, err
}

// Streaming processing
func processLargeFile(filename string) error {
    f, err := os.Open(filename)
    if err != nil {
        return err
    }
    defer f.Close()

    // Large buffer for sequential reads
    scanner := bufio.NewScanner(f)
    scanner.Buffer(make([]byte, 1024*1024), 1024*1024) // 1MB buffer

    for scanner.Scan() {
        line := scanner.Text()
        processLine(line)
    }

    return scanner.Err()
}
```

### 6.2 Connection Pooling

**HTTP Client Pool**:

```go
package main

import (
    "net"
    "net/http"
    "time"
)

func newOptimizedHTTPClient() *http.Client {
    return &http.Client{
        Timeout: 30 * time.Second,
        Transport: &http.Transport{
            // Connection pooling
            MaxIdleConns:        100,              // Total across all hosts
            MaxIdleConnsPerHost: 10,               // Per host
            MaxConnsPerHost:     100,              // Max connections per host
            IdleConnTimeout:     90 * time.Second, // Keep-alive timeout

            // Connection establishment
            DialContext: (&net.Dialer{
                Timeout:   30 * time.Second, // Connection timeout
                KeepAlive: 30 * time.Second, // TCP keep-alive
            }).DialContext,

            // TLS performance
            TLSHandshakeTimeout:   10 * time.Second,
            ExpectContinueTimeout: 1 * time.Second,

            // Compression
            DisableCompression: false,

            // HTTP/2
            ForceAttemptHTTP2: true,
        },
    }
}

// Reuse client globally
var defaultClient = newOptimizedHTTPClient()

func makeRequest(url string) (*http.Response, error) {
    return defaultClient.Get(url)
}
```

### 6.3 Batch Operations

**Database Batch Inserts**:

```go
package main

import (
    "database/sql"
    "strings"
)

// Slow: Individual inserts
func insertRowsSlow(db *sql.DB, users []User) error {
    for _, u := range users {
        _, err := db.Exec(
            "INSERT INTO users (name, email) VALUES ($1, $2)",
            u.Name, u.Email,
        )
        if err != nil {
            return err
        }
    }
    return nil
}

// Fast: Batch insert
func insertRowsFast(db *sql.DB, users []User) error {
    if len(users) == 0 {
        return nil
    }

    // Build bulk insert query
    valueStrings := make([]string, 0, len(users))
    valueArgs := make([]any, 0, len(users)*2)

    for i, u := range users {
        valueStrings = append(valueStrings,
            fmt.Sprintf("($%d, $%d)", i*2+1, i*2+2))
        valueArgs = append(valueArgs, u.Name, u.Email)
    }

    query := fmt.Sprintf(
        "INSERT INTO users (name, email) VALUES %s",
        strings.Join(valueStrings, ","),
    )

    _, err := db.Exec(query, valueArgs...)
    return err
}

// Better: Use COPY for PostgreSQL
func insertRowsCopy(db *sql.DB, users []User) error {
    tx, err := db.Begin()
    if err != nil {
        return err
    }
    defer tx.Rollback()

    stmt, err := tx.Prepare(pq.CopyIn("users", "name", "email"))
    if err != nil {
        return err
    }
    defer stmt.Close()

    for _, u := range users {
        if _, err := stmt.Exec(u.Name, u.Email); err != nil {
            return err
        }
    }

    if _, err := stmt.Exec(); err != nil {
        return err
    }

    return tx.Commit()
}

// Benchmark results:
// Individual inserts: 1000 users in 2.5s
// Batch insert: 1000 users in 0.1s (25x faster)
// COPY: 1000 users in 0.05s (50x faster)
```

### 6.4 Async I/O Patterns

**Non-blocking I/O**:

```go
package main

import (
    "context"
    "sync"
)

type AsyncWriter struct {
    ch chan []byte
    wg sync.WaitGroup
}

func NewAsyncWriter(bufferSize int) *AsyncWriter {
    w := &AsyncWriter{
        ch: make(chan []byte, bufferSize),
    }

    w.wg.Add(1)
    go w.worker()

    return w
}

func (w *AsyncWriter) worker() {
    defer w.wg.Done()

    for data := range w.ch {
        // Actual I/O happens here
        writeToNetwork(data)
    }
}

func (w *AsyncWriter) Write(data []byte) {
    // Non-blocking write
    select {
    case w.ch <- data:
    default:
        // Buffer full - handle appropriately
        // Could block, drop, or return error
    }
}

func (w *AsyncWriter) Close() {
    close(w.ch)
    w.wg.Wait()
}

// Batching writes
type BatchWriter struct {
    batch  [][]byte
    mu     sync.Mutex
    ticker *time.Ticker
}

func NewBatchWriter() *BatchWriter {
    bw := &BatchWriter{
        batch:  make([][]byte, 0, 100),
        ticker: time.NewTicker(100 * time.Millisecond),
    }

    go bw.flush()
    return bw
}

func (bw *BatchWriter) Write(data []byte) {
    bw.mu.Lock()
    bw.batch = append(bw.batch, data)
    if len(bw.batch) >= 100 {
        bw.flushLocked()
    }
    bw.mu.Unlock()
}

func (bw *BatchWriter) flush() {
    for range bw.ticker.C {
        bw.mu.Lock()
        bw.flushLocked()
        bw.mu.Unlock()
    }
}

func (bw *BatchWriter) flushLocked() {
    if len(bw.batch) == 0 {
        return
    }

    // Write all at once
    writeBatch(bw.batch)
    bw.batch = bw.batch[:0]
}
```

---
