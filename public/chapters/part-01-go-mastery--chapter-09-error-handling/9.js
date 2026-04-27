export default `## 9.8 Testing Errors

### Testing Error Returns

Tests for functions that return errors should verify both the error value and the function output under error conditions. Clear failure messages that include the received error aid debugging.

\`\`\`go
func TestGetUser_NotFound(t *testing.T) {
    repo := NewMockRepository()
    service := NewUserService(repo)

    _, err := service.GetUser(ctx, "nonexistent")

    if err == nil {
        t.Fatal("expected error, got nil")
    }

    if !errors.Is(err, ErrNotFound) {
        t.Errorf("expected ErrNotFound, got %v", err)
    }
}
\`\`\`

### Testing Error Types

When testing functions that return typed errors, use \`errors.As\` to unwrap the error chain and assert the concrete error type. This decouples tests from the exact wrapping depth.

\`\`\`go
func TestValidate_InvalidEmail(t *testing.T) {
    err := Validate(User{Email: "invalid"})

    var appErr *AppError
    if !errors.As(err, &appErr) {
        t.Fatalf("expected *AppError, got %T", err)
    }

    if appErr.Code != CodeInvalidArgument {
        t.Errorf("expected code %s, got %s", CodeInvalidArgument, appErr.Code)
    }

    if len(appErr.Details) == 0 {
        t.Error("expected error details")
    }

    found := false
    for _, d := range appErr.Details {
        if d.Field == "email" {
            found = true
            break
        }
    }
    if !found {
        t.Error("expected email field in error details")
    }
}
\`\`\`

### Table-Driven Error Tests

Table-driven tests for error paths enumerate every error condition and its expected outcome, making it easy to add new cases and spot missing coverage.

\`\`\`go
func TestUserService_Create(t *testing.T) {
    tests := []struct {
        name        string
        input       CreateUserRequest
        wantErr     bool
        wantErrCode ErrorCode
    }{
        {
            name:    "valid user",
            input:   CreateUserRequest{Name: "John", Email: "john@example.com"},
            wantErr: false,
        },
        {
            name:        "empty name",
            input:       CreateUserRequest{Name: "", Email: "john@example.com"},
            wantErr:     true,
            wantErrCode: CodeInvalidArgument,
        },
        {
            name:        "invalid email",
            input:       CreateUserRequest{Name: "John", Email: "invalid"},
            wantErr:     true,
            wantErrCode: CodeInvalidArgument,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            service := NewUserService(NewMockRepository())

            _, err := service.Create(context.Background(), tt.input)

            if (err != nil) != tt.wantErr {
                t.Errorf("Create() error = %v, wantErr %v", err, tt.wantErr)
                return
            }

            if tt.wantErr {
                var appErr *AppError
                if !errors.As(err, &appErr) {
                    t.Errorf("expected *AppError, got %T", err)
                    return
                }
                if appErr.Code != tt.wantErrCode {
                    t.Errorf("error code = %s, want %s", appErr.Code, tt.wantErrCode)
                }
            }
        })
    }
}
\`\`\`

### Error Test Helpers

Custom test helpers for error assertions reduce boilerplate and produce informative failure messages that include the expected error type, the actual error, and the full chain.

\`\`\`go
// testutil/errors.go
package testutil

import (
    "errors"
    "testing"
)

func AssertError(t *testing.T, err error) {
    t.Helper()
    if err == nil {
        t.Error("expected error, got nil")
    }
}

func AssertNoError(t *testing.T, err error) {
    t.Helper()
    if err != nil {
        t.Errorf("unexpected error: %v", err)
    }
}

func AssertErrorIs(t *testing.T, err, target error) {
    t.Helper()
    if !errors.Is(err, target) {
        t.Errorf("expected error %v, got %v", target, err)
    }
}

func AssertErrorAs[T error](t *testing.T, err error) T {
    t.Helper()
    var target T
    if !errors.As(err, &target) {
        t.Fatalf("expected error type %T, got %T: %v", target, err, err)
    }
    return target
}

func AssertErrorCode(t *testing.T, err error, code ErrorCode) {
    t.Helper()
    appErr := AssertErrorAs[*AppError](t, err)
    if appErr.Code != code {
        t.Errorf("expected error code %s, got %s", code, appErr.Code)
    }
}

func AssertErrorContains(t *testing.T, err error, substr string) {
    t.Helper()
    if err == nil {
        t.Fatal("expected error, got nil")
    }
    if !strings.Contains(err.Error(), substr) {
        t.Errorf("error %q does not contain %q", err.Error(), substr)
    }
}
\`\`\`

### Testing Panic Recovery

Testing that a function correctly recovers from panics requires calling it from a test that has its own deferred recover, or using a helper that wraps the call and asserts the panic value.

\`\`\`go
func TestHandler_PanicRecovery(t *testing.T) {
    handler := recoveryMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        panic("test panic")
    }))

    req := httptest.NewRequest("GET", "/", nil)
    rec := httptest.NewRecorder()

    // Should not panic
    handler.ServeHTTP(rec, req)

    if rec.Code != http.StatusInternalServerError {
        t.Errorf("expected status 500, got %d", rec.Code)
    }
}

func TestMust_Panics(t *testing.T) {
    defer func() {
        if r := recover(); r == nil {
            t.Error("expected panic")
        }
    }()

    _ = must(0, errors.New("test error"))
}
\`\`\`

### Error Test Discipline

For a senior engineer reviewing tests:

1. **Use \`errors.Is\` in assertions, not string equality.** String matching is fragile to wrapping changes.
2. **Test the error path as carefully as the success path.** The error case is where bugs live.
3. **Include wrap-chain tests.** Verify that \`errors.Is(err, ErrFoo)\` works after the error crosses a wrap boundary.

---
`;
