## 3. io Package: Input/Output Abstractions

### Core Interfaces

The `io` package defines the fundamental `Reader` and `Writer` interfaces. Nearly every I/O type in the standard library implements one or both. Composing these interfaces lets you build pipelines that transform data as it flows through.

```go
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}

type Closer interface {
    Close() error
}

// Common combinations
type ReadWriter interface {
    Reader
    Writer
}

type ReadCloser interface {
    Reader
    Closer
}

type WriteCloser interface {
    Writer
    Closer
}

type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}
```

### io.Copy and Variants

```go
package main

import (
    "bytes"
    "crypto/md5"
    "fmt"
    "io"
    "os"
    "strings"
)

func ioCopyExamples() {
    // Basic io.Copy
    src := strings.NewReader("Hello, World!")
    var dst bytes.Buffer

    n, err := io.Copy(&dst, src)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Copied %d bytes: %s\n", n, dst.String())

    // io.CopyN - copy exactly N bytes
    src = strings.NewReader("Hello, World!")
    dst.Reset()
    io.CopyN(&dst, src, 5) // Copy only 5 bytes
    fmt.Printf("Copied 5 bytes: %s\n", dst.String()) // "Hello"

    // io.CopyBuffer - use specific buffer
    src = strings.NewReader("Hello, World!")
    dst.Reset()
    buf := make([]byte, 2) // Small buffer for demonstration
    io.CopyBuffer(&dst, src, buf)
    fmt.Printf("Copied with custom buffer: %s\n", dst.String())
}

// Copying a file efficiently
func copyFile(src, dst string) error {
    source, err := os.Open(src)
    if err != nil {
        return err
    }
    defer source.Close()

    destination, err := os.Create(dst)
    if err != nil {
        return err
    }
    defer destination.Close()

    _, err = io.Copy(destination, source)
    return err
}

// Computing hash while copying
func copyAndHash(dst io.Writer, src io.Reader) (string, error) {
    hash := md5.New()
    writer := io.MultiWriter(dst, hash) // Write to both dst and hash

    _, err := io.Copy(writer, src)
    if err != nil {
        return "", err
    }

    return fmt.Sprintf("%x", hash.Sum(nil)), nil
}
```

### io.Pipe for Streaming

```go
package main

import (
    "compress/gzip"
    "encoding/json"
    "io"
    "os"
)

type LogEntry struct {
    Timestamp string `json:"timestamp"`
    Level     string `json:"level"`
    Message   string `json:"message"`
}

// Stream JSON encoding directly to gzip compression
func streamJSONToGzip(entries []LogEntry, output string) error {
    file, err := os.Create(output)
    if err != nil {
        return err
    }
    defer file.Close()

    // Create pipe
    pr, pw := io.Pipe()

    // Goroutine 1: JSON encode to pipe
    go func() {
        encoder := json.NewEncoder(pw)
        for _, entry := range entries {
            if err := encoder.Encode(entry); err != nil {
                pw.CloseWithError(err)
                return
            }
        }
        pw.Close()
    }()

    // Goroutine 2: Read from pipe, gzip, write to file
    gzipWriter := gzip.NewWriter(file)
    defer gzipWriter.Close()

    _, err = io.Copy(gzipWriter, pr)
    return err
}

// Real-world pattern: HTTP response streaming
func streamHTTPResponse(url string, processChunk func([]byte) error) error {
    // resp, err := http.Get(url) // Simplified
    // if err != nil {
    //     return err
    // }
    // defer resp.Body.Close()

    // Process in chunks without loading entire response
    // buf := make([]byte, 32*1024) // 32KB chunks
    // for {
    //     n, err := resp.Body.Read(buf)
    //     if n > 0 {
    //         if err := processChunk(buf[:n]); err != nil {
    //             return err
    //         }
    //     }
    //     if err == io.EOF {
    //         break
    //     }
    //     if err != nil {
    //         return err
    //     }
    // }
    return nil
}
```

### io.TeeReader

```go
package main

import (
    "bytes"
    "fmt"
    "io"
    "strings"
)

func teeReaderExample() {
    // Read from source while writing to another destination
    src := strings.NewReader("Hello, World!")
    var logged bytes.Buffer

    // Create TeeReader: reads from src, writes to logged
    tee := io.TeeReader(src, &logged)

    // Read from tee (also writes to logged)
    data, _ := io.ReadAll(tee)

    fmt.Printf("Read: %s\n", data)
    fmt.Printf("Also logged: %s\n", logged.String())
}

// Practical use: Log HTTP request bodies
type LoggingReader struct {
    src io.Reader
    log io.Writer
}

func NewLoggingReader(src io.Reader, log io.Writer) io.Reader {
    return io.TeeReader(src, log)
}
```

### io.MultiReader and io.MultiWriter

```go
package main

import (
    "bytes"
    "fmt"
    "io"
    "strings"
)

func multiReaderExample() {
    // Combine multiple readers into one
    r1 := strings.NewReader("Hello, ")
    r2 := strings.NewReader("World")
    r3 := strings.NewReader("!")

    multi := io.MultiReader(r1, r2, r3)
    data, _ := io.ReadAll(multi)
    fmt.Println(string(data)) // "Hello, World!"
}

func multiWriterExample() {
    // Write to multiple destinations simultaneously
    var buf1, buf2, buf3 bytes.Buffer

    multi := io.MultiWriter(&buf1, &buf2, &buf3)
    multi.Write([]byte("Hello, World!"))

    fmt.Println("Buffer 1:", buf1.String())
    fmt.Println("Buffer 2:", buf2.String())
    fmt.Println("Buffer 3:", buf3.String())
}

// Practical use: Write logs to multiple outputs
func setupLogging() io.Writer {
    // logFile, _ := os.OpenFile("app.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
    // return io.MultiWriter(os.Stdout, logFile)
    return io.MultiWriter(os.Stdout) // Simplified for example
}
```

### io.LimitReader

```go
package main

import (
    "fmt"
    "io"
    "strings"
)

func limitReaderExample() {
    // Prevent reading more than N bytes (security/memory protection)
    src := strings.NewReader("This is a very long string that we want to limit")

    // Only allow reading 10 bytes
    limited := io.LimitReader(src, 10)
    data, _ := io.ReadAll(limited)

    fmt.Printf("Read only: %s\n", data) // "This is a "
}

// Practical use: Limit HTTP request body size
const MaxRequestBodySize = 1 << 20 // 1MB

func readRequestBody(body io.Reader) ([]byte, error) {
    limited := io.LimitReader(body, MaxRequestBodySize)
    return io.ReadAll(limited)
}
```

### Custom Reader/Writer

```go
package main

import (
    "fmt"
    "io"
    "strings"
)

// ROT13 reader - transforms data while reading
type rot13Reader struct {
    r io.Reader
}

func (r *rot13Reader) Read(p []byte) (n int, err error) {
    n, err = r.r.Read(p)
    for i := 0; i < n; i++ {
        p[i] = rot13(p[i])
    }
    return
}

func rot13(b byte) byte {
    switch {
    case b >= 'A' && b <= 'Z':
        return 'A' + (b-'A'+13)%26
    case b >= 'a' && b <= 'z':
        return 'a' + (b-'a'+13)%26
    default:
        return b
    }
}

// Counter writer - counts bytes written
type CountWriter struct {
    Writer io.Writer
    Count  int64
}

func (cw *CountWriter) Write(p []byte) (n int, err error) {
    n, err = cw.Writer.Write(p)
    cw.Count += int64(n)
    return
}

func customIOExample() {
    // ROT13 reader
    r := &rot13Reader{r: strings.NewReader("Uryyb, Jbeyq!")}
    data, _ := io.ReadAll(r)
    fmt.Println(string(data)) // "Hello, World!"

    // Counter writer
    var buf strings.Builder
    cw := &CountWriter{Writer: &buf}
    cw.Write([]byte("Hello"))
    cw.Write([]byte(", "))
    cw.Write([]byte("World!"))
    fmt.Printf("Wrote %d bytes: %s\n", cw.Count, buf.String())
}
```

---
