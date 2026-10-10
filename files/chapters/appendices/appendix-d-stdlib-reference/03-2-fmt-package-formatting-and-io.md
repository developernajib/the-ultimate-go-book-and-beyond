## 2. fmt Package: Formatting and I/O

### Format Verbs Quick Reference

The `fmt` package uses percent-sign verbs similar to C's `printf`. The most common: `%v` for default formatting, `%+v` for structs with field names, `%#v` for Go-syntax representation, and `%T` for the type name.

```go
package main

import "fmt"

type Person struct {
    Name string
    Age  int
}

func (p Person) String() string {
    return fmt.Sprintf("%s (%d years)", p.Name, p.Age)
}

func main() {
    // Value representations
    p := Person{"Alice", 30}
    fmt.Printf("%v\n", p)   // {Alice 30}
    fmt.Printf("%+v\n", p)  // {Name:Alice Age:30} - includes field names
    fmt.Printf("%#v\n", p)  // main.Person{Name:"Alice", Age:30} - Go syntax
    fmt.Printf("%T\n", p)   // main.Person - type

    // Integers
    n := 42
    fmt.Printf("%d\n", n)   // 42 - decimal
    fmt.Printf("%b\n", n)   // 101010 - binary
    fmt.Printf("%o\n", n)   // 52 - octal
    fmt.Printf("%x\n", n)   // 2a - hexadecimal (lowercase)
    fmt.Printf("%X\n", n)   // 2A - hexadecimal (uppercase)
    fmt.Printf("%c\n", n)   // * - character
    fmt.Printf("%q\n", n)   // '*' - quoted character

    // Floats
    f := 123.456789
    fmt.Printf("%f\n", f)   // 123.456789 - decimal
    fmt.Printf("%.2f\n", f) // 123.46 - 2 decimal places
    fmt.Printf("%e\n", f)   // 1.234568e+02 - scientific notation
    fmt.Printf("%E\n", f)   // 1.234568E+02 - scientific notation (uppercase)
    fmt.Printf("%g\n", f)   // 123.456789 - compact representation

    // Strings
    s := "Hello, 世界"
    fmt.Printf("%s\n", s)   // Hello, 世界 - string
    fmt.Printf("%q\n", s)   // "Hello, 世界" - quoted string
    fmt.Printf("%x\n", s)   // 48656c6c6f2c20e4b896e7958c - hex dump
    fmt.Printf("%X\n", s)   // 48656C6C6F2C20E4B896E7958C - hex dump (uppercase)

    // Pointers
    ptr := &p
    fmt.Printf("%p\n", ptr)  // 0xc0000a4000 - pointer address
    fmt.Printf("%v\n", ptr)  // &{Alice 30}

    // Width and alignment
    fmt.Printf("|%5d|\n", 42)     // |   42| - right-aligned, width 5
    fmt.Printf("|%-5d|\n", 42)    // |42   | - left-aligned, width 5
    fmt.Printf("|%05d|\n", 42)    // |00042| - zero-padded
    fmt.Printf("|%10s|\n", "hi")  // |        hi| - right-aligned
    fmt.Printf("|%-10s|\n", "hi") // |hi        | - left-aligned
}
```

### Printf vs Sprintf vs Fprintf

```go
package main

import (
    "bytes"
    "fmt"
    "os"
)

func demonstratePrintVariants() {
    name := "Alice"
    age := 30

    // Printf - writes to stdout, returns byte count and error
    n, err := fmt.Printf("Name: %s, Age: %d\n", name, age)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Wrote %d bytes\n", n)

    // Sprintf - returns formatted string
    s := fmt.Sprintf("Name: %s, Age: %d", name, age)
    fmt.Println(s)

    // Fprintf - writes to any io.Writer
    var buf bytes.Buffer
    fmt.Fprintf(&buf, "Name: %s, Age: %d\n", name, age)
    fmt.Fprintf(os.Stderr, "Error: something went wrong\n")

    // Fprint variants (no formatting)
    fmt.Fprint(&buf, "No ", "formatting ", "here\n")
    fmt.Fprintln(&buf, "With", "newline")

    fmt.Println("Buffer contents:", buf.String())
}
```

### Scanning Input

```go
package main

import (
    "fmt"
    "strings"
)

func scanningExamples() {
    // Scan from stdin
    var name string
    var age int

    // Commented out to avoid blocking in example
    // fmt.Print("Enter name and age: ")
    // fmt.Scan(&name, &age)

    // Sscan - scan from string
    input := "Alice 30"
    n, err := fmt.Sscan(input, &name, &age)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Scanned %d items: %s, %d\n", n, name, age)

    // Sscanf - formatted scanning
    input2 := "Name: Bob, Age: 25"
    fmt.Sscanf(input2, "Name: %s, Age: %d", &name, &age)
    fmt.Printf("%s is %d years old\n", name, age)

    // Fscan - scan from io.Reader
    reader := strings.NewReader("Charlie 35")
    fmt.Fscan(reader, &name, &age)
    fmt.Printf("%s is %d years old\n", name, age)
}
```

### Custom Formatters

```go
package main

import (
    "fmt"
    "strings"
)

// Implementing fmt.Stringer
type User struct {
    ID       int
    Username string
    Email    string
}

func (u User) String() string {
    return fmt.Sprintf("User<%s>", u.Username)
}

// Implementing fmt.GoStringer for %#v
func (u User) GoString() string {
    return fmt.Sprintf(`User{ID: %d, Username: %q, Email: %q}`,
        u.ID, u.Username, u.Email)
}

// Implementing fmt.Formatter for complete control
type Money struct {
    Amount   int64 // cents
    Currency string
}

func (m Money) Format(f fmt.State, verb rune) {
    switch verb {
    case 'v':
        if f.Flag('#') {
            // %#v - Go syntax
            fmt.Fprintf(f, "Money{Amount: %d, Currency: %q}",
                m.Amount, m.Currency)
        } else {
            // %v - simple format
            fmt.Fprintf(f, "%d %s", m.Amount, m.Currency)
        }
    case 's':
        // %s - human-readable format
        amount := float64(m.Amount) / 100.0
        fmt.Fprintf(f, "%.2f %s", amount, m.Currency)
    case 'f':
        // %f - float representation
        amount := float64(m.Amount) / 100.0
        fmt.Fprintf(f, "%f", amount)
    default:
        fmt.Fprintf(f, "%%!%c(BADVERB)", verb)
    }
}

func customFormatterDemo() {
    u := User{ID: 1, Username: "alice", Email: "alice@example.com"}
    fmt.Printf("%v\n", u)   // User<alice>
    fmt.Printf("%+v\n", u)  // {ID:1 Username:alice Email:alice@example.com}
    fmt.Printf("%#v\n", u)  // User{ID: 1, Username: "alice", Email: "alice@example.com"}

    m := Money{Amount: 12345, Currency: "USD"}
    fmt.Printf("%v\n", m)   // 12345 USD
    fmt.Printf("%s\n", m)   // 123.45 USD
    fmt.Printf("%.2f\n", m) // 123.450000
    fmt.Printf("%#v\n", m)  // Money{Amount: 12345, Currency: "USD"}
}
```

### Error Formatting (Go 1.13+)

```go
package main

import (
    "errors"
    "fmt"
    "os"
)

func errorFormattingExample() {
    // Basic error wrapping
    baseErr := errors.New("database connection failed")
    wrappedErr := fmt.Errorf("failed to query users: %w", baseErr)

    fmt.Println(wrappedErr)
    // Output: failed to query users: database connection failed

    // Check if error is wrapped
    if errors.Is(wrappedErr, baseErr) {
        fmt.Println("Error is related to database connection")
    }

    // Multiple context layers
    err := openFile("config.json")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        // Error: failed to load config: failed to read file: open config.json: no such file or directory
    }
}

func openFile(path string) error {
    _, err := os.Open(path)
    if err != nil {
        return fmt.Errorf("failed to read file: %w", err)
    }
    return nil
}

func loadConfig() error {
    err := openFile("config.json")
    if err != nil {
        return fmt.Errorf("failed to load config: %w", err)
    }
    return nil
}
```

---
