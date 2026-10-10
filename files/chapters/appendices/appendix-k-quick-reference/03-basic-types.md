## Basic Types

Go is a statically typed language with a rich set of built-in types including integers, floats, booleans, and strings. Integer types come in both signed and unsigned variants with explicit sizes (e.g., `int8`, `uint32`), plus platform-dependent `int` and `uint`. Go requires explicit type conversions between different types, there are no implicit casts. The `strconv` package provides functions for converting between strings and numeric types.

```go
// Integer types:
// int, int8, int16, int32, int64
// uint, uint8, uint16, uint32, uint64, uintptr

// Aliases:
// byte (alias for uint8)
// rune (alias for int32 Unicode code point)

// Floating point:
// float32, float64

// Complex numbers:
// complex64, complex128

c := complex(5, 7)      // 5+7i
c := 5 + 7i             // 5+7i
r := real(c)            // 5.0
i := imag(c)            // 7.0

// Boolean: bool (true or false)

// String: string

// Type conversions (explicit only)
i := 42
f := float64(i)
u := uint(f)
s := string(i)  // Converts to rune, not "42"!

// String to number
s := "42"
i, err := strconv.Atoi(s)
i64, err := strconv.ParseInt(s, 10, 64)
f64, err := strconv.ParseFloat(s, 64)

// Number to string
s := strconv.Itoa(42)
s := strconv.FormatInt(int64(42), 10)
s := strconv.FormatFloat(3.14, 'f', 2, 64)
```

---
