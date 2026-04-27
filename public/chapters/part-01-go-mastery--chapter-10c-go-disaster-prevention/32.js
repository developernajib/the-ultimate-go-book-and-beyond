export default `## 10C.31 Missing Return After HTTP Reply

In Go HTTP handlers, functions like \`http.Error()\`, \`w.WriteHeader()\`, and \`w.Write()\` do **not** stop the handler function from executing. They write to the response, but execution continues to the next line. If you forget to \`return\` after sending an error response, the handler falls through to success logic, writing multiple responses and producing the dreaded "superfluous response.WriteHeader call" warning.

### The Disaster

\`http.Error\` and \`w.WriteHeader\` write to the response buffer but do not stop function execution. Without an explicit \`return\`, the handler continues into the success branch and calls \`w.WriteHeader(200)\` a second time, producing a "superfluous response.WriteHeader call" warning and sending a garbled, partially-written response to the client.

\`\`\`go
package main

import (
    "encoding/json"
    "log"
    "net/http"
)

type User struct {
    Name  string \`json:"name"\`
    Email string \`json:"email"\`
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

    // This executes EVEN WHEN ERRORS OCCURRED ABOVE
    w.WriteHeader(http.StatusCreated) // WARNING: "superfluous response.WriteHeader call"
    json.NewEncoder(w).Encode(user)   // sends garbage response after error response
}

func main() {
    http.HandleFunc("/users", handleCreateUser)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
\`\`\`

### Why It's Dangerous

- The client receives a garbled response: error message mixed with success data
- \`http: superfluous response.WriteHeader call\` appears in logs but doesn't panic
- In production, this can expose internal data in error responses
- The handler may execute business logic (database writes, API calls) that should have been skipped
- Security risk: authorization checks without \`return\` allow unauthorized access to proceed

### The Fix: Always Return After Error Responses

Adding an explicit \`return\` after every error response stops execution and prevents the handler from falling through into business logic. Extracting error writing into a helper function reduces repetition while keeping the \`return\` visible at the call site.

\`\`\`go
package main

import (
    "encoding/json"
    "log"
    "net/http"
)

type User struct {
    Name  string \`json:"name"\`
    Email string \`json:"email"\`
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
    http.HandleFunc("/users", handleCreateUserClean)
    log.Fatal(http.ListenAndServe(":8080", nil))
}
\`\`\`

**The Rule:** After every \`http.Error()\`, \`w.WriteHeader()\` that signals an error, or any error response write, you **must** add an explicit \`return\`. The Go HTTP library will not stop your handler for you.

---
`;
