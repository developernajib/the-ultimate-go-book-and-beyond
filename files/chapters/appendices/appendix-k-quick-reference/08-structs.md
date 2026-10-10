## Structs

Structs are Go's way of grouping related data together into a single type, similar to classes in other languages but without inheritance. You can attach methods to structs using receivers, and embed one struct inside another to achieve composition. Field tags (backtick-enclosed metadata like `json:"name"`) control how structs interact with encoding, databases, and other libraries. Fields that start with an uppercase letter are exported (public), while lowercase fields are unexported (private to the package).

```go
// Define struct
type Person struct {
    Name string
    Age  int
}

// Create struct
p := Person{Name: "Alice", Age: 30}
p := Person{"Alice", 30}  // Positional (fragile)
var p Person              // Zero-valued fields

// Access fields
name := p.Name
p.Age = 31

// Anonymous struct
person := struct {
    Name string
    Age  int
}{
    Name: "Alice",
    Age:  30,
}

// Pointer to struct
p := &Person{Name: "Alice", Age: 30}
name := p.Name  // Automatic dereferencing
(*p).Name       // Explicit (rarely needed)

// Embedded fields (composition)
type Address struct {
    Street string
    City   string
}

type Employee struct {
    Name    string
    Age     int
    Address        // Embedded field (promoted)
}

e := Employee{
    Name: "Alice",
    Age:  30,
    Address: Address{
        Street: "123 Main St",
        City:   "NYC",
    },
}
city := e.City  // Promoted field

// Field tags (for JSON, DB, etc.)
type User struct {
    ID       int    `json:"id" db:"user_id"`
    Name     string `json:"name" db:"full_name"`
    Password string `json:"-"`  // Ignored by json
}

// Exported vs unexported
type Example struct {
    Public  string  // Exported (capitalized)
    private string  // Unexported (lowercase)
}

// Constructor pattern
func NewPerson(name string, age int) *Person {
    return &Person{
        Name: name,
        Age:  age,
    }
}

// Methods
func (p Person) String() string {
    return fmt.Sprintf("%s (%d)", p.Name, p.Age)
}

// Pointer receiver (can modify)
func (p *Person) HaveBirthday() {
    p.Age++
}

// Value receiver (read-only)
func (p Person) IsAdult() bool {
    return p.Age >= 18
}

// Struct comparison
p1 := Person{Name: "Alice", Age: 30}
p2 := Person{Name: "Alice", Age: 30}
equal := p1 == p2  // true (if all fields comparable)

// Structs with slices/maps are not comparable
type NotComparable struct {
    Items []string
}
// n1 == n2  // ERROR!

// Zero value
var p Person
// p.Name == "", p.Age == 0

// Struct size and alignment
type Optimized struct {
    a int64  // 8 bytes
    b int64  // 8 bytes
    c int32  // 4 bytes
    d int32  // 4 bytes
}  // 24 bytes

type Unoptimized struct {
    a int64  // 8 bytes
    c int32  // 4 bytes + 4 padding
    b int64  // 8 bytes
    d int32  // 4 bytes + 4 padding
}  // 32 bytes

// Generic struct (Go 1.18+)
type Pair[T, U any] struct {
    First  T
    Second U
}

p := Pair[int, string]{First: 1, Second: "one"}
```

---
