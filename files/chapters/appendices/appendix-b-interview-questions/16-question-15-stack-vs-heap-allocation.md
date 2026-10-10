## Question 15: Stack vs Heap Allocation

**Level**: Senior

**Question**: How does Go decide whether to allocate on the stack or heap? What is escape analysis?

```go
func createUser() *User {
    u := User{Name: "John"}
    return &u  // Does this allocate on stack or heap?
}

func processValue() {
    u := User{Name: "Jane"}
    printUser(u)  // Stack or heap?
}

func printUser(u User) {
    fmt.Println(u.Name)
}
```

**Answer**:

- `createUser`: Allocates on **heap** (escapes to caller)
- `processValue`: Allocates on **stack** (doesn't escape)

**Explanation**:

**Escape Analysis**: Compiler determines if a variable can be safely allocated on the stack or must be allocated on the heap.

**Rules**:
1. If a variable's address is taken and **returned** from a function → **heap**
2. If a variable's address is taken but **doesn't escape** → **stack**
3. If a variable is **too large** → **heap**
4. If a variable's size is **unknown at compile time** → **heap**

**Checking Escape Analysis**:

```bash
go build -gcflags='-m' main.go

# Output:
# ./main.go:2:6: can inline createUser
# ./main.go:3:9: &u escapes to heap
# ./main.go:2:17: moved to heap: u
# ./main.go:7:9: u does not escape
```

**Stack Allocation (Fast)**:

```go
func sum() int {
    a := 1
    b := 2
    c := a + b
    return c
}
// All variables on stack, deallocated when function returns
// No GC pressure
```

**Heap Allocation (Slower, GC pressure)**:

```go
func makeSlice() []int {
    s := make([]int, 1000)
    return s  // Escapes to heap
}
// Slice allocated on heap
// GC must track and eventually free it
```

**Performance Impact**:

```go
// Stack allocation: ~0.3ns per allocation
func stackAlloc() int {
    x := 42
    return x
}

// Heap allocation: ~20ns per allocation + GC cost
func heapAlloc() *int {
    x := 42
    return &x
}

// Benchmark shows 60x difference!
```

**Companies that asked this**: Google, Meta, Uber, Cloudflare

---

## System Design with Go
