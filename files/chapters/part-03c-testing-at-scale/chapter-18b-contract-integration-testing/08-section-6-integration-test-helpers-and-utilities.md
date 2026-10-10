## Section 6: Integration Test Helpers and Utilities

### 6.1 Test HTTP Server Wrapper

A reusable test HTTP server wrapper constructs the service under test with all real middleware, authentication, and routing configured, exposing a typed client that sends pre-authenticated requests to the server. This eliminates the per-test boilerplate of constructing test servers, setting authentication headers, and parsing response envelopes, allowing integration test bodies to focus on the scenario being verified. The wrapper below uses `httptest.NewServer` with the production router, injects test-scoped dependencies via options, and exposes helper methods for common assertion patterns.

```go
package testutil

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// TestServer wraps httptest.Server with a fluent request API.
type TestServer struct {
	*httptest.Server
	t      *testing.T
	client *http.Client
}

// NewTestServer creates a test server wrapping the given handler.
func NewTestServer(t *testing.T, handler http.Handler) *TestServer {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &TestServer{
		Server: srv,
		t:      t,
		client: srv.Client(),
	}
}

// Request is a fluent HTTP request builder.
type Request struct {
	method  string
	path    string
	body    any
	headers map[string]string
	srv     *TestServer
}

// Do executes the request and returns a Response.
func (req *Request) Do() *Response {
	req.srv.t.Helper()

	var body io.Reader
	if req.body != nil {
		b, err := json.Marshal(req.body)
		if err != nil {
			req.srv.t.Fatalf("marshal body: %v", err)
		}
		body = bytes.NewReader(b)
	}

	r, err := http.NewRequest(req.method, req.srv.URL+req.path, body)
	if err != nil {
		req.srv.t.Fatalf("new request: %v", err)
	}
	if req.body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range req.headers {
		r.Header.Set(k, v)
	}

	resp, err := req.srv.client.Do(r)
	if err != nil {
		req.srv.t.Fatalf("do request: %v", err)
	}

	return &Response{Response: resp, t: req.srv.t}
}

func (s *TestServer) Request(method, path string) *Request {
	return &Request{method: method, path: path, srv: s, headers: make(map[string]string)}
}

func (req *Request) WithBody(body any) *Request {
	req.body = body
	return req
}

func (req *Request) WithHeader(key, value string) *Request {
	req.headers[key] = value
	return req
}

// Response wraps http.Response with assertion helpers.
type Response struct {
	*http.Response
	t    *testing.T
	body []byte
	once sync.Once
}

func (r *Response) readBody() []byte {
	r.once.Do(func() {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			r.t.Fatalf("read body: %v", err)
		}
		r.body = b
		r.Body.Close()
		r.Body = io.NopCloser(bytes.NewReader(b))
	})
	return r.body
}

// AssertStatus asserts the response status code.
func (r *Response) AssertStatus(want int) *Response {
	r.t.Helper()
	if r.StatusCode != want {
		r.t.Errorf("want status %d, got %d\nbody: %s", want, r.StatusCode, r.readBody())
	}
	return r
}

// AssertJSONField asserts that a JSON field has a specific value.
func (r *Response) AssertJSONField(field string, want any) *Response {
	r.t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.readBody(), &m); err != nil {
		r.t.Fatalf("decode JSON: %v", err)
	}
	got, ok := m[field]
	if !ok {
		r.t.Errorf("field %q not in response: %v", field, m)
		return r
	}
	// encoding/json decodes every JSON number into a float64, so an int
	// literal in the test would never compare equal without this coercion.
	switch w := want.(type) {
	case int:
		want = float64(w)
	case int64:
		want = float64(w)
	}
	// reflect.DeepEqual rather than !=: comparing two `any` values with !=
	// panics at runtime when either side holds a map or a slice, which is
	// exactly what a nested JSON object decodes into.
	if !reflect.DeepEqual(got, want) {
		r.t.Errorf("field %q: want %v (%T), got %v (%T)", field, want, want, got, got)
	}
	return r
}

// DecodeJSON decodes the response body into v.
func (r *Response) DecodeJSON(v any) *Response {
	r.t.Helper()
	if err := json.Unmarshal(r.readBody(), v); err != nil {
		r.t.Fatalf("decode JSON: %v", err)
	}
	return r
}

// AssertBodyContains checks that the body contains the given string.
func (r *Response) AssertBodyContains(substr string) *Response {
	r.t.Helper()
	if !strings.Contains(string(r.readBody()), substr) {
		r.t.Errorf("body does not contain %q:\n%s", substr, r.readBody())
	}
	return r
}

// Example usage, in a _test.go file in the package under test.
// newUserHandler stands in for however your service builds its router.
func TestUserHandlerIntegration(t *testing.T) {
	srv := NewTestServer(t, newUserHandler(t))

	// Fluent API makes test intent clear
	srv.Request("POST", "/v1/users").
		WithBody(map[string]string{"email": "test@example.com", "name": "Test"}).
		Do().
		AssertStatus(http.StatusCreated).
		AssertJSONField("email", "test@example.com")

	srv.Request("GET", "/v1/users/nonexistent").
		Do().
		AssertStatus(http.StatusNotFound)
}
```

### 6.2 Test helpers are production code

A common anti-pattern is to treat `testutil` packages as second-class code: sloppy naming, duplicated logic, no code review, no documentation. This is a mistake that compounds. Test helpers are consumed by every test in the repo, which means a bug in a helper manifests as a bug in hundreds of tests. Review helpers with the same rigour as production code. Write tests for the helpers themselves where the logic is non-trivial. Document the intended usage and the parameters that matter. Name methods for what they assert, not for what they do mechanically (`AssertStatus` is good, `CheckCode` is ambiguous). Helpers that meet this bar become a durable team asset. Helpers that do not become an obstacle to every subsequent refactor.

### 6.3 Junior → FAANG: the fluent-API discipline

Fluent APIs in test code are not decoration. They are a forcing function for readable test intent. A test that reads:

```go
srv.Request("POST", "/v1/users").WithBody(payload).Do().AssertStatus(201).AssertJSONField("email", email)
```

tells the reader exactly what is being tested in one line. The same operations written imperatively sprawl across ten lines and bury the intent in boilerplate. When you write a test helper library, favour the fluent style. When you review tests, push back on imperative style. Readable tests are easier to maintain, easier to debug when they fail at 3 AM, and easier for a new engineer to understand. The investment in API design pays back every time someone reads the tests.

### 6.4 Senior @ FAANG: the shared testutil governance

At platform scale, testutil libraries are a cross-cutting artifact shared across many teams. Three staff-level concerns. First, ownership: who maintains the library, who reviews changes, who responds when it breaks a team's tests. Assign it to a team, not to a default "whoever last touched it" model. Second, versioning: treat the library as a semver-versioned dependency. Breaking changes announce themselves, teams upgrade on their schedule, and no team is surprised by a shared utility changing under them. Third, discoverability: a team-wide wiki page or runbook that tells new engineers "here is the test helper library, here is how to use it, here is where the tests live." Without discoverability, teams reinvent the same helpers locally and the library fragments. Teams with this governance have testing patterns that compound across the org. Teams without it end up with test code that looks different in every repo and has to be relearned on every context switch.

---
