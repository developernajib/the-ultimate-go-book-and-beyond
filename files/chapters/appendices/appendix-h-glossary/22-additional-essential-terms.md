## Additional Essential Terms

### Addressable
Expression whose address can be taken with `&`.

```go
x := 42
p := &x  // x is addressable

// &42 is invalid: literal not addressable
```

### Blank Import
Import for side effects only, using `_`.

```go
import _ "net/http/pprof"  // Registers handlers
```

### CSP
Communicating Sequential Processes, the concurrency model Go is based on.

### GOMAXPROCS
Maximum number of OS threads executing user Go code simultaneously.

```go
runtime.GOMAXPROCS(4)  // Use 4 threads
```

### Idempotent
Operation that produces same result when applied multiple times.

```go
// Close is not idempotent - second close panics
ch := make(chan int)
close(ch)
// close(ch)  // Panic: close of closed channel
```

### Method Expression
Converting a method to a regular function with receiver as first parameter.

```go
type T struct { value int }
func (t T) Get() int { return t.value }

fn := T.Get  // Method expression
result := fn(T{value: 42})  // 42
```

### Method Value
Binding a method to a specific receiver.

```go
t := T{value: 42}
fn := t.Get  // Method value
result := fn()  // 42
```

### Package-Level
Variable or function declared at package scope, not inside a function.

```go
package mypackage

var globalConfig Config  // Package-level

func init() {
    // Package-level initialization
}
```

### Send/Receive Operation
Channel operations for communication.

```go
ch <- value     // Send operation
value := <-ch   // Receive operation
```

### Sentinel Error
Pre-defined error value for comparison.

```go
var ErrNotFound = errors.New("not found")

if err == ErrNotFound {
    // Handle specific error
}
```

### Short Variable Declaration
`:=` syntax for declaring and initializing variables.

```go
x := 42  // Type inferred
y, z := "hello", 3.14
```

### Signal Channel
Channel used only for signaling, typically `chan struct{}`.

```go
done := make(chan struct{})
go func() {
    // Work...
    close(done)  // Signal completion
}()
<-done  // Wait for signal
```

### Statically Typed
Type checking performed at compile time.

```go
var x int = "string"  // Compile error
```

### Synchronous
Operation that blocks until completion.

```go
ch := make(chan int)  // Unbuffered = synchronous
ch <- 42  // Blocks until received
```

### Tilde (~)
Operator in type constraints matching underlying types.

```go
type Integer interface {
    ~int | ~int64  // Matches int and types based on int
}

type MyInt int
// MyInt satisfies Integer due to ~
```

### Type Definition
Creating a new distinct type.

```go
type Celsius float64    // New type
type Fahrenheit float64 // Different from Celsius
```

### Unsafe
Package for operations that bypass Go's type safety.

```go
import "unsafe"

var x int64 = 42
p := unsafe.Pointer(&x)
```

### Work Stealing
Scheduler algorithm where idle processors steal goroutines from busy ones.

---
