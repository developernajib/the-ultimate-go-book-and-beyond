## 40.7 Validation Testing

### Validation Unit Tests

Table-driven tests verify each validation rule in isolation. Every test case specifies the input struct and a map of expected field-to-error-code pairs. The test runner calls `Validate`, converts the result into a map, and checks for exact agreement, with no extra errors and no missing errors.

```go
// ... package validation_test; import "testing"

func TestCreateUserInputValidation(t *testing.T) {
    tests := []struct {
        name     string
        input    CreateUserInput
        wantErrs map[string]string // field -> expected code
    }{
        {
            name: "valid input",
            input: CreateUserInput{
                Name:     "John Doe",
                Email:    "john@example.com",
                Password: "SecurePass123!",
                Username: "johndoe",
                Role:     "user",
            },
            wantErrs: nil,
        },
        {
            name: "missing required fields",
            input: CreateUserInput{},
            wantErrs: map[string]string{
                "name":     "REQUIRED",
                "email":    "REQUIRED",
                "password": "REQUIRED",
                "username": "REQUIRED",
                "role":     "REQUIRED",
            },
        },
        {
            name: "invalid email",
            input: CreateUserInput{
                Name:     "John Doe",
                Email:    "not-an-email",
                Password: "SecurePass123!",
                Username: "johndoe",
                Role:     "user",
            },
            wantErrs: map[string]string{
                "email": "INVALID_EMAIL",
            },
        },
        {
            name: "weak password",
            input: CreateUserInput{
                Name:     "John Doe",
                Email:    "john@example.com",
                Password: "weakpass", // No uppercase, number, special char
                Username: "johndoe",
                Role:     "user",
            },
            wantErrs: map[string]string{
                "password": "WEAK_PASSWORD",
            },
        },
        {
            name: "invalid username",
            input: CreateUserInput{
                Name:     "John Doe",
                Email:    "john@example.com",
                Password: "SecurePass123!",
                Username: "John Doe", // Spaces not allowed
                Role:     "user",
            },
            wantErrs: map[string]string{
                "username": "INVALID_SLUG",
            },
        },
        {
            name: "invalid role",
            input: CreateUserInput{
                Name:     "John Doe",
                Email:    "john@example.com",
                Password: "SecurePass123!",
                Username: "johndoe",
                Role:     "superuser", // Not in allowed list
            },
            wantErrs: map[string]string{
                "role": "INVALID_VALUE",
            },
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            verrs := Validate(tt.input)

            if tt.wantErrs == nil {
                if len(verrs) > 0 {
                    t.Errorf("expected no errors, got %v", verrs)
                }
                return
            }

            errMap := make(map[string]string)
            for _, e := range verrs {
                errMap[e.Field] = e.Code
            }

            for field, wantCode := range tt.wantErrs {
                gotCode, ok := errMap[field]
                if !ok {
                    t.Errorf("expected error for field %s, got none", field)
                    continue
                }
                if gotCode != wantCode {
                    t.Errorf("field %s: expected code %s, got %s", field, wantCode, gotCode)
                }
            }

            for field := range errMap {
                if _, ok := tt.wantErrs[field]; !ok {
                    t.Errorf("unexpected error for field %s", field)
                }
            }
        })
    }
}
```

### Error Response Tests

Integration tests send HTTP requests through `httptest` and assert on the status code, error code, and field-level details in the JSON response. These tests cover the full path from raw request body to serialized error envelope, catching regressions in JSON decoding, validation, and response formatting.

```go
// ... package api_test; imports omitted for brevity

func TestCreateUserValidation(t *testing.T) {
    handler := setupUserHandler()

    tests := []struct {
        name           string
        body           string
        wantStatus     int
        wantCode       string
        wantFieldError string
    }{
        {
            name:       "empty body",
            body:       "",
            wantStatus: http.StatusBadRequest,
            wantCode:   "EMPTY_BODY",
        },
        {
            name:       "invalid JSON",
            body:       "{invalid}",
            wantStatus: http.StatusBadRequest,
            wantCode:   "INVALID_JSON",
        },
        {
            name:       "unknown field",
            body:       `{"name":"John","unknown_field":"value"}`,
            wantStatus: http.StatusBadRequest,
            wantCode:   "UNKNOWN_FIELD",
        },
        {
            name:           "missing email",
            body:           `{"name":"John","password":"SecurePass123!","username":"john","role":"user"}`,
            wantStatus:     http.StatusUnprocessableEntity,
            wantCode:       "VALIDATION_ERROR",
            wantFieldError: "email",
        },
        {
            name:           "invalid email format",
            body:           `{"name":"John","email":"not-email","password":"SecurePass123!","username":"john","role":"user"}`,
            wantStatus:     http.StatusUnprocessableEntity,
            wantCode:       "VALIDATION_ERROR",
            wantFieldError: "email",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            req := httptest.NewRequest(http.MethodPost, "/users", strings.NewReader(tt.body))
            req.Header.Set("Content-Type", "application/json")
            rec := httptest.NewRecorder()

            handler.ServeHTTP(rec, req)

            if rec.Code != tt.wantStatus {
                t.Errorf("status = %d, want %d", rec.Code, tt.wantStatus)
            }

            var resp APIError
            if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
                t.Fatalf("failed to decode response: %v", err)
            }

            if resp.Code != tt.wantCode {
                t.Errorf("code = %s, want %s", resp.Code, tt.wantCode)
            }

            if tt.wantFieldError != "" {
                found := false
                for _, detail := range resp.Details {
                    if detail.Field == tt.wantFieldError {
                        found = true
                        break
                    }
                }
                if !found {
                    t.Errorf("expected field error for %s, got %v", tt.wantFieldError, resp.Details)
                }
            }
        })
    }
}
```

### Junior → FAANG: Prerequisites and Worked Example

Start with the Go testing basics that the snippets above take for granted. `testing.T` is the handle that records failures. `t.Errorf` reports a failure and keeps running. `t.Fatalf` reports and stops the current test (but not siblings, because each subtest runs in its own goroutine under `t.Run`). Subtests via `t.Run(name, fn)` are how you get granular failure reporting on table-driven tests, and they let you use `go test -run 'TestX/invalid_email'` to target one case during debugging. The second prerequisite is `httptest.NewRecorder` and `httptest.NewRequest`. The recorder implements `http.ResponseWriter` and captures status, headers, and body in memory, so you never need a real socket. The request is constructed entirely in-process with `strings.NewReader` for the body. That means a full request-to-response test round trip runs in microseconds and is safe to run with `-race`. The third prerequisite is that `json.NewDecoder(rec.Body).Decode(&resp)` consumes the recorder's body buffer, so you cannot decode it twice. If you need to inspect the raw bytes and also unmarshal, call `rec.Body.Bytes()` first and then pass the byte slice to `json.Unmarshal`.

Why table-driven tests specifically, rather than writing one test per case? Two reasons. The test table doubles as documentation of the contract. A new engineer reading `TestCreateUserInputValidation` can enumerate every expected failure mode in 30 seconds because all cases sit in one slice. And when the validation rule changes, the diff shows exactly which contract moved. The anti-pattern is shared mutable state between cases. In the snippets above, each case builds its own `CreateUserInput` literal, so there is no possibility of one case corrupting another. If you ever find yourself writing `setup()` that mutates a shared struct across table entries, split the tests back out or deep-copy per iteration.

Worked example. A PR adds a new field `PhoneNumber` to `CreateUserInput` with a `required` tag. The author ran `go test ./...` and everything passed. On merge, the staging deploy starts returning 422 for all legitimate create-user requests because the existing mobile client does not send `PhoneNumber`. Root cause: the table-driven test named "valid input" never included `PhoneNumber`, and because the new field was required, the "valid input" case should have started failing. It did not, because the developer updated both the struct and the test literal in the same commit, silently papering over the breaking change. Lesson: the contract test for "valid input" must be frozen at the public API boundary, not co-edited with struct changes. The senior fix is a separate golden-file test that posts a canonical body captured from production logs (with PII scrubbed) and asserts 201, protected by a code-owner review gate that flags any change.

Interview entry-points. What is the difference between `httptest.NewServer` and `httptest.NewRecorder`? The server starts a real loopback TCP listener and is the right choice when you need middleware that calls `http.Hijacker` or when you are testing a real client library. The recorder is in-memory and strictly faster for pure handler tests. When do you need `t.Parallel()`? When subtests are independent and you want them to run concurrently for speed, but only if they do not share mutable state, which in practice means no `t.Setenv` and no shared database fixture. How do you test a handler that depends on the clock? Inject a clock interface (`Clock.Now() time.Time`) rather than calling `time.Now()` directly, then substitute a fake in tests. Controlling time is the single highest-ROI refactor for making handler tests deterministic.

### Senior @ FAANG: Test Strategy for Validation at Platform Scale

At staff level, validation testing splits into four disciplines that together produce a reliable API surface: table-driven contract tests, property-based tests for invariants, fuzz tests for parser robustness, and contract tests against the OpenAPI or gRPC schema. Each catches a different class of bug. Treating them as interchangeable is the most common mistake even on senior teams.

Table-driven contract tests are what the snippets above show. Their purpose is to lock the observable error codes and field names that clients depend on. At scale you extract the table into a YAML or JSON fixture file so that the same table can drive tests in Go, generate documentation, and be compared across service versions for contract drift detection. The key discipline is that the fixture is reviewed separately from the handler code, often by an API review council. Changes to the fixture require a compatibility analysis: adding a new error code is backwards-compatible, removing one or changing an existing code's status is a breaking change that must go through deprecation. Without this separation, every validator refactor silently breaks downstream clients.

Property-based testing via `pgregory.net/rapid` catches the cases table-driven tests miss. The standard library ships `testing/quick`, but it is frozen and explicitly not accepting new features, and it does not shrink failures, which is why rapid is the common choice. You specify the property, not the examples. For example: "for all inputs that pass struct validation, re-serializing and re-parsing produces the same validation result." Rapid then generates inputs including edge cases you did not imagine, such as Unicode homoglyphs, RTL override characters, and strings at exactly the boundary of a UTF-8 BOM. This is exactly how unanchored-regex bugs surface: a validator whose pattern lacks `\A`/`\z` anchors happily accepts a value with a trailing right-to-left override appended, because the regex matched a prefix and never asserted it had consumed the whole string. A hand-written table almost never contains that input. A generator produces it quickly. Property tests also shrink failures automatically, so you get the minimal reproducing input rather than a 200-character blob.

Fuzz testing via Go's native `testing.F` is the right tool for parser robustness. You seed the corpus with valid inputs, and the fuzzer mutates bytes looking for inputs that panic, allocate excessive memory, or run indefinitely. For request body decoding, a fuzz target looks like `func FuzzDecodeJSONBody(f *testing.F) { f.Add(validJSON); f.Fuzz(func(t *testing.T, data []byte) { DecodeJSONBody(...) }) }`. Run in CI on a nightly schedule with `-fuzztime=10m` per target, commit the growing corpus to a sibling repo (not the main repo, to avoid bloat), and treat every new crasher as a P1 bug. The payoff is that fuzzing catches the JSON DoS vectors discussed in the body-validation section before they hit production. The operational challenge is that a bad fuzz commit can DoS the CI runner, so always cap memory per fuzz process with cgroup limits.

Contract testing against the OpenAPI specification detects schema drift between the server and the published API docs. Schemathesis is the tool that fits this job directly, since it works from the spec itself. Pact solves a related but different problem, consumer-driven contracts, where the expectations come from each consumer rather than from a spec, so reach for it when you need to know which clients depend on what, not to check the server against its own document. Schemathesis reads the spec, generates requests conforming to it, sends them to the running service, and asserts responses match the declared schemas. This catches three classes of bug that unit tests miss: an error code you added but forgot to document, a response field whose type drifted, and an endpoint that returns 500 on a payload the spec claims is valid. Wire Schemathesis into the pre-merge pipeline so it runs against an ephemeral instance of the service on each PR, not just in nightly. It costs a bounded slice of CI time per service, tunable via the number of generated examples per operation, and it pays for itself the first time it blocks a breaking change.

Snapshot testing of error responses is the underrated technique for catching accidental format changes. You post a known-bad request, capture the full error response as a file `testdata/error_empty_email.golden.json`, and on subsequent runs compare the response to the golden file. Any divergence fails the test. Update flow is `go test -update-golden`, which regenerates the file and surfaces the diff in the PR for human review. This catches subtle changes like field ordering (if your serializer is deterministic), timestamp format changes, and trace ID field name changes that would otherwise ship silently and break clients that parse with strict schemas. The discipline is the review gate on golden-file diffs. A thoughtless rubber-stamp defeats the mechanism.

Mutation testing of validation rules is the senior-only signal of test quality. Gremlins (`github.com/go-gremlins/gremlins`) introduces small semantic mutations to your source (flip `>=` to `>`, invert a boolean, replace a constant with 0) and reruns the test suite, reporting each mutant as KILLED, LIVED, or NOT COVERED. Every mutant that LIVED is a hole in your test suite: the code changed and no test noticed. Validation code is particularly amenable to this because it is dense with boundary conditions, which is precisely what mutation operators target. Running it on a schedule against the validation package and tracking the mutation score turns test maintenance from an afterthought into a tracked metric. Two caveats worth knowing before you adopt it: Gremlins is still pre-1.0, so its own flags and behavior can shift between releases, and its authors are explicit that it does not scale well to very large modules because a full run can take hours. That is also why you scope it to changed files on PRs and run the full package on a nightly or weekly cadence rather than on every push.

Finally, wire validation testing into production verification. A production smoke test, run every five minutes from a synthetic traffic generator, posts one known-bad payload of each error type and asserts the observed response shape matches the contract. This catches the class of failure where a config change, a reverse proxy rewrite, or a middleware reorder silently changes the error envelope. Combined with the SLO-driven alerting from the middleware section, you get bidirectional coverage: tests prove the code is correct at merge time, synthetic checks prove the deployed reality matches the code. The absence of either half is what allows a six-hour client outage to hide behind green dashboards.

---
