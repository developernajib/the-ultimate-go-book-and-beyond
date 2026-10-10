## Question 10: iota and Constants

**Level**: Junior-Mid

**Question**: What values do these constants have? Explain iota behavior.

```go
const (
    _ = iota
    KB = 1 << (10 * iota)
    MB
    GB
    TB
)

const (
    FlagRead = 1 << iota
    FlagWrite
    FlagExecute
)

const (
    Sunday = iota
    Monday
    Tuesday
    _
    Thursday
    Friday
    Saturday
)

func main() {
    fmt.Println("KB:", KB)
    fmt.Println("MB:", MB)
    fmt.Println("GB:", GB)
    fmt.Println("TB:", TB)

    fmt.Println("FlagRead:", FlagRead)
    fmt.Println("FlagWrite:", FlagWrite)
    fmt.Println("FlagExecute:", FlagExecute)

    fmt.Println("Thursday:", Thursday)
}
```

**Answer**:

```
KB: 1024
MB: 1048576
GB: 1073741824
TB: 1099511627776
FlagRead: 1
FlagWrite: 2
FlagExecute: 4
Thursday: 4
```

**Explanation**:

**iota**: A predeclared identifier that represents successive untyped integer constants. It resets to 0 in each `const` block and increments for each const specification.

**Example 1 - Byte Sizes**:

```go
const (
    _  = iota             // iota = 0, blank identifier skips this
    KB = 1 << (10 * iota) // iota = 1, 1 << 10 = 1024
    MB                    // iota = 2, 1 << 20 = 1048576
    GB                    // iota = 3, 1 << 30 = 1073741824
    TB                    // iota = 4, 1 << 40 = 1099511627776
)

// Expanded:
// KB = 1 << (10 * 1) = 1 << 10 = 2^10  = 1024
// MB = 1 << (10 * 2) = 1 << 20 = 2^20  = 1048576
// GB = 1 << (10 * 3) = 1 << 30 = 2^30  = 1073741824
// TB = 1 << (10 * 4) = 1 << 40 = 2^40  = 1099511627776
```

**Example 2 - Bit Flags**:

```go
const (
    FlagRead    = 1 << iota  // iota = 0, 1 << 0 = 1 (binary: 001)
    FlagWrite                // iota = 1, 1 << 1 = 2 (binary: 010)
    FlagExecute              // iota = 2, 1 << 2 = 4 (binary: 100)
)

// Usage:
permissions := FlagRead | FlagWrite  // 1 | 2 = 3 (binary: 011)

// Check permissions:
if permissions&FlagRead != 0 {
    fmt.Println("Can read")
}
if permissions&FlagWrite != 0 {
    fmt.Println("Can write")
}
if permissions&FlagExecute != 0 {
    fmt.Println("Can execute")
}
```

**Example 3 - Skipping Values**:

```go
const (
    Sunday    = iota  // 0
    Monday            // 1
    Tuesday           // 2
    _                 // 3 (skipped)
    Thursday          // 4
    Friday            // 5
    Saturday          // 6
)
```

**iota Patterns**:

```go
// Pattern 1: Simple enumeration
const (
    StatusOK = iota
    StatusError
    StatusPending
)
// Values: 0, 1, 2

// Pattern 2: Powers of 2
const (
    Bit0 = 1 << iota  // 1
    Bit1              // 2
    Bit2              // 4
    Bit3              // 8
)

// Pattern 3: Starting from 1
const (
    January = iota + 1  // 1
    February            // 2
    March               // 3
    // ...
)

// Pattern 4: Custom increments
const (
    Port8080 = 8080 + iota  // 8080
    Port8081                // 8081
    Port8082                // 8082
)

// Pattern 5: Multiple values per line
const (
    a, b = iota, iota + 10  // a = 0, b = 10
    c, d                    // c = 1, d = 11
    e, f                    // e = 2, f = 12
)

// Pattern 6: Explicit reset
const (
    x = iota  // 0
    y         // 1
    z = 100   // 100 (breaks pattern)
    w         // 100 (repeats last value)
)

const (
    a2 = iota  // 0 (new const block, iota resets)
)
```

**Real-World Example - File Modes**:

```go
const (
    ModeDir        = 1 << (32 - 1 - iota)  // d: directory
    ModeAppend                              // a: append-only
    ModeExclusive                           // l: exclusive use
    ModeTemporary                           // T: temporary file
    ModeSymlink                             // L: symbolic link
    ModeDevice                              // D: device file
    ModeNamedPipe                           // p: named pipe
    ModeSocket                              // S: Unix domain socket
    ModeSetuid                              // u: setuid
    ModeSetgid                              // g: setgid
    ModeCharDevice                          // c: Unix character device
    ModeSticky                              // t: sticky
    ModeIrregular                           // ?: non-regular file

    // Mask for permission bits
    ModePerm = 0777
)

// From os package, checking file type:
func isDir(mode os.FileMode) bool {
    return mode&ModeDir != 0
}
```

**Type Safety with iota**:

```go
// Without type (dangerous):
const (
    Red = iota
    Green
    Blue
)

const (
    Small = iota
    Medium
    Large
)

func setColorUntyped(c int) { _ = c }

func demoUntyped() {
    setColorUntyped(Red)   // OK
    setColorUntyped(Small) // Compiles! Type mismatch not caught
}

// With type (safe):
type Color int
const (
    ColorRed Color = iota
    ColorGreen
    ColorBlue
)

type Size int
const (
    SizeSmall Size = iota
    SizeMedium
    SizeLarge
)

func setColorTyped(c Color) { _ = c }

func demoTyped() {
    setColorTyped(ColorRed) // OK
    // setColorTyped(SizeSmall) // Compile error: cannot use SizeSmall (type Size) as type Color
}
```

**String Representation**:

```go
type Weekday int

const (
    Sunday Weekday = iota
    Monday
    Tuesday
    Wednesday
    Thursday
    Friday
    Saturday
)

// Implement Stringer interface
func (w Weekday) String() string {
    names := [...]string{
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    }

    if w < Sunday || w > Saturday {
        return "Unknown"
    }

    return names[w]
}

// Usage:
func main() {
    fmt.Println(Monday) // Prints: Monday
}
```

**Using stringer tool** (automatic generation):

```go
//go:generate stringer -type=Weekday

type Weekday int

const (
    Sunday Weekday = iota
    Monday
    Tuesday
    Wednesday
    Thursday
    Friday
    Saturday
)

// Running `go generate` creates weekday_string.go with String() method
```

**Common Mistakes**:

```go
// Mistake 1: Forgetting iota resets in new const block
const (
    A = iota  // 0
    B         // 1
)
const (
    C = iota  // 0 (not 2!)
    D         // 1 (not 3!)
)

// Mistake 2: Blank line doesn't reset iota
const (
    E = iota  // 0

    F         // 1 (not 0!)
)

// Mistake 3: Mixing explicit and implicit values
const (
    G = iota  // 0
    H = 10    // 10
    I         // 10 (not 2!)
    J = iota  // 3
)
```

**Companies that asked this**: Amazon, Cloudflare, Datadog

---

*[Continue with remaining Language Fundamentals questions 11-20...]*

---

## Concurrency Questions
