## 51.5 Request/Response Transformation

### Request Transformation

Request transformation at the gateway layer lets clients use a stable public API while internal services evolve independently. Header renaming, body field mapping, and version translation all happen in the `Director` function before the request reaches any upstream. Reading and replacing `r.Body` requires resetting `r.ContentLength` and `r.Body` with `io.NopCloser` around a `bytes.Buffer`, otherwise the upstream receives a mismatched content-length and may reject the request. Transformations should be applied in a composable pipeline so that individual rules (header injection, JSON field remapping, gzip decompression) can be added, removed, or reordered through configuration without touching gateway core logic.

> **Senior track**: Keep gateway transforms small and stateless. Good: strip internal headers, inject trace IDs, rewrite `/v1/foo` to `/foo`, add `X-Tenant` from JWT claims. Bad: rewriting entire JSON schemas, joining request bodies from multiple sources, running domain validation. Heavy transforms (schema migration between API v1 and v3) belong in a dedicated adapter service or a BFF where you can test and version them independently. Every byte of body you buffer at the gateway costs you memory and latency for all traffic, even requests that do not need the transform.

```go
// pkg/gateway/transform.go
package gateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// RequestTransformer transforms requests
type RequestTransformer interface {
	Transform(r *http.Request) error
}

// ResponseTransformer transforms responses
type ResponseTransformer interface {
	Transform(resp *http.Response) error
}

// HeaderTransformer modifies headers
type HeaderTransformer struct {
	Add    map[string]string
	Remove []string
	Rename map[string]string
}

// Transform transforms request headers
func (t *HeaderTransformer) Transform(r *http.Request) error {
	// Remove headers
	for _, key := range t.Remove {
		r.Header.Del(key)
	}

	// Rename headers
	for old, new := range t.Rename {
		if value := r.Header.Get(old); value != "" {
			r.Header.Set(new, value)
			r.Header.Del(old)
		}
	}

	// Add headers
	for key, value := range t.Add {
		r.Header.Set(key, value)
	}

	return nil
}

// BodyTransformer transforms request/response bodies
type BodyTransformer struct {
	// JSONPatch applies JSON patch operations
	JSONPatch []JSONPatchOp
	// FieldMapping renames fields
	FieldMapping map[string]string
	// RemoveFields removes fields from JSON
	RemoveFields []string
	// AddFields adds static fields
	AddFields map[string]any
}

// JSONPatchOp represents a JSON patch operation
type JSONPatchOp struct {
	Op    string      `json:"op"`    // add, remove, replace, move, copy
	Path  string      `json:"path"`
	From  string      `json:"from,omitempty"`
	Value any `json:"value,omitempty"`
}

// TransformRequest transforms request body
func (t *BodyTransformer) TransformRequest(r *http.Request) error {
	if r.Body == nil || r.ContentLength == 0 {
		return nil
	}

	contentType := r.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		return nil
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	r.Body.Close()

	transformed, err := t.transformJSON(body)
	if err != nil {
		return err
	}

	r.Body = io.NopCloser(bytes.NewReader(transformed))
	r.ContentLength = int64(len(transformed))
	r.Header.Set("Content-Length", fmt.Sprintf("%d", len(transformed)))

	return nil
}

// TransformResponse transforms response body
func (t *BodyTransformer) TransformResponse(resp *http.Response) error {
	if resp.Body == nil {
		return nil
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.Contains(contentType, "application/json") {
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	resp.Body.Close()

	transformed, err := t.transformJSON(body)
	if err != nil {
		return err
	}

	resp.Body = io.NopCloser(bytes.NewReader(transformed))
	resp.ContentLength = int64(len(transformed))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(transformed)))

	return nil
}

func (t *BodyTransformer) transformJSON(data []byte) ([]byte, error) {
	var obj map[string]any
	if err := json.Unmarshal(data, &obj); err != nil {
		return data, nil // Return unchanged if not valid JSON
	}

	// Remove fields
	for _, field := range t.RemoveFields {
		delete(obj, field)
	}

	// Rename fields
	for old, new := range t.FieldMapping {
		if value, exists := obj[old]; exists {
			obj[new] = value
			delete(obj, old)
		}
	}

	// Add fields
	for key, value := range t.AddFields {
		obj[key] = value
	}

	return json.Marshal(obj)
}

// URLRewriter rewrites URLs
type URLRewriter struct {
	Rules []RewriteRule
}

// RewriteRule defines a URL rewrite rule
type RewriteRule struct {
	Match   string // Regex pattern
	Replace string // Replacement (supports $1, $2, etc.)
}

// Rewrite rewrites the request URL
func (r *URLRewriter) Rewrite(req *http.Request) {
	for _, rule := range r.Rules {
		pattern := regexp.MustCompile(rule.Match)
		if pattern.MatchString(req.URL.Path) {
			req.URL.Path = pattern.ReplaceAllString(req.URL.Path, rule.Replace)
			return
		}
	}
}
```

### Junior -> FAANG: Transformation Concepts You Need for Interviews

Request transformation at the gateway is one of those topics where interviewers test whether you understand the boundaries of responsibility, not just the mechanics.

The mechanics: to modify a request body you must read it entirely into memory, transform it, then replace `r.Body` with a new `io.NopCloser` around the modified bytes. You must also update `Content-Length`. Forgetting to update `Content-Length` causes the upstream to reject or truncate the body.

The boundary question: "what transformations belong at the gateway?" The correct answer is small, stateless, structural changes: header renaming, path rewriting, stripping internal identifiers from responses, injecting trace IDs. The wrong answer is anything that requires domain knowledge (validating a field against a business rule), data lookups (enriching the request with user data from a database), or complex schema migration (converting from API v1 schema to API v3 schema). Those belong in the service or a dedicated adapter service.

For interviews, be ready to explain why buffering the request body to transform it has a memory cost proportional to the body size times the concurrency. A gateway doing body transforms on 10 KB payloads at 50000 RPS holds roughly 500 MB of in-flight body buffers, before any other allocations. That is the constraint that sends heavy transforms out of the gateway.

### Senior @ FAANG: Transformation Design and Production Tradeoffs

**Compile patterns once.** The `URLRewriter.Rewrite` method calls `regexp.MustCompile(rule.Match)` on every request. Regular expression compilation is expensive (tens of microseconds). In a function called at 50000 RPS, that is significant CPU waste. The correct pattern compiles all patterns once at startup (or on `AddRoute`) and stores the compiled `*regexp.Regexp` in the rule struct. This is a standard code review catch for any hot-path regex usage.

**Header transform ordering.** The `HeaderTransformer` applies Remove, then Rename, then Add. This ordering matters: if a header is in both Remove and Add, the net effect depends on which runs last. Document the ordering explicitly in the type's Go doc comment, because the sequence is load-bearing behavior that future maintainers must not accidentally swap.

**Streaming vs buffering.** `BodyTransformer.TransformRequest` reads the entire body with `io.ReadAll`. This is correct for JSON payloads where you need the full document to unmarshal. It is wrong for large file uploads (body can be gigabytes), for streaming APIs, and for multipart forms where you want to pass through individual parts without buffering the whole body. A production gateway applies body transforms only to routes explicitly configured for them and defaults to streaming (no body buffering) for all other routes.

**Versioned API translation as a gateway concern.** Moving from `/api/v1/users` to `/api/v2/users` is a path rewrite. Moving from a v1 JSON schema (snake_case, flat structure) to a v2 schema (camelCase, nested structure) is a semantic translation. Path rewrites belong at the gateway. Schema translations belong in a versioned adapter service or BFF, because the translation logic is domain-specific, changes frequently, and must be independently tested. If schema translation ends up in the gateway, it should live in a plugin or middleware registered per-route, not in the gateway core, so it can be versioned and deployed independently.

**JSON Patch as a transform primitive.** The `BodyTransformer` supports a `JSONPatch []JSONPatchOp` field following RFC 6902. JSON Patch is the correct primitive for declarative body transforms because it is a standard, has a defined specification, and can be tested independently of the gateway. Avoid inventing a custom transform DSL. Interviewers and maintainers will prefer a standard they recognize. The tradeoff is that JSON Patch operates on shallow paths and does not handle deeply nested conditional rewrites elegantly. For those cases, a dedicated Go transformation function registered as a `ResponseModifier` is clearer.

---
