## 6. Table-Driven Tests

Table-driven tests reduce duplication and make test cases easy to add and maintain.

### Basic Table-Driven Test

Define a slice of anonymous structs with input and expected output fields. Loop over the slice with `t.Run` to give each case a name. Adding a new test case means adding one struct literal.

```go
package math

import (
    "testing"
)

// Add adds two integers
func Add(a, b int) int {
    return a + b
}

// TestAdd demonstrates basic table-driven testing
func TestAdd(t *testing.T) {
    tests := []struct {
        name     string
        a        int
        b        int
        expected int
    }{
        {"positive numbers", 2, 3, 5},
        {"negative numbers", -2, -3, -5},
        {"mixed signs", -2, 3, 1},
        {"zero", 0, 0, 0},
        {"with zero", 5, 0, 5},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            result := Add(tt.a, tt.b)
            if result != tt.expected {
                t.Errorf("Add(%d, %d) = %d; want %d", tt.a, tt.b, result, tt.expected)
            }
        })
    }
}
```

### Advanced Table-Driven Tests

```go
package validator

import (
    "errors"
    "testing"
)

// ValidateEmail validates email format
func ValidateEmail(email string) error {
    if email == "" {
        return errors.New("email cannot be empty")
    }
    if len(email) < 3 {
        return errors.New("email too short")
    }
    if email[0] == '@' {
        return errors.New("email cannot start with @")
    }
    return nil
}

// TestValidateEmail demonstrates testing with expected errors
func TestValidateEmail(t *testing.T) {
    tests := []struct {
        name      string
        email     string
        wantErr   bool
        errString string
    }{
        {
            name:    "valid email",
            email:   "user@example.com",
            wantErr: false,
        },
        {
            name:      "empty email",
            email:     "",
            wantErr:   true,
            errString: "email cannot be empty",
        },
        {
            name:      "too short",
            email:     "a@",
            wantErr:   true,
            errString: "email too short",
        },
        {
            name:      "starts with @",
            email:     "@example.com",
            wantErr:   true,
            errString: "email cannot start with @",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            err := ValidateEmail(tt.email)

            if tt.wantErr {
                if err == nil {
                    t.Errorf("ValidateEmail(%q) expected error, got nil", tt.email)
                    return
                }
                if err.Error() != tt.errString {
                    t.Errorf("ValidateEmail(%q) error = %q; want %q", tt.email, err.Error(), tt.errString)
                }
            } else {
                if err != nil {
                    t.Errorf("ValidateEmail(%q) unexpected error: %v", tt.email, err)
                }
            }
        })
    }
}
```

### Table-Driven Tests with Setup/Teardown

```go
package database

import (
    "context"
    "testing"
    "time"
)

// User represents a user entity
type User struct {
    ID        int
    Username  string
    Email     string
    CreatedAt time.Time
}

// UserStore handles user persistence
type UserStore struct {
    users map[int]*User
}

func NewUserStore() *UserStore {
    return &UserStore{
        users: make(map[int]*User),
    }
}

func (s *UserStore) Create(ctx context.Context, user *User) error {
    if user.ID == 0 {
        user.ID = len(s.users) + 1
    }
    user.CreatedAt = time.Now()
    s.users[user.ID] = user
    return nil
}

func (s *UserStore) GetByID(ctx context.Context, id int) (*User, error) {
    user, ok := s.users[id]
    if !ok {
        return nil, errors.New("user not found")
    }
    return user, nil
}

// TestUserStore demonstrates table-driven tests with setup
func TestUserStore(t *testing.T) {
    tests := []struct {
        name      string
        setup     func(*UserStore) // Setup function
        operation func(*testing.T, *UserStore) // Test operation
    }{
        {
            name: "create user",
            setup: func(s *UserStore) {
                // No setup needed
            },
            operation: func(t *testing.T, s *UserStore) {
                user := &User{Username: "testuser", Email: "test@example.com"}
                err := s.Create(context.Background(), user)

                if err != nil {
                    t.Fatalf("Create() error = %v", err)
                }
                if user.ID == 0 {
                    t.Error("Create() did not set ID")
                }
                if user.CreatedAt.IsZero() {
                    t.Error("Create() did not set CreatedAt")
                }
            },
        },
        {
            name: "get existing user",
            setup: func(s *UserStore) {
                s.Create(context.Background(), &User{
                    ID:       1,
                    Username: "existing",
                    Email:    "existing@example.com",
                })
            },
            operation: func(t *testing.T, s *UserStore) {
                user, err := s.GetByID(context.Background(), 1)

                if err != nil {
                    t.Fatalf("GetByID() error = %v", err)
                }
                if user.Username != "existing" {
                    t.Errorf("GetByID() username = %q; want %q", user.Username, "existing")
                }
            },
        },
        {
            name: "get non-existent user",
            setup: func(s *UserStore) {
                // No setup needed
            },
            operation: func(t *testing.T, s *UserStore) {
                _, err := s.GetByID(context.Background(), 999)

                if err == nil {
                    t.Error("GetByID() expected error for non-existent user")
                }
            },
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Create fresh store for each test
            store := NewUserStore()

            // Run setup
            tt.setup(store)

            // Run operation
            tt.operation(t, store)
        })
    }
}
```

### Testing with Test Helpers

```go
package api

import (
    "encoding/json"
    "io"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

// Handler processes API requests
func Handler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var data map[string]string
    if err := json.NewDecoder(r.Body).Decode(&data); err != nil {
        http.Error(w, "invalid JSON", http.StatusBadRequest)
        return
    }

    name, ok := data["name"]
    if !ok || name == "" {
        http.Error(w, "name is required", http.StatusBadRequest)
        return
    }

    response := map[string]string{"message": "Hello, " + name}
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

// TestHandler demonstrates HTTP handler testing
func TestHandler(t *testing.T) {
    tests := []struct {
        name           string
        method         string
        body           string
        expectedStatus int
        expectedBody   string
    }{
        {
            name:           "valid request",
            method:         http.MethodPost,
            body:           `{"name":"John"}`,
            expectedStatus: http.StatusOK,
            expectedBody:   `{"message":"Hello, John"}`,
        },
        {
            name:           "invalid method",
            method:         http.MethodGet,
            body:           "",
            expectedStatus: http.StatusMethodNotAllowed,
            expectedBody:   "method not allowed\n",
        },
        {
            name:           "invalid JSON",
            method:         http.MethodPost,
            body:           `{invalid}`,
            expectedStatus: http.StatusBadRequest,
            expectedBody:   "invalid JSON\n",
        },
        {
            name:           "missing name",
            method:         http.MethodPost,
            body:           `{}`,
            expectedStatus: http.StatusBadRequest,
            expectedBody:   "name is required\n",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Create request
            req := httptest.NewRequest(tt.method, "/api/greet", strings.NewReader(tt.body))

            // Create response recorder
            w := httptest.NewRecorder()

            // Call handler
            Handler(w, req)

            // Check status code
            if w.Code != tt.expectedStatus {
                t.Errorf("status = %d; want %d", w.Code, tt.expectedStatus)
            }

            // Check response body
            body, _ := io.ReadAll(w.Body)
            if strings.TrimSpace(string(body)) != strings.TrimSpace(tt.expectedBody) {
                t.Errorf("body = %q; want %q", string(body), tt.expectedBody)
            }
        })
    }
}
```

### Benchmark Table-Driven Tests

```go
package strings

import (
    "strings"
    "testing"
)

// Concatenate joins strings using different methods
func ConcatenateOperator(strs []string) string {
    result := ""
    for _, s := range strs {
        result += s
    }
    return result
}

func ConcatenateBuilder(strs []string) string {
    var builder strings.Builder
    for _, s := range strs {
        builder.WriteString(s)
    }
    return builder.String()
}

func ConcatenateJoin(strs []string) string {
    return strings.Join(strs, "")
}

// BenchmarkConcatenate compares concatenation methods
func BenchmarkConcatenate(b *testing.B) {
    tests := []struct {
        name  string
        input []string
        fn    func([]string) string
    }{
        {
            name:  "operator/small",
            input: []string{"hello", "world"},
            fn:    ConcatenateOperator,
        },
        {
            name:  "builder/small",
            input: []string{"hello", "world"},
            fn:    ConcatenateBuilder,
        },
        {
            name:  "join/small",
            input: []string{"hello", "world"},
            fn:    ConcatenateJoin,
        },
        {
            name:  "operator/large",
            input: make([]string, 100),
            fn:    ConcatenateOperator,
        },
        {
            name:  "builder/large",
            input: make([]string, 100),
            fn:    ConcatenateBuilder,
        },
        {
            name:  "join/large",
            input: make([]string, 100),
            fn:    ConcatenateJoin,
        },
    }

    // Initialize large inputs
    for i := range tests {
        if len(tests[i].input) == 100 {
            for j := range tests[i].input {
                tests[i].input[j] = "test string"
            }
        }
    }

    for _, tt := range tests {
        b.Run(tt.name, func(b *testing.B) {
            for b.Loop() {
                tt.fn(tt.input)
            }
        })
    }
}
```

---
