## Section 3: Service Integration Testing

### 3.1 HTTP Service Integration Test

HTTP service integration tests spin up the service under test as an `httptest.Server` with its real dependencies (database, cache) satisfied by testcontainers, verifying the complete request pipeline from JSON deserialization through business logic to database persistence and response serialization. Unlike unit tests that mock the database, these tests catch the bugs that live at integration points: unexpected transaction behavior, serialization mismatches between Go types and JSON, and authentication middleware interacting badly with downstream handlers. The test below covers the user registration endpoint with a real Postgres database, asserting both the HTTP response shape and the resulting database state.

```go
package integration_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// IntegrationTestSuite holds shared resources across integration tests.
type IntegrationTestSuite struct {
	srv    *httptest.Server
	client *http.Client
	db     *sql.DB
	ctx    context.Context
}

// Setup creates a fully-wired service with a real database.
func Setup(t *testing.T) *IntegrationTestSuite {
	t.Helper()
	ctx := context.Background()

	// Real Postgres
	pg := NewPostgresContainer(ctx, t)

	// Wire up the real service
	repo := &UserRepository{db: pg.DB}
	handler := NewUserHandler(repo)

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &IntegrationTestSuite{
		srv:    srv,
		client: srv.Client(),
		db:     pg.DB,
		ctx:    ctx,
	}
}

// POST sends a POST request and returns the response.
func (s *IntegrationTestSuite) POST(path string, body any) *http.Response {
	b, err := json.Marshal(body)
	if err != nil {
		panic(fmt.Sprintf("marshal body: %v", err))
	}
	req, _ := http.NewRequest("POST", s.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		panic(fmt.Sprintf("POST %s: %v", path, err))
	}
	return resp
}

// GET sends a GET request and returns the response.
func (s *IntegrationTestSuite) GET(path string) *http.Response {
	resp, err := s.client.Get(s.srv.URL + path)
	if err != nil {
		panic(fmt.Sprintf("GET %s: %v", path, err))
	}
	return resp
}

// DecodeJSON decodes the response body into v.
func DecodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

// AssertStatus fails the test if the response status doesn't match.
func AssertStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode != want {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Errorf("want status %d, got %d\nbody: %s", want, resp.StatusCode, body)
	}
}

// TestUserAPI_Integration tests the full user API flow.
func TestUserAPI_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}

	suite := Setup(t)

	t.Run("create user returns 201 with user data", func(t *testing.T) {
		resp := suite.POST("/v1/users", map[string]string{
			"email": "alice@example.com",
			"name":  "Alice",
		})
		AssertStatus(t, resp, http.StatusCreated)

		var created map[string]any
		DecodeJSON(t, resp, &created)

		if created["id"] == nil || created["id"] == "" {
			t.Error("expected non-empty id")
		}
		if created["email"] != "alice@example.com" {
			t.Errorf("want email=alice@example.com, got %v", created["email"])
		}
	})

	t.Run("duplicate email returns 409", func(t *testing.T) {
		suite.POST("/v1/users", map[string]string{
			"email": "bob@example.com",
			"name":  "Bob",
		})
		resp := suite.POST("/v1/users", map[string]string{
			"email": "bob@example.com",
			"name":  "Bob2",
		})
		AssertStatus(t, resp, http.StatusConflict)
	})

	t.Run("create then get user", func(t *testing.T) {
		resp := suite.POST("/v1/users", map[string]string{
			"email": "charlie@example.com",
			"name":  "Charlie",
		})
		AssertStatus(t, resp, http.StatusCreated)

		var created map[string]any
		DecodeJSON(t, resp, &created)
		userID := created["id"].(string)

		getResp := suite.GET("/v1/users/" + userID)
		AssertStatus(t, getResp, http.StatusOK)

		var fetched map[string]any
		DecodeJSON(t, getResp, &fetched)
		if fetched["email"] != "charlie@example.com" {
			t.Errorf("fetched wrong user: %v", fetched)
		}
	})

	t.Run("missing fields return 422", func(t *testing.T) {
		resp := suite.POST("/v1/users", map[string]string{
			"name": "Incomplete",
			// email missing
		})
		AssertStatus(t, resp, http.StatusUnprocessableEntity)
	})
}
```

### 3.2 Multi-Service Integration with Service Virtualization

When the service under test calls external services (payment processors, email providers, identity providers), service virtualization stubs those services with a controllable HTTP server that returns scripted responses. Unlike mocking at the Go interface level, service virtualization exercises the full HTTP client stack (retry logic, timeout handling, response deserialization) against a realistic server that can be configured to simulate slow responses, 500 errors, and network partitions.

You do not need a heavyweight tool for this. Dedicated virtualization products such as WireMock or mountebank earn their keep when non-Go teams share the stub definitions, or when you want to record and replay real traffic. For a Go test suite, roughly sixty lines of `net/http/httptest` gives you the same leverage with no extra process to manage, and it is what the harness below does.

Be precise about what this double is. A plain canned-response server is a **stub**: it feeds the system under test the inputs it needs and nothing more. The moment you record the incoming calls and assert on them, as `AssertCalledWith` does below, it becomes a **spy**. That distinction matters, because assertions on calls couple your test to the caller's implementation. Reach for the spy behavior only when the call itself is the thing you care about, such as proving a payment is charged exactly once.

```go
package integration_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// VirtualService simulates an external dependency with canned responses.
type VirtualService struct {
	server    *httptest.Server
	responses map[string]VirtualResponse
	calls     []RecordedCall
	mu        sync.Mutex
}

// VirtualResponse defines a canned response for a route.
type VirtualResponse struct {
	Status  int
	Body    any
	Headers map[string]string
	Delay   time.Duration
}

// RecordedCall logs a call to the virtual service.
type RecordedCall struct {
	Method    string
	Path      string
	Body      string
	Timestamp time.Time
}

// NewVirtualService creates a virtual service with configured routes.
func NewVirtualService(routes map[string]VirtualResponse) *VirtualService {
	vs := &VirtualService{
		responses: routes,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", vs.handleAll)

	vs.server = httptest.NewServer(mux)
	return vs
}

func (vs *VirtualService) handleAll(w http.ResponseWriter, r *http.Request) {
	key := r.Method + " " + r.URL.Path
	body, _ := io.ReadAll(r.Body)

	vs.mu.Lock()
	vs.calls = append(vs.calls, RecordedCall{
		Method:    r.Method,
		Path:      r.URL.Path,
		Body:      string(body),
		Timestamp: time.Now(),
	})
	resp, ok := vs.responses[key]
	vs.mu.Unlock()

	if !ok {
		http.Error(w, "not configured in virtual service", http.StatusNotImplemented)
		return
	}

	if resp.Delay > 0 {
		time.Sleep(resp.Delay)
	}

	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.Status)

	if resp.Body != nil {
		json.NewEncoder(w).Encode(resp.Body)
	}
}

// URL returns the base URL of the virtual service.
func (vs *VirtualService) URL() string { return vs.server.URL }

// Close stops the virtual service.
func (vs *VirtualService) Close() { vs.server.Close() }

// AssertCalledWith verifies the virtual service received specific calls.
func (vs *VirtualService) AssertCalledWith(t *testing.T, method, path string, times int) {
	t.Helper()
	vs.mu.Lock()
	count := 0
	for _, call := range vs.calls {
		if call.Method == method && call.Path == path {
			count++
		}
	}
	vs.mu.Unlock()

	if count != times {
		t.Errorf("expected %s %s to be called %d times, got %d", method, path, times, count)
	}
}

// TestOrderServiceWithVirtualPayment tests order processing with a virtual payment service.
func TestOrderServiceWithVirtualPayment(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test")
	}

	// Virtual payment service with canned responses
	paymentSvc := NewVirtualService(map[string]VirtualResponse{
		"POST /v1/charges": {
			Status: 201,
			Body: map[string]any{
				"charge_id":    "ch_test123",
				"status":       "succeeded",
				"amount_cents": 9999,
			},
		},
		"GET /v1/charges/ch_test123": {
			Status: 200,
			Body: map[string]any{
				"charge_id": "ch_test123",
				"status":    "succeeded",
			},
		},
	})
	defer paymentSvc.Close()

	// Wire order service to use virtual payment service
	pg := NewPostgresContainer(context.Background(), t)
	orderHandler := NewOrderHandler(pg.DB, paymentSvc.URL())
	orderSrv := httptest.NewServer(orderHandler)
	defer orderSrv.Close()

	client := orderSrv.Client()

	// Place an order
	resp, err := client.Post(
		orderSrv.URL+"/v1/orders",
		"application/json",
		strings.NewReader(`{"user_id":"user-123","items":[{"sku":"WIDGET","qty":1,"price_cents":9999}]}`),
	)
	if err != nil {
		t.Fatalf("place order: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 201, got %d: %s", resp.StatusCode, body)
	}

	var order map[string]any
	json.NewDecoder(resp.Body).Decode(&order)

	if order["status"] != "completed" {
		t.Errorf("want order status=completed, got %v", order["status"])
	}

	// Verify payment service was called exactly once
	paymentSvc.AssertCalledWith(t, "POST", "/v1/charges", 1)
}
```

> **Senior track**: `httptest.Server` is ideal when the service under test is a single Go process you can link into the test binary. It falls short when you need to test (a) TLS certificate validation paths, (b) real proxy/load-balancer behavior, (c) HTTP/2 trailers or gRPC streaming, (d) process crashes and restarts, or (e) DNS resolution. For those, reach for testcontainers-go and run the service itself in a container. The rule of thumb at FAANG: `httptest.Server` for collaborators within the bounded context, testcontainers for everything across a process boundary you do not own.

### 3.3 Fault injection in service integration tests

A service integration test that only verifies the happy path leaves most failure modes untested. The virtual service pattern in section 3.2 makes fault injection easy: configure the virtual collaborator to return 500 errors, time out, return malformed JSON, return a slow response, or return the wrong Content-Type, and assert that the service under test degrades correctly. Four categories worth covering. **Downstream slow path**: the virtual service delays response by 2 seconds. Does the caller's timeout fire? Does the caller retry? Does it fail fast with a meaningful error? **Downstream partial failure**: the virtual service returns 500 on 20 percent of requests. Does the caller retry with backoff? Does it circuit-break? **Downstream contract violation**: the virtual service returns a response with a missing required field. Does the caller handle it gracefully or crash? **Downstream disappearance**: the virtual service returns connection refused. Does the caller log usefully and return a degraded response, or propagate a raw error to the user? These four categories catch the bugs that actually cause incidents, and writing them once per downstream collaborator is a high-value investment.

### 3.4 Junior → FAANG: the "what happens if the downstream is slow?" discipline

For every HTTP client you write, ask and answer this question in a test: what happens if the downstream takes 5 seconds instead of 50 milliseconds? A surprising number of production incidents come from services that did not bound their downstream timeouts. Your test should set the virtual service to delay by 5 seconds, assert that the client either times out within its configured window (usually 1 to 2 seconds) or completes with a documented slow path. If neither happens, you have found a real bug. This one discipline, applied to every downstream call, is among the highest-yield testing habits you can build. It also gives you something concrete to say in an interview, because "I write a slow-downstream test for every HTTP client, and here is the unbounded timeout it caught" is a specific story rather than a recitation of principles.

### 3.5 Senior @ FAANG: the boundary-object testing policy

At staff level, articulate a policy for what must be tested at every service boundary. A reasonable default: each downstream HTTP client has (a) a happy-path integration test against a virtual collaborator, (b) a slow-path timeout test, (c) a retry-under-5xx test, (d) a malformed-response test, and (e) a contract test (Pact or OpenAPI) against the provider's published contract. Five tests per boundary is a manageable tax and catches the vast majority of real incidents. Codify this in the team's testing guide, enforce it in code review, and track coverage per boundary in a dashboard that leadership can read. Teams with this policy have predictable incident shapes and easy-to-understand post-mortems. Teams without it have a steady stream of "we didn't know the downstream could do that" incidents.

---
