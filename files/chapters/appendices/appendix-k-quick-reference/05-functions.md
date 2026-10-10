## Functions

Functions are first-class citizens in Go, meaning they can be assigned to variables, passed as arguments, and returned from other functions. Go functions can return multiple values, which is the standard pattern for returning both a result and an error. Methods are functions attached to a type via a receiver, which can be either a value receiver (read-only copy) or a pointer receiver (can modify the original). Go 1.18 introduced generics, allowing you to write functions that work with multiple types while retaining type safety.

```go
// Basic function
func add(a int, b int) int {
    return a + b
}

// Shared type
func add(a, b int) int {
    return a + b
}

// Multiple return values
func swap(a, b string) (string, string) {
    return b, a
}

// Named return values
func split(sum int) (x, y int) {
    x = sum * 4 / 9
    y = sum - x
    return  // Naked return (returns x and y)
}

// Variadic function
func sum(nums ...int) int {
    total := 0
    for _, num := range nums {
        total += num
    }
    return total
}

// Call variadic function
sum(1, 2, 3, 4)
nums := []int{1, 2, 3, 4}
sum(nums...)  // Unpack slice

// Function as type
type MathFunc func(int, int) int

func compute(fn MathFunc, a, b int) int {
    return fn(a, b)
}

// Anonymous function
fn := func(a, b int) int {
    return a + b
}
result := fn(3, 4)

// Closure
func counter() func() int {
    count := 0
    return func() int {
        count++
        return count
    }
}

c := counter()
c()  // 1
c()  // 2

// Method (receiver function)
type Rectangle struct {
    width, height float64
}

// Value receiver
func (r Rectangle) Area() float64 {
    return r.width * r.height
}

// Pointer receiver (can modify)
func (r *Rectangle) Scale(factor float64) {
    r.width *= factor
    r.height *= factor
}

// Generic function (Go 1.18+)
func Min[T constraints.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Call generic function
m := Min[int](3, 5)
m := Min(3, 5)  // Type inference

// init function (runs before main)
func init() {
    // Initialization code
}

// main function (entry point)
func main() {
    // Program starts here
}
```

---
