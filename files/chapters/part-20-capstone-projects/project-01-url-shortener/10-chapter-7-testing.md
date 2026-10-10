## Chapter 7: Testing

Thorough testing is what separates a hobby project from production-quality software. In this chapter, we write three levels of tests: unit tests that verify the Base62 encoding logic in isolation, integration tests that exercise the HTTP handlers with a real database, and load tests that simulate thousands of concurrent users to ensure the system holds up under pressure. Each level catches a different category of bugs, and together they give you confidence that your URL shortener actually works.

### 7.1 Unit Tests for Shortener

Unit tests verify that the Base62 encoding and decoding functions produce correct results for a range of inputs. We use table-driven tests, which is the standard Go testing pattern where you define a slice of test cases and loop through them. This approach makes it easy to add new cases without duplicating test logic. The round-trip test is especially important: it confirms that encoding a number and then decoding the result always returns the original number.

```go
// pkg/shortener/base62_test.go
package shortener_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/yourusername/goshort/pkg/shortener"
)

func TestEncode(t *testing.T) {
	tests := []struct {
		name     string
		input    uint64
		expected string
	}{
		{"Zero", 0, "0"},
		{"Single digit", 5, "5"},
		{"Base boundary", 62, "10"},
		{"Large number", 123456789, "8M0kX"},
		{"Max safe int", 9007199254740991, "fFgnDxSe7"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := shortener.Encode(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestDecode(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected uint64
		hasError bool
	}{
		{"Zero", "0", 0, false},
		{"Single digit", "5", 5, false},
		{"Base boundary", "10", 62, false},
		{"Large number", "8M0kX", 123456789, false},
		{"Invalid character", "8M0kX!", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := shortener.Decode(tt.input)

			if tt.hasError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.Equal(t, tt.expected, result)
			}
		})
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	testCases := []uint64{0, 1, 62, 63, 123456, 9999999, 1<<32 - 1}

	for _, original := range testCases {
		encoded := shortener.Encode(original)
		decoded, err := shortener.Decode(encoded)

		assert.NoError(t, err)
		assert.Equal(t, original, decoded, "Round trip failed for %d", original)
	}
}

func BenchmarkEncode(b *testing.B) {
	for b.Loop() {
		shortener.Encode(uint64(i))
	}
}

func BenchmarkDecode(b *testing.B) {
	encoded := shortener.Encode(123456789)
	b.ResetTimer()

	for b.Loop() {
		shortener.Decode(encoded)
	}
}
```

### 7.2 Integration Tests

Integration tests verify that all the layers of the application work together correctly. Unlike unit tests that mock dependencies, these tests spin up a real test database, create actual HTTP requests, and assert on the full JSON response. The `httptest` package from Go's standard library makes it easy to test HTTP handlers without starting a real server. Notice how each test case sets up its own request and checks both the status code and the response body.

```go
// internal/api/handlers/shorten_test.go
package handlers_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/yourusername/goshort/internal/api/handlers"
	"github.com/yourusername/goshort/internal/service"
	"github.com/yourusername/goshort/internal/testutil"
)

func TestShortenHandler(t *testing.T) {
	// Setup test dependencies
	db := testutil.SetupTestDB(t)
	defer db.Close()

	cache := testutil.NewMockCache()
	analytics := testutil.NewMockAnalytics()
	rateLimiter := testutil.NewMockRateLimiter()

	repo := testutil.NewTestURLRepository(db)
	shortenerSvc := service.NewShortenerService(repo, cache, analytics, rateLimiter)

	handler := handlers.NewHandler(shortenerSvc, nil)

	// Setup router
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/shorten", handler.Shorten)

	t.Run("Successful shortening", func(t *testing.T) {
		reqBody := map[string]any{
			"url": "https://example.com/very/long/url/that/needs/shortening",
		}

		body, _ := json.Marshal(reqBody)
		req := httptest.NewRequest(http.MethodPost, "/shorten", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusCreated, w.Code)

		var response handlers.ShortenResponse
		err := json.Unmarshal(w.Body.Bytes(), &response)
		require.NoError(t, err)

		assert.NotEmpty(t, response.ShortCode)
		assert.Equal(t, reqBody["url"], response.LongURL)
		assert.Contains(t, response.ShortURL, response.ShortCode)
	})

	t.Run("Invalid URL", func(t *testing.T) {
		reqBody := map[string]any{
			"url": "not-a-valid-url",
		}

		body, _ := json.Marshal(reqBody)
		req := httptest.NewRequest(http.MethodPost, "/shorten", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("Custom alias", func(t *testing.T) {
		customAlias := "my-custom-link"
		reqBody := map[string]any{
			"url":          "https://example.com",
			"custom_alias": customAlias,
		}

		body, _ := json.Marshal(reqBody)
		req := httptest.NewRequest(http.MethodPost, "/shorten", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusCreated, w.Code)

		var response handlers.ShortenResponse
		err := json.Unmarshal(w.Body.Bytes(), &response)
		require.NoError(t, err)

		assert.Equal(t, customAlias, response.ShortCode)
	})
}

func TestRedirectHandler(t *testing.T) {
	db := testutil.SetupTestDB(t)
	defer db.Close()

	cache := testutil.NewMockCache()
	analytics := testutil.NewMockAnalytics()
	rateLimiter := testutil.NewMockRateLimiter()

	repo := testutil.NewTestURLRepository(db)
	shortenerSvc := service.NewShortenerService(repo, cache, analytics, rateLimiter)

	handler := handlers.NewHandler(shortenerSvc, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/:code", handler.Redirect)

	// Create a test URL
	ctx := context.Background()
	shortenReq := &service.ShortenRequest{
		LongURL: "https://example.com/target",
	}
	result, err := shortenerSvc.Shorten(ctx, shortenReq)
	require.NoError(t, err)

	t.Run("Successful redirect", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/"+result.ShortCode, nil)
		w := httptest.NewRecorder()

		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusMovedPermanently, w.Code)
		assert.Equal(t, shortenReq.LongURL, w.Header().Get("Location"))
	})

	t.Run("Not found", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/nonexistent", nil)
		w := httptest.NewRecorder()

		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusNotFound, w.Code)
	})
}
```

### 7.3 Load Testing

Load tests simulate real-world traffic patterns by sending thousands of concurrent requests to your running service. This test launches 1,000 concurrent goroutines, each sending 100 redirect requests, for a total of 100,000 requests. It measures the overall requests per second (RPS) and success rate, and fails if the success rate drops below 95%. You should run load tests against a staging environment that mirrors production to get meaningful results.

```go
// test/load/load_test.go
package load

import (
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// TestHighConcurrencyRedirects simulates high traffic
func TestHighConcurrencyRedirects(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping load test in short mode")
	}

	baseURL := "http://localhost:8080"
	shortCode := "test123" // Pre-created short URL

	concurrentUsers := 1000
	requestsPerUser := 100

	var wg sync.WaitGroup
	successCount := int64(0)
	var mu sync.Mutex

	start := time.Now()

	for i := 0; i < concurrentUsers; i++ {
		wg.Add(1)
		go func(userID int) {
			defer wg.Done()

			client := &http.Client{
				Timeout: 5 * time.Second,
				CheckRedirect: func(req *http.Request, via []*http.Request) error {
					return http.ErrUseLastResponse // Don't follow redirects
				},
			}

			for j := 0; j < requestsPerUser; j++ {
				resp, err := client.Get(fmt.Sprintf("%s/%s", baseURL, shortCode))
				if err == nil && resp.StatusCode == http.StatusMovedPermanently {
					mu.Lock()
					successCount++
					mu.Unlock()
				}
				if resp != nil {
					resp.Body.Close()
				}
			}
		}(i)
	}

	wg.Wait()
	duration := time.Since(start)

	totalRequests := int64(concurrentUsers * requestsPerUser)
	rps := float64(totalRequests) / duration.Seconds()

	t.Logf("Load Test Results:")
	t.Logf("  Total Requests: %d", totalRequests)
	t.Logf("  Successful: %d", successCount)
	t.Logf("  Duration: %v", duration)
	t.Logf("  RPS: %.2f", rps)

	successRate := float64(successCount) / float64(totalRequests) * 100
	assert.Greater(t, successRate, 95.0, "Success rate should be > 95%%")
}
```

---

### Junior → FAANG: The Testing Pyramid as a First-Job Discipline

The three-level testing approach in this chapter (unit, integration, load) maps directly to what FAANG interviewers call the "testing pyramid." Many candidates describe unit tests but skip integration tests because they are harder to set up. Demonstrating you have actually written integration tests with a real database and load tests with concurrent goroutines is a strong differentiator.

Table-driven tests are Go's standard pattern. Showing you use them demonstrates you follow Go conventions and write tests that are easy to extend. When adding a new edge case in an interview, add it as a row to a table test rather than duplicating test function boilerplate.

For your first job, the discipline to write tests before considering a feature done is more important than any specific testing technique. Interviewers often ask "how do you know your code works?" and the answer should reference specific tests you wrote, not general confidence.

### Senior @ FAANG: Testing Strategy as an Engineering Investment

At senior level, testing strategy is an investment decision. Unit tests are cheap to write and fast to run but only validate logic in isolation. Integration tests are expensive to write and slow to run but catch real wiring bugs. Load tests require infrastructure and are run infrequently. The right mix depends on the failure modes that matter most for the service.

For a URL shortener, the highest-risk failure modes are redirect failures under load (measured by load tests), data corruption from concurrent writes (measured by race-detector-enabled integration tests), and cache inconsistency after updates (measured by targeted integration tests that update a URL and verify all cache tiers reflect the change). The testing strategy should be driven by those risk priorities, not by coverage percentage.

Property-based testing is worth adding for the Base62 encode/decode functions. A property test generates thousands of random integers and verifies that decode(encode(n)) == n for all of them. This catches edge cases that hand-written table tests miss (zero, max int64, values near power-of-62 boundaries). Go's `testing/quick` package or the `rapid` library supports property-based testing.

Test reliability is a platform concern at scale. Flaky tests that pass 99% of the time become a significant drag on CI throughput when you have hundreds of them. At FAANG, flaky tests are treated as production bugs: they are quarantined immediately, tracked as metrics (flakiness rate by test file), and fixed with the same priority as service reliability issues. Building that culture starts with the discipline to investigate every test failure rather than re-running until it passes.

---
