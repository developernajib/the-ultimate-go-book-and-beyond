## 13. Automated Regression Testing

Automated regression tests run continuously against the new service using production traffic snapshots to catch behavioral regressions before they reach users. Unlike unit tests that verify individual functions, regression tests verify that the new service produces the correct HTTP responses for known request patterns. The test suite below uses Go's `httptest.NewRecorder` to execute requests directly against the handler without a network round trip, making the tests fast and deterministic. Each test case specifies the expected status code and an optional validator function that inspects the response body for required fields or correct values. You can populate test cases from captured production traffic or hand-write them for critical business scenarios.

```go
// file: internal/regression/suite.go
package regression

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"time"
)

// TestCase represents a single regression test case.
type TestCase struct {
	Name           string
	Method         string
	Path           string
	RequestBody    any
	RequestHeaders map[string]string
	ExpectedStatus int
	Validator      func(body []byte) error
}

// TestResult records the outcome of a single regression test.
type TestResult struct {
	Name       string
	Passed     bool
	Duration   time.Duration
	StatusCode int
	Error      error
}

// Suite runs a battery of regression tests against a target handler.
type Suite struct {
	target http.Handler
	cases  []TestCase
	logger *slog.Logger
}

// NewSuite creates a regression suite targeting the given handler.
func NewSuite(target http.Handler, cases []TestCase, logger *slog.Logger) *Suite {
	return &Suite{
		target: target,
		cases:  cases,
		logger: logger,
	}
}

// Run executes all test cases and returns results.
func (s *Suite) Run(ctx context.Context) ([]TestResult, error) {
	results := make([]TestResult, 0, len(s.cases))
	for _, tc := range s.cases {
		select {
		case <-ctx.Done():
			return results, ctx.Err()
		default:
		}
		result := s.runCase(ctx, tc)
		results = append(results, result)
		s.logger.Info("regression test case",
			"name", tc.Name,
			"passed", result.Passed,
			"duration_ms", result.Duration.Milliseconds(),
			"status_code", result.StatusCode,
		)
	}
	return results, nil
}

// runCase executes a single regression test case.
func (s *Suite) runCase(ctx context.Context, tc TestCase) TestResult {
	start := time.Now()

	var bodyBytes []byte
	if tc.RequestBody != nil {
		var err error
		bodyBytes, err = json.Marshal(tc.RequestBody)
		if err != nil {
			return TestResult{Name: tc.Name, Error: fmt.Errorf("marshal request body: %w", err)}
		}
	}

	req, err := buildTestRequest(ctx, tc.Method, tc.Path, bodyBytes, tc.RequestHeaders)
	if err != nil {
		return TestResult{Name: tc.Name, Error: err}
	}

	w := httptest.NewRecorder()
	s.target.ServeHTTP(w, req)

	duration := time.Since(start)
	result := TestResult{
		Name:       tc.Name,
		StatusCode: w.Code,
		Duration:   duration,
	}

	if w.Code != tc.ExpectedStatus {
		result.Error = fmt.Errorf("expected status %d, got %d", tc.ExpectedStatus, w.Code)
		return result
	}

	if tc.Validator != nil {
		if err := tc.Validator(w.Body.Bytes()); err != nil {
			result.Error = fmt.Errorf("response validation: %w", err)
			return result
		}
	}

	result.Passed = true
	return result
}

// buildTestRequest constructs an *http.Request for use in tests.
func buildTestRequest(ctx context.Context, method, path string, body []byte, headers map[string]string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, path, nil)
	if err != nil {
		return nil, fmt.Errorf("build test request: %w", err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// Summary produces a pass/fail summary of test results.
func Summary(results []TestResult) (passed, failed int) {
	for _, r := range results {
		if r.Passed {
			passed++
		} else {
			failed++
		}
	}
	return
}

// UserServiceRegressionCases returns standard regression cases for a user service.
func UserServiceRegressionCases() []TestCase {
	return []TestCase{
		{
			Name:           "get user by ID returns 200",
			Method:         http.MethodGet,
			Path:           "/v2/users/user-123",
			ExpectedStatus: http.StatusOK,
			Validator: func(body []byte) error {
				var resp map[string]any
				if err := json.Unmarshal(body, &resp); err != nil {
					return fmt.Errorf("parse response: %w", err)
				}
				if resp["id"] == nil {
					return fmt.Errorf("missing field: id")
				}
				return nil
			},
		},
		{
			Name:           "get nonexistent user returns 404",
			Method:         http.MethodGet,
			Path:           "/v2/users/does-not-exist",
			ExpectedStatus: http.StatusNotFound,
		},
		{
			Name:   "create user returns 201",
			Method: http.MethodPost,
			Path:   "/v2/users",
			RequestBody: map[string]string{
				"email": "test@example.com",
				"name":  "Test User",
			},
			ExpectedStatus: http.StatusCreated,
		},
	}
}
```

### Junior → FAANG: Automated Regression Testing as the Migration Safety Net

Automated regression testing during migration is distinct from the unit and integration tests that verify the new service in isolation. Regression tests verify that the new service produces the same observable behavior as the legacy service from the perspective of external callers. They answer the question: can existing clients continue to operate without changes after the migration?

The `Validator` function in the `TestCase` struct is the key extensibility point in this implementation. For simple migrations, validating the HTTP status code is sufficient. For complex migrations where the response shape changes, the validator can parse the response body and check that required fields are present and semantically correct. Writing these validators forces you to explicitly enumerate the contract that the new service must maintain, which is exactly the analysis needed to define the migration's correctness criteria.

For Go engineers: the pattern of returning `TestCase` slices from factory functions (`UserServiceRegressionCases`) is correct for migration testing because it separates test definition from test execution. Test cases can be defined by the team that owns the API contract, executed by the migration team, and extended independently as the migration progresses to new endpoints.

### Senior @ FAANG: Regression Test Governance and the Contract Freeze Protocol

At senior level, automated regression tests are governance artifacts as much as technical tools. The governance concern: who owns the regression test suite, who approves changes to it, and what happens when a test fails during a migration.

The contract freeze protocol addresses this directly. Before beginning traffic migration, the team should declare a contract freeze: the set of behaviors captured in the regression test suite represents the guaranteed contract of the legacy service, and the new service must not deviate from any of these behaviors before the migration traffic split advances past a defined threshold (typically 50%). After the contract freeze is declared, any change to the regression test suite requires explicit sign-off from the team's technical lead, because removing or modifying a test is equivalent to changing the migration's correctness definition.

The specific senior-level design question for regression testing: how to handle intentional behavioral differences between the legacy and new service. If the new service deliberately changes a response field name (for example, as part of an API versioning strategy), the regression test for that field will fail even though the behavior is correct by design. The governance process: intentional differences must be documented in an ADR, the corresponding regression test must be updated with an explicit comment explaining why the behavior diverges, and the update must be approved before the traffic split advances. This process ensures that regression test failures are always either bugs that require fixes or intentional changes that require documentation, never ambiguous failures that are ignored.

At senior level, the regression test suite must also be connected to the feature flag system. When a feature flag controls which code path handles a request, regression tests must cover both flag states (enabled and disabled). A regression test that only covers the new code path provides no safety net during the gradual traffic migration period when both paths are active.

---
