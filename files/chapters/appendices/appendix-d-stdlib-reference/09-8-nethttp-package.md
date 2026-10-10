## 8. net/http Package

### HTTP Server Basics

Go's `net/http` package provides a production-grade HTTP server and client. Register handler functions or types with the default mux, or create a custom `http.ServeMux` for more control.

```go
package main

import (
    "fmt"
    "io"
    "net/http"
)

// Handler function
func helloHandler(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello, %s!", r.URL.Query().Get("name"))
}

// Handler type
type greetingHandler struct {
    greeting string
}

func (h *greetingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "%s, World!", h.greeting)
}

func basicServerExample() {
    // Register handler function
    http.HandleFunc("/hello", helloHandler)

    // Register handler type
    http.Handle("/greeting", &greetingHandler{greeting: "Greetings"})

    // Inline handler
    http.HandleFunc("/inline", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Inline handler"))
    })

    // Start server
    fmt.Println("Server starting on :8080")
    http.ListenAndServe(":8080", nil)
}

// Custom ServeMux
func customMuxExample() {
    mux := http.NewServeMux()

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Home"))
    })

    mux.HandleFunc("/api/users", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Write([]byte(`{"users":[]}`))
    })

    http.ListenAndServe(":8080", mux)
}
```

### HTTP Server Configuration

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "os"
    "os/signal"
    "time"
)

func configuredServerExample() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello"))
    })

    server := &http.Server{
        Addr:    ":8080",
        Handler: mux,

        // Timeouts
        ReadTimeout:       10 * time.Second,
        ReadHeaderTimeout: 5 * time.Second,
        WriteTimeout:      10 * time.Second,
        IdleTimeout:       120 * time.Second,

        // Limits
        MaxHeaderBytes: 1 << 20, // 1 MB

        // Error logging
        ErrorLog: nil, // Use custom logger if needed
    }

    // Graceful shutdown
    go func() {
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            fmt.Printf("Server error: %v\n", err)
        }
    }()

    // Wait for interrupt
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, os.Interrupt)
    <-quit

    fmt.Println("Shutting down server...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        fmt.Printf("Server forced to shutdown: %v\n", err)
    }

    fmt.Println("Server exited")
}
```

### Request Handling

```go
package main

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

func requestHandlingExample() {
    http.HandleFunc("/request-info", func(w http.ResponseWriter, r *http.Request) {
        // Method
        fmt.Fprintf(w, "Method: %s\n", r.Method)

        // URL components
        fmt.Fprintf(w, "Path: %s\n", r.URL.Path)
        fmt.Fprintf(w, "RawQuery: %s\n", r.URL.RawQuery)

        // Query parameters
        name := r.URL.Query().Get("name")
        names := r.URL.Query()["name"] // Multiple values
        fmt.Fprintf(w, "Name: %s, Names: %v\n", name, names)

        // Headers
        fmt.Fprintf(w, "User-Agent: %s\n", r.Header.Get("User-Agent"))
        fmt.Fprintf(w, "All headers: %v\n", r.Header)

        // Body
        body, _ := io.ReadAll(r.Body)
        defer r.Body.Close()
        fmt.Fprintf(w, "Body: %s\n", body)

        // Form data (POST)
        r.ParseForm()
        fmt.Fprintf(w, "Form: %v\n", r.Form)
        fmt.Fprintf(w, "PostForm: %v\n", r.PostForm)

        // Remote address
        fmt.Fprintf(w, "RemoteAddr: %s\n", r.RemoteAddr)

        // Context
        ctx := r.Context()
        _ = ctx // Use context for cancellation
    })
}

// JSON request/response
type CreateUserRequest struct {
    Username string `json:"username"`
    Email    string `json:"email"`
}

type CreateUserResponse struct {
    ID       int    `json:"id"`
    Username string `json:"username"`
    Email    string `json:"email"`
}

func createUserHandler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    // Decode request
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request body", http.StatusBadRequest)
        return
    }
    defer r.Body.Close()

    // Process request
    resp := CreateUserResponse{
        ID:       1,
        Username: req.Username,
        Email:    req.Email,
    }

    // Encode response
    w.Header().Set("Content-Type", "application/json")
    w.WriteStatus(http.StatusCreated)
    json.NewEncoder(w).Encode(resp)
}
```

### Middleware Pattern

```go
package main

import (
    "fmt"
    "log"
    "net/http"
    "time"
)

// Middleware type
type Middleware func(http.Handler) http.Handler

// Logging middleware
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        // Call next handler
        next.ServeHTTP(w, r)

        // Log after
        log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
    })
}

// Authentication middleware
func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")

        if token != "valid-token" {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// CORS middleware
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

        if r.Method == "OPTIONS" {
            w.WriteHeader(http.StatusOK)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// Chain multiple middlewares
func chain(middlewares ...Middleware) Middleware {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

func middlewareExample() {
    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        fmt.Fprintf(w, "Hello, World!")
    })

    // Apply middleware
    wrapped := chain(loggingMiddleware, corsMiddleware, authMiddleware)(handler)

    http.Handle("/protected", wrapped)
    http.ListenAndServe(":8080", nil)
}
```

### HTTP Client

```go
package main

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "time"
)

func basicHTTPClient() {
    // Simple GET
    resp, err := http.Get("https://api.example.com/users")
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Println(string(body))

    // POST with JSON
    user := map[string]string{"name": "Alice"}
    jsonData, _ := json.Marshal(user)

    resp, err = http.Post("https://api.example.com/users",
        "application/json",
        bytes.NewBuffer(jsonData))
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()
}

func advancedHTTPClient() {
    // Custom client with timeout
    client := &http.Client{
        Timeout: 10 * time.Second,

        // Custom transport
        Transport: &http.Transport{
            MaxIdleConns:        100,
            MaxIdleConnsPerHost: 10,
            IdleConnTimeout:     90 * time.Second,
        },
    }

    // Create request
    req, err := http.NewRequest("GET", "https://api.example.com/users", nil)
    if err != nil {
        panic(err)
    }

    // Add headers
    req.Header.Set("User-Agent", "MyApp/1.0")
    req.Header.Set("Authorization", "Bearer token")

    // Add query parameters
    q := req.URL.Query()
    q.Add("page", "1")
    q.Add("limit", "10")
    req.URL.RawQuery = q.Encode()

    // Send request
    resp, err := client.Do(req)
    if err != nil {
        panic(err)
    }
    defer resp.Body.Close()

    // Check status
    if resp.StatusCode != http.StatusOK {
        fmt.Printf("Error: %s\n", resp.Status)
        return
    }

    // Read response
    var result map[string]any
    json.NewDecoder(resp.Body).Decode(&result)
    fmt.Printf("%+v\n", result)
}

// Request with context
func requestWithContext() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.example.com/slow", nil)

    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil {
        fmt.Println("Request failed:", err)
        return
    }
    defer resp.Body.Close()
}
```

### ResponseWriter Patterns

```go
package main

import (
    "encoding/json"
    "net/http"
)

// Custom response writer for status code capture
type statusWriter struct {
    http.ResponseWriter
    status int
    length int
}

func (w *statusWriter) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
    if w.status == 0 {
        w.status = 200
    }
    n, err := w.ResponseWriter.Write(b)
    w.length += n
    return n, err
}

// JSON response helper
func respondJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

// Error response helper
func respondError(w http.ResponseWriter, status int, message string) {
    respondJSON(w, status, map[string]string{"error": message})
}

// Example usage
func exampleHandler(w http.ResponseWriter, r *http.Request) {
    data := map[string]any{
        "message": "Success",
        "data":    []string{"item1", "item2"},
    }
    respondJSON(w, http.StatusOK, data)
}
```

---
