## Pointers

Pointers hold the memory address of a value, letting you share and modify data without copying it. Use `&` to get the address of a variable and `*` to dereference a pointer and access the value it points to. Go does not support pointer arithmetic in safe code, which prevents many common memory bugs found in C and C++. Pointer receivers on methods are essential when you need to modify the receiver's state or when the struct is large and copying would be expensive.

```go
// Declare pointer
var p *int

// Get address
i := 42
p = &i

// Dereference
value := *p
*p = 21  // Modify value at address

// Zero value
var p *int  // nil

// Check for nil
if p == nil {
    // ...
}

// new() allocates memory
p := new(int)   // Returns *int, zero-valued
*p = 42

// Pointer to struct
type Person struct {
    Name string
}

p := &Person{Name: "Alice"}
name := p.Name  // Automatic dereferencing
(*p).Name       // Explicit (rarely needed)

// Pointer receivers
func (p *Person) Rename(name string) {
    p.Name = name  // Modifies original
}

// Value vs pointer
p1 := Person{Name: "Alice"}
p2 := p1  // Copy

p3 := &Person{Name: "Alice"}
p4 := p3  // Share same data

// Function parameters
func modify(p *Person) {
    p.Name = "Bob"  // Modifies original
}

func noModify(p Person) {
    p.Name = "Bob"  // Modifies copy
}

// Return pointer
func NewPerson(name string) *Person {
    p := Person{Name: name}
    return &p  // OK! Escape analysis moves to heap
}

// Common gotcha: pointer to loop variable
var ptrs []*int
for i := 0; i < 3; i++ {
    ptrs = append(ptrs, &i)  // Wrong! All point to same var
}
// Fix:
for i := 0; i < 3; i++ {
    i := i  // Create new variable (Go 1.22 fixes this)
    ptrs = append(ptrs, &i)
}

// Pointer arithmetic (unsafe)
import "unsafe"

var arr [3]int
ptr := &arr[0]
nextPtr := (*int)(unsafe.Pointer(uintptr(unsafe.Pointer(ptr)) + unsafe.Sizeof(int(0))))

// Generally avoid unsafe!
```

---
