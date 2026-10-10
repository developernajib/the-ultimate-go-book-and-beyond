## Section 1: Consumer-Driven Contract Testing with Pact

### 1.1 Consumer Side: Defining Expectations

Consumer-driven contracts let the *consumer* service define what it expects from a *provider*. The provider then runs verification against those expectations. The consumer test below uses Pact's mock HTTP server to record an interaction: the `OrderService` sends a charge request to the `PaymentService` and expects a `201 Created` response with a `charge_id`. When this test passes, Pact writes a JSON contract file to the `pacts/` directory that the provider team can verify independently. The `matchers.Like()` calls specify that the response structure and types must match while the exact values can differ, which keeps the contract flexible enough to survive value changes but strict enough to catch structural regressions.

Note the shape of the `pact-go` v2 DSL, because it changed from v1. `WithRequest` now takes a method and a path followed by a builder closure, and `WillRespondWith` takes a status code followed by a builder closure. The v1 style that passed a populated `consumer.Request` struct to `WithRequest` no longer compiles against v2. If you are porting older examples from a blog post, this is the first thing that will break.

```go
// consumer/payment_client_test.go
package consumer_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/pact-foundation/pact-go/v2/consumer"
	"github.com/pact-foundation/pact-go/v2/matchers"
)

// PaymentClient is the client under test. It calls the Payment service.
type PaymentClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

// ChargeRequest is the request body.
type ChargeRequest struct {
	OrderID     string `json:"order_id"`
	AmountCents int64  `json:"amount_cents"`
	Currency    string `json:"currency"`
}

// ChargeResponse is the response body.
type ChargeResponse struct {
	ChargeID    string `json:"charge_id"`
	Status      string `json:"status"`
	AmountCents int64  `json:"amount_cents"`
}

// Charge calls the Payment service to process a charge.
func (c *PaymentClient) Charge(req ChargeRequest) (*ChargeResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	resp, err := c.HTTPClient.Post(
		c.BaseURL+"/v1/charges",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result ChargeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

// TestOrderServiceChargesPayment defines the consumer contract.
func TestOrderServiceChargesPayment(t *testing.T) {
	// Create a new Pact consumer
	pact, err := consumer.NewV2Pact(consumer.MockHTTPProviderConfig{
		Consumer: "OrderService",
		Provider: "PaymentService",
		PactDir:  "./pacts",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Define interaction: "when creating a charge, expect 201 with charge_id".
	// pact-go v2 uses a builder DSL: WithRequest takes the method and path,
	// then a closure that fills in headers and body.
	pact.
		AddInteraction().
		Given("payment service is available").
		UponReceiving("a valid charge request from order service").
		WithRequest("POST", "/v1/charges", func(b *consumer.V2RequestBuilder) {
			b.Header("Content-Type", matchers.String("application/json"))
			b.JSONBody(matchers.Map{
				"order_id":     matchers.Like("order-123"),
				"amount_cents": matchers.Like(9999),
				"currency":     matchers.String("USD"),
			})
		}).
		WillRespondWith(http.StatusCreated, func(b *consumer.V2ResponseBuilder) {
			b.Header("Content-Type", matchers.String("application/json"))
			b.JSONBody(matchers.Map{
				"charge_id":    matchers.Like("ch_abc123"),
				"status":       matchers.Term("succeeded", "succeeded|pending|failed"),
				"amount_cents": matchers.Like(9999),
			})
		})

	// Execute the test against the Pact mock server
	err = pact.ExecuteTest(t, func(config consumer.MockServerConfig) error {
		client := &PaymentClient{
			BaseURL:    fmt.Sprintf("http://%s:%d", config.Host, config.Port),
			HTTPClient: &http.Client{Timeout: 5 * time.Second},
		}

		resp, err := client.Charge(ChargeRequest{
			OrderID:     "order-123",
			AmountCents: 9999,
			Currency:    "USD",
		})
		if err != nil {
			return fmt.Errorf("charge failed: %w", err)
		}
		if resp.ChargeID == "" {
			return fmt.Errorf("empty charge_id in response")
		}
		if resp.Status != "succeeded" {
			return fmt.Errorf("unexpected status: %s", resp.Status)
		}
		return nil
	})

	if err != nil {
		t.Fatal(err)
	}
}
```

### 1.2 Provider Side: Verifying the Contract

Provider-side contract verification replays the consumer's recorded interactions against the real provider implementation, asserting that the provider satisfies every expectation the consumer has published. This verification runs as part of the provider's CI pipeline, blocking deployments that would break existing consumers without requiring any coordination between teams. The provider test below configures a Pact verifier to fetch the consumer contract from a Pact Broker, start the service in a test server, and replay each interaction with the state setup functions that put the provider database into the required preconditions.

```go
// provider/payment_provider_test.go
package provider_test

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pact-foundation/pact-go/v2/models"
	"github.com/pact-foundation/pact-go/v2/provider"
)

// startPaymentServer starts the real Payment service for contract verification.
func startPaymentServer() *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/charges", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			OrderID     string `json:"order_id"`
			AmountCents int64  `json:"amount_cents"`
			Currency    string `json:"currency"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}

		// Validate
		if req.OrderID == "" || req.AmountCents <= 0 {
			http.Error(w, "invalid request", http.StatusUnprocessableEntity)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"charge_id":    "ch_" + generateID(),
			"status":       "succeeded",
			"amount_cents": req.AmountCents,
		})
	})
	return httptest.NewServer(mux)
}

func generateID() string {
	return fmt.Sprintf("%08x", rand.Uint32())
}

// TestPaymentServiceContractVerification verifies against consumer contracts.
func TestPaymentServiceContractVerification(t *testing.T) {
	srv := startPaymentServer()
	defer srv.Close()

	verifier := provider.NewVerifier()

	err := verifier.VerifyProvider(t, provider.VerifyRequest{
		ProviderBaseURL: srv.URL,
		Provider:        "PaymentService",

		// In CI, fetch from Pact Broker instead:
		// BrokerURL: "https://broker.pact.io",
		// BrokerToken: os.Getenv("PACT_BROKER_TOKEN"),
		// PublishVerificationResults: true,

		// For local testing, load from filesystem
		PactURLs: []string{"./pacts/OrderService-PaymentService.json"},

		// StateHandlers set up pre-conditions for each "Given" state.
		// The handler types live in the models package, not provider.
		StateHandlers: models.StateHandlers{
			"payment service is available": func(setup bool, s models.ProviderState) (models.ProviderStateResponse, error) {
				// setup is true before the interaction, false after it
				if setup {
					// Initialize any test state needed,
					// for example insert test data into the DB
				}
				return models.ProviderStateResponse{}, nil
			},
		},

		// RequestFilter can add auth headers if required
		RequestFilter: func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Add test-only auth bypass
				r.Header.Set("X-Test-Auth", "bypass")
				next.ServeHTTP(w, r)
			})
		},
	})

	if err != nil {
		t.Fatal(err)
	}
}
```

### 1.3 OpenAPI Contract Testing

When you own both the consumer and provider, OpenAPI-based contract testing can be simpler than Pact. Instead of publishing contracts through a broker, you validate every HTTP request and response against an OpenAPI specification file at test time. The `kin-openapi` library parses the spec, builds a router from it, and provides filter functions that check request parameters, body schemas, and response shapes. If your API handler returns a field with the wrong type or omits a required header, the validation middleware catches it immediately. This approach works best for internal APIs where a single team controls the spec and both implementations.

```go
package apicontract_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

// OpenAPIValidator validates HTTP requests and responses against an OpenAPI spec.
type OpenAPIValidator struct {
	router routers.Router // the Router interface lives in routers, not openapi3filter
	spec   *openapi3.T
}

// NewOpenAPIValidator loads and compiles an OpenAPI spec file.
func NewOpenAPIValidator(specPath string) (*OpenAPIValidator, error) {
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(specPath)
	if err != nil {
		return nil, fmt.Errorf("load spec %s: %w", specPath, err)
	}

	if err := doc.Validate(loader.Context); err != nil {
		return nil, fmt.Errorf("validate spec: %w", err)
	}

	router, err := gorillamux.NewRouter(doc)
	if err != nil {
		return nil, fmt.Errorf("create router: %w", err)
	}

	return &OpenAPIValidator{router: router, spec: doc}, nil
}

// ValidateRequest checks that an http.Request matches the spec.
func (v *OpenAPIValidator) ValidateRequest(t *testing.T, req *http.Request) {
	t.Helper()
	route, pathParams, err := v.router.FindRoute(req)
	if err != nil {
		t.Errorf("route not found for %s %s: %v", req.Method, req.URL.Path, err)
		return
	}

	input := &openapi3filter.RequestValidationInput{
		Request:    req,
		PathParams: pathParams,
		Route:      route,
		Options: &openapi3filter.Options{
			AuthenticationFunc: openapi3filter.NoopAuthenticationFunc,
		},
	}

	if err := openapi3filter.ValidateRequest(req.Context(), input); err != nil {
		t.Errorf("request does not conform to spec: %v", err)
	}
}

// ValidateResponse checks that an http.Response matches the spec.
func (v *OpenAPIValidator) ValidateResponse(t *testing.T, req *http.Request, resp *http.Response) {
	t.Helper()
	route, pathParams, err := v.router.FindRoute(req)
	if err != nil {
		t.Errorf("route not found: %v", err)
		return
	}

	// Buffer response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Errorf("read response body: %v", err)
		return
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))

	input := &openapi3filter.RequestValidationInput{
		Request:    req,
		PathParams: pathParams,
		Route:      route,
	}
	responseInput := &openapi3filter.ResponseValidationInput{
		RequestValidationInput: input,
		Status:                 resp.StatusCode,
		Header:                 resp.Header,
		Body:                   io.NopCloser(bytes.NewReader(body)),
		Options: &openapi3filter.Options{
			IncludeResponseStatus: true,
		},
	}

	if err := openapi3filter.ValidateResponse(req.Context(), responseInput); err != nil {
		t.Errorf("response does not conform to spec: %v", err)
	}
}

// ValidatingMiddleware wraps an HTTP handler with automatic spec validation.
func (v *OpenAPIValidator) ValidatingMiddleware(t *testing.T, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Helper()
		v.ValidateRequest(t, r)

		rec := httptest.NewRecorder()
		next.ServeHTTP(rec, r)

		// Copy headers to real writer
		for k, vals := range rec.Header() {
			for _, val := range vals {
				w.Header().Add(k, val)
			}
		}
		w.WriteHeader(rec.Code)
		w.Write(rec.Body.Bytes())

		// Validate response
		resp := rec.Result()
		resp.Body = io.NopCloser(bytes.NewReader(rec.Body.Bytes()))
		v.ValidateResponse(t, r, resp)
	})
}

// TestAPIConformsToSpec runs a suite of requests through spec validation.
func TestAPIConformsToSpec(t *testing.T) {
	const specPath = "../openapi.yaml"

	// Skip only when the spec is genuinely absent. Every other error
	// (malformed YAML, invalid spec, router build failure) must fail the
	// test. Skipping on any error is how a conformance suite quietly stops
	// testing anything while CI stays green.
	if _, err := os.Stat(specPath); errors.Is(err, os.ErrNotExist) {
		t.Skipf("no OpenAPI spec at %s, skipping conformance suite", specPath)
	}

	validator, err := NewOpenAPIValidator(specPath)
	if err != nil {
		t.Fatalf("load OpenAPI spec: %v", err)
	}

	handler := setupRealHandler()
	srv := httptest.NewServer(validator.ValidatingMiddleware(t, handler))
	defer srv.Close()

	client := srv.Client()

	// Table of API operations to test
	cases := []struct {
		name   string
		method string
		path   string
		body   string
		wantStatus int
	}{
		{
			name:       "create user",
			method:     "POST",
			path:       "/v1/users",
			body:       `{"name":"Alice","email":"alice@example.com"}`,
			wantStatus: 201,
		},
		{
			name:       "get user not found",
			method:     "GET",
			path:       "/v1/users/nonexistent",
			wantStatus: 404,
		},
		{
			name:       "list users",
			method:     "GET",
			path:       "/v1/users?page=1&limit=10",
			wantStatus: 200,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyReader io.Reader
			if tc.body != "" {
				bodyReader = strings.NewReader(tc.body)
			}

			req, err := http.NewRequest(tc.method, srv.URL+tc.path, bodyReader)
			if err != nil {
				t.Fatal(err)
			}
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}

			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != tc.wantStatus {
				t.Errorf("want status %d, got %d", tc.wantStatus, resp.StatusCode)
			}
		})
	}
}

// setupRealHandler returns the actual API handler.
func setupRealHandler() http.Handler {
	mux := http.NewServeMux()
	// Register real handlers...
	return mux
}
```

> **Senior track**: Pact and OpenAPI answer different questions. Pact captures *what a specific consumer actually uses*, which is the right abstraction across teams that release independently. OpenAPI captures *what the provider offers in full*, which fits internal APIs with a single owner. When both consumers and providers live in one monorepo, OpenAPI + `kin-openapi` validation is usually enough. Across organizational boundaries, where you cannot force consumers to upgrade in lockstep, Pact's broker, `can-i-deploy`, and WIP pacts pay for themselves. PactFlow (the commercial broker) also offers bi-directional contract testing, where the provider publishes an OpenAPI spec, the consumer publishes a pact, and the broker cross-verifies the two without running provider verification against a live provider. That is a genuine middle path, but it verifies the spec rather than the running implementation, so it is only as good as the provider's spec-to-code fidelity.

### 1.4 Matcher discipline: strict vs flexible

Pact matchers are the single most misused feature in consumer-side contracts. Too strict (exact-value matching) and the contract fails every time the provider changes a timestamp or a generated ID, turning contract verification into a noisy alert. Too loose (matching only the top-level shape) and the contract fails to catch real regressions like a field being renamed or a type changing from string to integer. The right bar: match field names and types exactly, match values only where the value itself is part of the contract (status enums, known URL patterns, currency codes). Use `matchers.Like()` for typical values where any instance of that type would be valid, `matchers.Term()` for values that must match a regex (IDs, timestamps, enums), and `matchers.EachLike()` for arrays where every element has the same shape. A good heuristic: if the same consumer test would pass tomorrow against a provider that returned a different charge ID and a different amount but the same structure, your matchers are calibrated correctly. If a new generated ID breaks the test, you are over-specifying. The exception is the small set of values your consumer actually branches on, such as a `status` enum, where the value genuinely is part of the contract and `Term` should pin it to the allowed set.

### 1.5 Junior → FAANG: your first Pact test, step by step

If you have never written a Pact test, walk through this six-step sequence once end-to-end. Step one: pick an HTTP client you have written that calls another service, something small. Step two: write a consumer test following the template in section 1.1, with matchers calibrated per section 1.4. Step three: run the test locally, see the pact file generated in `./pacts`. Step four: on the provider side, write the verification test following section 1.2 and point it at your local pact file. Step five: run verification, confirm it passes. Step six: deliberately break either side (rename a field on the provider, change a header on the consumer) and watch verification fail. That sixth step is where the pattern clicks. You are not just writing tests, you are operating a two-party contract. Once you have done this once, every subsequent Pact adoption is mechanical.

### 1.6 Senior @ FAANG: the broker as a platform service

A Pact broker is a platform artifact, not a team one. Three implications. First, pick who hosts it and who owns its uptime. A broker outage blocks every contract verification, so the owner must be on-call for it. A hosted broker such as PactFlow is the pragmatic default, since the open-source Pact Broker is another stateful service to run and patch. Self-hosting is worth the tax mainly for data-sovereignty requirements or when you have a platform team that already runs this class of service. Second, document the contract tagging and versioning conventions. What does `prod`, `main`, and `feature/foo` tag mean in your broker, and what do `can-i-deploy` queries do with them. Without written conventions, teams mis-tag and verification results become unreliable. Third, put `can-i-deploy` into the deploy pipeline as a hard gate. The whole point of contract testing is that it answers the deploy question automatically. If a team's deploy does not check `can-i-deploy`, they are paying the testing cost without collecting the deployment benefit. The platform's job is to make the gate mandatory and unremarkable.

---
