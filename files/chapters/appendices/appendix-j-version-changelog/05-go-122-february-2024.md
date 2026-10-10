## Go 1.22 (February 2024)

### For-Range Loop Variable Fix

Each iteration gets its own variable (no more closure bugs).

```go
// Before Go 1.22: Common bug
func printNumbersOld() {
    for i := 0; i < 3; i++ {
        go func() {
            fmt.Println(i) // All goroutines print 3
        }()
    }
}

// Go 1.22+: Works as expected
func printNumbers() {
    for i := 0; i < 3; i++ {
        go func() {
            fmt.Println(i) // Prints 0, 1, 2 (in some order)
        }()
    }
}

// Before: workaround needed
for i := 0; i < 3; i++ {
    i := i // Shadow variable
    go func() {
        fmt.Println(i)
    }()
}

// Go 1.22+: no workaround needed
for i := 0; i < 3; i++ {
    go func() {
        fmt.Println(i) // Works correctly
    }()
}
```

### Enhanced ServeMux Routing

Method and wildcard support in standard library router.

```go
mux := http.NewServeMux()

// Method-specific routes
mux.HandleFunc("GET /users", listUsers)
mux.HandleFunc("POST /users", createUser)

// Path parameters
mux.HandleFunc("GET /users/{id}", func(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    fmt.Fprintf(w, "User ID: %s", id)
})

// Wildcard (must be at end)
mux.HandleFunc("GET /files/{path...}", func(w http.ResponseWriter, r *http.Request) {
    path := r.PathValue("path")
    // path can contain slashes: /files/images/photo.jpg -> path = "images/photo.jpg"
    fmt.Fprintf(w, "File path: %s", path)
})

// Host-specific routing
mux.HandleFunc("api.example.com/", apiHandler)
mux.HandleFunc("example.com/", webHandler)

// Precedence: most specific wins
mux.HandleFunc("/products/{id}", showProduct)      // Less specific
mux.HandleFunc("/products/new", newProduct)        // More specific (exact match wins)
```

### Ranging Over Integers

```go
// Range over integer
for i := range 5 {
    fmt.Println(i) // 0, 1, 2, 3, 4
}

// Useful for simple loops
func printGrid(size int) {
    for y := range size {
        for x := range size {
            fmt.Printf("(%d,%d) ", x, y)
        }
        fmt.Println()
    }
}
```

---
