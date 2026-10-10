## 10C.31 Missing Return After HTTP Reply

In Go HTTP handlers, functions like `http.Error()`, `w.WriteHeader()`, and `w.Write()` do **not** stop the handler function from executing. They write to the response, but execution continues to the next line. If you forget to `return` after sending an error response, the handler falls through to success logic, writing multiple responses and producing the dreaded "superfluous response.WriteHeader call" warning.

### The Disaster

`http.Error` and `w.WriteHeader` write to the response but do not stop function execution. Without an explicit `return`, the handler runs on into the success branch.

What happens next is worth being precise about, because it is not symmetric. **The first `WriteHeader` wins.** The second call logs `http: superfluous response.WriteHeader call` and is otherwise ignored, so the status code stays at the error value. The **body**, however, is not ignored. Every subsequent `Write` appends. The client therefore receives the error status code with the error message *and* the success payload concatenated after it, which is neither a valid error response nor a valid success response.

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
)

type User struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

// WRONG: Missing return after error responses
func handleCreateUser(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        // BUG: no return! Execution falls through to the JSON decoding below.
    }

    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        // BUG: no return! Falls through to validation below.
    }

    if user.Name == "" {
        w.WriteHeader(http.StatusBadRequest)
        json.NewEncoder(w).Encode(map[string]string{"error": "name is required"})
        // BUG: no return! Falls through to success response.
    }

    // This runs EVEN WHEN THE ERRORS ABOVE FIRED.
    // The 201 is discarded (the 405 already went out) and logged as
    // "superfluous response.WriteHeader call". The Encode below is NOT
    // discarded: it appends to the body. The client gets 405 with
    //     method not allowed
    //     {"name":"","email":""}
    // A status that says one thing and a body that says another.
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

func main() {
    http.HandleFunc("/users", handleCreateUser)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

### Why It's Dangerous

- The client receives a garbled response: the error message with success data appended
- `http: superfluous response.WriteHeader call` goes to the server log, never to the client, and never panics. Nothing fails loudly.
- The handler runs the business logic it was supposed to skip. Database writes, payment calls, and email sends all happen, then get reported as a 400.
- Worst case, this is an authorization bypass. A `if !authorized { http.Error(w, "forbidden", 403) }` with no `return` writes 403 to the response and then serves the protected resource in the body underneath it.
- Tests that only assert on the status code pass, because the status code is correct

### The Fix: Always Return After Error Responses

Adding an explicit `return` after every error response stops execution and prevents the handler from falling through into business logic. Extracting error writing into a helper function reduces repetition while keeping the `return` visible at the call site.

```go
package main

import (
    "encoding/json"
    "log"
    "net/http"
)

type User struct {
    Name  string `json:"name"`
    Email string `json:"email"`
}

// CORRECT: Every error response is followed by return
func handleCreateUser(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return // CRITICAL: stop execution here
    }

    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return // CRITICAL: stop execution here
    }

    if user.Name == "" {
        w.WriteHeader(http.StatusBadRequest)
        json.NewEncoder(w).Encode(map[string]string{"error": "name is required"})
        return // CRITICAL: stop execution here
    }

    // This ONLY executes when all validations pass
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

// PRODUCTION PATTERN: Helper function to enforce the pattern
func writeError(w http.ResponseWriter, statusCode int, message string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// Even cleaner handler with the helper:
func handleCreateUserClean(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        writeError(w, http.StatusMethodNotAllowed, "method not allowed")
        return
    }

    var user User
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        writeError(w, http.StatusBadRequest, "invalid JSON body")
        return
    }

    if user.Name == "" {
        writeError(w, http.StatusBadRequest, "name is required")
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(user)
}

func main() {
    // Go 1.22+ routing patterns accept a method, which deletes the whole
    // first guard. The mux returns 405 itself, and a check you do not write
    // is a return you cannot forget.
    http.HandleFunc("POST /users", handleCreateUserClean)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
```

**The Rule:** every error response is followed by an explicit `return`. `http.Error` and `w.WriteHeader` are writes, not exits, and no amount of reading them as `throw` will make them behave that way.

Two habits that make this structural rather than a matter of vigilance. Route by method so the mux handles the cases it can. And where a handler grows past a few guards, give it a body that returns an error and wrap it, so the compiler starts caring:

```go
type handler func(http.ResponseWriter, *http.Request) error

func wrap(h handler) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if err := h(w, r); err != nil {
            writeError(w, statusOf(err), err.Error())
        }
    }
}
```

Now the failure mode inverts: forgetting to `return` inside `h` is forgetting to return a value from a function that must return one, which does not compile.

---
