## Part 1: RESP Protocol Implementation

### RESP Protocol Basics

Redis uses RESP (REdis Serialization Protocol) - a simple text-based protocol:

```
Type          First Byte    Example
Simple String    +          +OK\r\n
Error            -          -ERR unknown command\r\n
Integer          :          :1000\r\n
Bulk String      $          $5\r\nhello\r\n
Array            *          *2\r\n$3\r\nGET\r\n$3\r\nkey\r\n
```

### RESP Parser

The RESP parser is the first thing you need to build because it handles all communication between clients and the server. The parser reads raw bytes from a TCP connection and converts them into structured `Value` objects that the rest of the application can work with. Each RESP message starts with a single byte that identifies its type (for example, `+` for simple strings or `*` for arrays), followed by the data and a `\r\n` terminator. The parser uses a buffered reader for efficiency, reading one message at a time from the stream.

```go
// internal/protocol/resp.go
package protocol

import (
    "bufio"
    "bytes"
    "errors"
    "fmt"
    "io"
    "strconv"
)

var (
    ErrInvalidProtocol = errors.New("invalid RESP protocol")
    ErrInvalidLength   = errors.New("invalid length")
)

type RESPType byte

const (
    SimpleString RESPType = '+'
    Error        RESPType = '-'
    Integer      RESPType = ':'
    BulkString   RESPType = '$'
    Array        RESPType = '*'
)

type Value struct {
    Type  RESPType
    Str   string
    Num   int64
    Bulk  []byte
    Array []Value
}

type Reader struct {
    reader *bufio.Reader
}

func NewReader(r io.Reader) *Reader {
    return &Reader{
        reader: bufio.NewReader(r),
    }
}

func (r *Reader) ReadValue() (*Value, error) {
    typ, err := r.reader.ReadByte()
    if err != nil {
        return nil, err
    }

    switch RESPType(typ) {
    case SimpleString:
        return r.readSimpleString()
    case Error:
        return r.readError()
    case Integer:
        return r.readInteger()
    case BulkString:
        return r.readBulkString()
    case Array:
        return r.readArray()
    default:
        return nil, fmt.Errorf("%w: unknown type %c", ErrInvalidProtocol, typ)
    }
}

func (r *Reader) readSimpleString() (*Value, error) {
    line, err := r.readLine()
    if err != nil {
        return nil, err
    }
    return &Value{Type: SimpleString, Str: string(line)}, nil
}

func (r *Reader) readError() (*Value, error) {
    line, err := r.readLine()
    if err != nil {
        return nil, err
    }
    return &Value{Type: Error, Str: string(line)}, nil
}

func (r *Reader) readInteger() (*Value, error) {
    line, err := r.readLine()
    if err != nil {
        return nil, err
    }
    num, err := strconv.ParseInt(string(line), 10, 64)
    if err != nil {
        return nil, err
    }
    return &Value{Type: Integer, Num: num}, nil
}

func (r *Reader) readBulkString() (*Value, error) {
    line, err := r.readLine()
    if err != nil {
        return nil, err
    }

    length, err := strconv.Atoi(string(line))
    if err != nil {
        return nil, err
    }

    // Null bulk string
    if length == -1 {
        return &Value{Type: BulkString, Bulk: nil}, nil
    }

    if length < 0 {
        return nil, ErrInvalidLength
    }

    bulk := make([]byte, length+2) // +2 for \r\n
    _, err = io.ReadFull(r.reader, bulk)
    if err != nil {
        return nil, err
    }

    return &Value{Type: BulkString, Bulk: bulk[:length]}, nil
}

func (r *Reader) readArray() (*Value, error) {
    line, err := r.readLine()
    if err != nil {
        return nil, err
    }

    length, err := strconv.Atoi(string(line))
    if err != nil {
        return nil, err
    }

    // Null array
    if length == -1 {
        return &Value{Type: Array, Array: nil}, nil
    }

    if length < 0 {
        return nil, ErrInvalidLength
    }

    array := make([]Value, length)
    for i := 0; i < length; i++ {
        val, err := r.ReadValue()
        if err != nil {
            return nil, err
        }
        array[i] = *val
    }

    return &Value{Type: Array, Array: array}, nil
}

func (r *Reader) readLine() ([]byte, error) {
    line, err := r.reader.ReadBytes('\n')
    if err != nil {
        return nil, err
    }
    if len(line) < 2 || line[len(line)-2] != '\r' {
        return nil, ErrInvalidProtocol
    }
    return line[:len(line)-2], nil
}
```

### RESP Writer

The RESP writer is the counterpart to the parser -- it takes structured Go values and serializes them back into the RESP wire format for sending over the network. Every response the server sends to a client goes through this writer, whether it is a simple "OK" acknowledgment or a large array of results. The writer uses a buffered writer internally and calls `Flush()` after each message to ensure the data is actually sent to the client without unnecessary delay.

```go
// internal/protocol/writer.go
package protocol

import (
    "bufio"
    "fmt"
    "io"
    "strconv"
)

type Writer struct {
    writer *bufio.Writer
}

func NewWriter(w io.Writer) *Writer {
    return &Writer{
        writer: bufio.NewWriter(w),
    }
}

func (w *Writer) WriteValue(v *Value) error {
    switch v.Type {
    case SimpleString:
        return w.WriteSimpleString(v.Str)
    case Error:
        return w.WriteError(v.Str)
    case Integer:
        return w.WriteInteger(v.Num)
    case BulkString:
        return w.WriteBulkString(v.Bulk)
    case Array:
        return w.WriteArray(v.Array)
    default:
        return fmt.Errorf("unknown value type: %c", v.Type)
    }
}

func (w *Writer) WriteSimpleString(s string) error {
    w.writer.WriteByte(byte(SimpleString))
    w.writer.WriteString(s)
    w.writer.WriteString("\r\n")
    return w.writer.Flush()
}

func (w *Writer) WriteError(s string) error {
    w.writer.WriteByte(byte(Error))
    w.writer.WriteString(s)
    w.writer.WriteString("\r\n")
    return w.writer.Flush()
}

func (w *Writer) WriteInteger(n int64) error {
    w.writer.WriteByte(byte(Integer))
    w.writer.WriteString(strconv.FormatInt(n, 10))
    w.writer.WriteString("\r\n")
    return w.writer.Flush()
}

func (w *Writer) WriteBulkString(b []byte) error {
    if b == nil {
        w.writer.WriteString("$-1\r\n")
        return w.writer.Flush()
    }

    w.writer.WriteByte(byte(BulkString))
    w.writer.WriteString(strconv.Itoa(len(b)))
    w.writer.WriteString("\r\n")
    w.writer.Write(b)
    w.writer.WriteString("\r\n")
    return w.writer.Flush()
}

func (w *Writer) WriteArray(arr []Value) error {
    if arr == nil {
        w.writer.WriteString("*-1\r\n")
        return w.writer.Flush()
    }

    w.writer.WriteByte(byte(Array))
    w.writer.WriteString(strconv.Itoa(len(arr)))
    w.writer.WriteString("\r\n")

    for _, v := range arr {
        if err := w.WriteValue(&v); err != nil {
            return err
        }
    }

    return nil
}

func (w *Writer) WriteOK() error {
    return w.WriteSimpleString("OK")
}

func (w *Writer) WriteNull() error {
    return w.WriteBulkString(nil)
}
```

---

### Junior → FAANG: Protocol Parsing as a Go I/O Exercise

The RESP parser is a great exercise in Go's `bufio` package. You read from a buffered reader, parse type prefixes (`+`, `-`, `:`, `$`, `*`), and recursively decode arrays. The key skill is handling partial reads: the network may deliver data in chunks, so your parser must handle the case where a single message spans multiple read calls.

Error handling in the parser is the most common source of bugs. Every `Read` call can return an error. Every `Write` call can return an error. In a protocol implementation, these errors must surface to the caller as connection errors, not silently swallowed. Demonstrate rigorous error propagation in your implementation.

For interviews, being able to describe the RESP protocol format from memory (simple strings start with `+`, errors with `-`, integers with `:`, bulk strings with `$`, arrays with `*`) shows firsthand implementation experience rather than theoretical knowledge.

### Senior @ FAANG: Protocol Design as a Platform Decision

At senior level, protocol design is a platform decision with long-term compatibility implications. RESP (version 2) has known limitations: no native type system beyond strings and arrays, no streaming support for large values, no built-in compression. RESP3 (Redis 6+) addresses some of these with additional types (maps, sets, doubles). If building a custom cache protocol, evaluating RESP2 versus RESP3 versus a binary protocol like MessagePack or Protocol Buffers is an ADR-worthy decision.

Parser performance at high throughput matters. A single-threaded parser (one goroutine per connection) does not saturate a CPU core at low message rates, but at 100k+ messages per second, parser CPU becomes the bottleneck. Zero-copy parsing (using `bufio.Scanner` with a shared buffer rather than per-message allocations) and pre-allocated command structs reduce GC pressure at high throughput. Profile before optimizing, but know the optimization techniques exist.

---
