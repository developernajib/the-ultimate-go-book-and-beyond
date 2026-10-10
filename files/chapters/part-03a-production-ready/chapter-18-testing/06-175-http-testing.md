## 18.5 HTTP Testing

### Testing HTTP Handlers

Go's `net/http/httptest` package provides `httptest.NewRequest` and `httptest.NewRecorder` to simulate HTTP interactions entirely in memory, without binding to a real network port. You attach the handler or router to a `ResponseRecorder`, call `ServeHTTP`, and then inspect the recorder's status code, headers, and body. This approach tests the full request lifecycle, routing, middleware, serialization, without the overhead of a running server.

```go
func TestUserHandler_Get(t *testing.T) {
    // Setup
    service := &MockUserService{
        GetFunc: func(id int) (*User, error) {
            return &User{ID: id, Name: "Alice"}, nil
        },
    }
    handler := NewUserHandler(service)

    // Create request
    req := httptest.NewRequest("GET", "/users/1", nil)
    w := httptest.NewRecorder()

    // Serve. Since Go 1.22 the stdlib ServeMux understands method
    // prefixes and {id} wildcards, so no third-party router is needed.
    // The handler reads the wildcard with r.PathValue("id").
    router := http.NewServeMux()
    router.HandleFunc("GET /users/{id}", handler.Get)
    router.ServeHTTP(w, req)

    // Assert
    if w.Code != http.StatusOK {
        t.Errorf("status = %d; want %d", w.Code, http.StatusOK)
    }

    var user User
    if err := json.NewDecoder(w.Body).Decode(&user); err != nil {
        t.Fatalf("decode response: %v", err)
    }

    if user.Name != "Alice" {
        t.Errorf("name = %s; want Alice", user.Name)
    }
}
```

### Testing HTTP Client

When testing code that acts as an HTTP client, `httptest.NewServer` spins up a real but ephemeral HTTP server on a random local port and returns its URL. You configure the server's handler to return controlled responses, then point your client at that URL instead of a production endpoint. Calling `defer server.Close()` ensures the server shuts down cleanly after the test, and any unexpected requests received inside the handler can be reported as test failures immediately.

```go
func TestAPIClient_GetUser(t *testing.T) {
    // Create test server
    server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/users/1" {
            t.Errorf("unexpected path: %s", r.URL.Path)
        }
        if r.Method != "GET" {
            t.Errorf("unexpected method: %s", r.Method)
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(User{ID: 1, Name: "Alice"})
    }))
    defer server.Close()

    // Test client
    client := NewAPIClient(server.URL)
    user, err := client.GetUser(1)

    assertNoError(t, err)
    assertEqual(t, user.Name, "Alice")
}
```

### Middleware Testing

Test middleware as unit functions, not through the full server. For anything that makes an allow-or-deny decision, the deny cases are the whole point, so a single happy-path test is close to worthless:

```go
func newTestHandler() http.Handler {
    next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    return AuthMiddleware(next)
}

func TestAuthMiddleware(t *testing.T) {
    tests := []struct {
        name   string
        header string
        want   int
    }{
        {"valid token", "Bearer valid-token", http.StatusOK},
        {"missing header", "", http.StatusUnauthorized},
        {"wrong scheme", "Basic abc123", http.StatusUnauthorized},
        {"bearer with invalid token", "Bearer totally-forged", http.StatusUnauthorized},
        {"empty bearer token", "Bearer ", http.StatusUnauthorized},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := httptest.NewRequest("GET", "/", nil)
            if tt.header != "" {
                req.Header.Set("Authorization", tt.header)
            }
            rec := httptest.NewRecorder()

            newTestHandler().ServeHTTP(rec, req)

            if rec.Code != tt.want {
                t.Errorf("status = %d; want %d", rec.Code, tt.want)
            }
        })
    }
}
```

The extra rows are not padding. Consider a middleware that checks `strings.HasPrefix(auth, "Bearer ")` and then forwards the request without ever validating the token, a real and easy mistake. A test that only sends `Bearer valid-token` and asserts 200 passes against it:

```
--- PASS: TestAuthMiddleware_BookVersion
        happy-path-only test: PASSES against a middleware that validates nothing
```

The table catches it immediately, on exactly the rows a happy-path test omits:

```
--- FAIL: TestAuthMiddleware_Table/bearer,_INVALID_token
--- FAIL: TestAuthMiddleware_Table/empty_bearer_token
```

An authentication test that only proves valid credentials are accepted has verified the least interesting half of the contract. The half that keeps attackers out is the half you did not test.

Test each middleware's individual behavior, then test the full chain in integration tests.

### Staff Lens: HTTP Test Infrastructure

Every HTTP service should have a shared test helper for constructing test requests, asserting responses, and checking common headers. Without it, every test reinvents the assertion wheel. With it, tests are shorter and more consistent.

---
