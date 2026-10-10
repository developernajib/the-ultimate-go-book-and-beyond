## 29.9 Testing Web Services

### Handler Testing

Go's `httptest` package creates in-memory request/response pairs without opening a real network connection. Use `httptest.NewRequest` to build a request and `httptest.NewRecorder` to capture the response. Table-driven tests enumerate input/output pairs, making it straightforward to cover valid payloads, validation failures, and edge cases in a single test function.

```go
package handlers_test

import (
    "bytes"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
)

func TestCreateUser(t *testing.T) {
    // Setup
    store := NewMockUserStore()
    handler := NewUserHandler(store)

    tests := []struct {
        name       string
        body       any
        wantStatus int
    }{
        {
            name: "valid user",
            body: map[string]any{
                "name":     "John Doe",
                "email":    "john@example.com",
                "password": "SecurePass123",
            },
            wantStatus: http.StatusCreated,
        },
        {
            name: "invalid email",
            body: map[string]any{
                "name":     "John Doe",
                "email":    "invalid-email",
                "password": "SecurePass123",
            },
            wantStatus: http.StatusBadRequest,
        },
        {
            name:       "empty body",
            body:       nil,
            wantStatus: http.StatusBadRequest,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            var body bytes.Buffer
            if tt.body != nil {
                json.NewEncoder(&body).Encode(tt.body)
            }

            req := httptest.NewRequest("POST", "/users", &body)
            req.Header.Set("Content-Type", "application/json")
            rec := httptest.NewRecorder()

            handler.ServeHTTP(rec, req)

            if rec.Code != tt.wantStatus {
                t.Errorf("got status %d, want %d", rec.Code, tt.wantStatus)
            }
        })
    }
}
```

### Integration Testing

Integration tests start a real HTTP server using `httptest.NewServer`, which binds to a random available port and returns a base URL. The test client makes actual HTTP calls against this server, exercising the full middleware stack, routing, and handler chain. This catches wiring bugs, like a missing route or misconfigured middleware, that unit tests on individual handlers miss.

```go
package main_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "strings"
    "testing"
)

func TestAPIIntegration(t *testing.T) {
    // Setup server
    app := NewApp()
    server := httptest.NewServer(app.Router())
    defer server.Close()

    client := server.Client()

    // Test flow: Create user, get user, update user
    t.Run("create and get user", func(t *testing.T) {
        // Create
        createResp, err := client.Post(
            server.URL+"/api/users",
            "application/json",
            strings.NewReader(`{"name":"John","email":"john@test.com","password":"Secret123"}`),
        )
        if err != nil {
            t.Fatal(err)
        }
        defer createResp.Body.Close()

        if createResp.StatusCode != http.StatusCreated {
            t.Fatalf("create status = %d; want %d", createResp.StatusCode, http.StatusCreated)
        }

        var user User
        json.NewDecoder(createResp.Body).Decode(&user)

        // Get
        getResp, err := client.Get(server.URL + "/api/users/" + user.ID)
        if err != nil {
            t.Fatal(err)
        }
        defer getResp.Body.Close()

        if getResp.StatusCode != http.StatusOK {
            t.Fatalf("get status = %d; want %d", getResp.StatusCode, http.StatusOK)
        }
    })
}
```

### Junior to FAANG: Writing HTTP Tests That Actually Catch Bugs

Three failure modes of typical handler tests. First, asserting only status code misses response-body regressions. Add body assertions. Second, using a mock store that always succeeds misses all the error paths. Write table entries that inject store errors. Third, running handlers without the real middleware stack misses auth, rate-limit, and CORS bugs. Always integration-test through the full router.

Worked example, asserting the response envelope too.

```go
var resp struct{ Data User `json:"data"` }
_ = json.NewDecoder(rec.Body).Decode(&resp)
if resp.Data.Email != "john@example.com" {
    t.Errorf("email = %q", resp.Data.Email)
}
```

Fuzz testing handlers. `go test -fuzz .` on a handler that accepts JSON catches panic-on-invalid-input bugs that unit tests never see. Add one fuzz test per POST/PUT endpoint.

Interview framing. "How do you test middleware." Build a `httptest.Server` with the middleware chain plus a known handler (echoes request state). Assert the server's response reflects what the middleware did. Never test middleware in isolation, always in the chain, because ordering is the bug surface.

Race detector. `go test -race ./...` in CI is non-negotiable. Shared state in middleware or Hub is the most common source of flaky tests. Fix every race, never ignore.

### Senior at FAANG: Testing as Release-Gate Infrastructure

Testing pyramid at FAANG scale. Unit tests (pure business logic, 70 percent of test suite by count, runs in seconds). Handler tests (httptest, 20 percent, runs in tens of seconds). Integration tests (real service with test dependencies via testcontainers, 8 percent, runs in minutes). End-to-end tests (full deployed environment, 2 percent, runs in tens of minutes). Contract tests (schema registry, generated from OpenAPI or Protobuf, gates every deploy).

Contract testing. Every public endpoint has a schema. CI runs contract tests against a live PR environment, fails on schema drift. Clients and servers are generated from the same schema, so a breaking change in the server fails the client tests immediately. Tools, Pact, Schemathesis, Postman Newman for REST. Buf for Protobuf.

Integration-test infrastructure. testcontainers-go spins up Postgres, Redis, and Kafka in Docker for each test run. Avoid test suites that depend on shared staging environments, they flake, they serialize, they delay shipping. Each test creates its own isolated universe, tears it down on exit. Parallelize across Go test packages with `t.Parallel()`.

Load testing as CI. Run k6 or vegeta against the PR environment at 10 percent of production RPS. Fail the build on p99 latency regression (>10 percent from baseline) or error-rate regression (>0.1 percent). This catches N+1 queries, unbounded allocations, and lock contention before they hit production. Maintain the baseline as a versioned artifact per service.

Chaos testing. Once per month per service, inject faults (dependency 5xx, slow DB, packet loss) via the service mesh (Istio Fault Injection, Chaos Mesh) during off-peak hours on a canary pod. Assert SLOs hold. This is the only way to know your circuit breakers, timeouts, and retries are correctly configured.

Security testing. Every public endpoint runs through a ZAP baseline scan in CI. SAST via Semgrep or CodeQL on every PR. Dependency scans via Snyk or GitHub Advanced Security. Fuzz `net/http` boundary via OSS-Fuzz integration. All four are non-optional.

Property-based testing. Use `pgregory.net/rapid` for complex handlers, especially anything with state transitions (session lifecycle, payment flow). Generate sequences of operations, assert invariants hold. This is the single most useful testing technique nobody uses enough.

Test data management. Fixtures are versioned in the repo, loaded via testcontainers seed scripts. Never hard-code production data into tests (PII risk). Synthetic generators with `gofakeit` for scale testing.

Golden-file tests. For complex response shapes, snapshot the response JSON to `testdata/*.golden`, diff on test run. Regenerate on intentional changes with `go test -update`. This catches response-shape regressions that ad-hoc assertions miss, at the cost of being stricter than you sometimes want (teaches discipline).

Observability of tests. Emit test metrics (duration, flakiness) to a dashboard. Alert on flaky tests (nondeterministic failures). Own a "flaky test budget" per team, over-budget means ship-freeze. Flaky tests corrode trust faster than any other CI problem.

Test ownership model. Every test file has a CODEOWNER. Failing tests block merge for the owning team, never global. This prevents the "someone else's test is red, merge anyway" anti-pattern that eventually makes CI meaningless.

Staff archetype. The Test Platform Lead owns CI infrastructure, the contract-test framework, the load-test baseline tooling, and the flakiness dashboard. One of the most underrated roles for org productivity.

Multi-year roadmap. Year 1, land testcontainers, kill shared staging dependencies, achieve race-free green CI. Year 2, contract tests and schema-registry integration, load tests as PR gates. Year 3, chaos testing as quarterly game days, fuzz coverage on every public endpoint. Year 4, property-based tests on critical flows, golden-file discipline across the org.

---
