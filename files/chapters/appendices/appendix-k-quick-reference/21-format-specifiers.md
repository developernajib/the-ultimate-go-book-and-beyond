## Format Specifiers

Go's `fmt` package uses format verbs (like `%d`, `%s`, `%v`) to control how values are printed or formatted into strings. The most versatile verb is `%v`, which prints any value in its default format, while `%+v` adds field names for structs and `%#v` shows the Go syntax representation. Width and precision modifiers (e.g., `%8.2f`) let you control alignment and decimal places for formatted output. Use `%T` to print the type of any value, which is especially helpful during debugging.

```text
// General
%v    // Value in default format
%+v   // With field names (structs)
%#v   // Go-syntax representation
%T    // Type of value
%%    // Literal percent sign

// Boolean
%t    // true or false

// Integer
%b    // Binary
%c    // Character (rune)
%d    // Decimal
%o    // Octal
%O    // Octal with 0o prefix
%x    // Hexadecimal (lowercase)
%X    // Hexadecimal (uppercase)
%U    // Unicode format (U+1234)

// Float
%f    // Decimal point, no exponent
%F    // Same as %f
%e    // Scientific notation (lowercase)
%E    // Scientific notation (uppercase)
%g    // %e or %f, whichever is more compact
%G    // %E or %F, whichever is more compact

// Precision
%.2f  // Two decimal places
%6.2f // Width 6, 2 decimal places
%*.*f // Width and precision from args

// String and bytes
%s    // String or slice
%q    // Quoted string
%x    // Hex dump (lowercase)
%X    // Hex dump (uppercase)

// Pointer
%p    // Pointer address (hex with 0x)

// Width and alignment
%5d   // Width 5, right-aligned
%-5d  // Width 5, left-aligned
%05d  // Width 5, zero-padded

// Sign
%+d   // Always show sign
% d   // Space for positive numbers
```

```go
// Examples
i := 42
fmt.Printf("%d\n", i)        // 42
fmt.Printf("%5d\n", i)       // "   42"
fmt.Printf("%-5d\n", i)      // "42   "
fmt.Printf("%05d\n", i)      // "00042"
fmt.Printf("%b\n", i)        // "101010"
fmt.Printf("%x\n", i)        // "2a"
fmt.Printf("%#x\n", i)       // "0x2a"

f := 3.14159
fmt.Printf("%f\n", f)        // "3.141590"
fmt.Printf("%.2f\n", f)      // "3.14"
fmt.Printf("%8.2f\n", f)     // "    3.14"
fmt.Printf("%e\n", f)        // "3.141590e+00"

s := "hello"
fmt.Printf("%s\n", s)        // "hello"
fmt.Printf("%q\n", s)        // "\"hello\""
fmt.Printf("%x\n", s)        // "68656c6c6f"

type Person struct {
    Name string
    Age  int
}
p := Person{"Alice", 30}
fmt.Printf("%v\n", p)        // "{Alice 30}"
fmt.Printf("%+v\n", p)       // "{Name:Alice Age:30}"
fmt.Printf("%#v\n", p)       // "main.Person{Name:"Alice", Age:30}"
fmt.Printf("%T\n", p)        // "main.Person"

ptr := &p
fmt.Printf("%p\n", ptr)      // "0xc0000140a0"
```

---
