## 46.5 Request/Response Transformation

### Custom Request Transformation

The `runtime.ServeMux` accepts `WithIncomingHeaderMatcher` and `WithOutgoingHeaderMatcher` options to control which HTTP headers are propagated to and from gRPC metadata. Custom `IncomingHeaderMatcher` functions allow forwarding non-standard headers like `X-Request-ID` or `Authorization` variants that the default matcher would otherwise drop.

```go
package gateway

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "strings"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
)

// TransformingMarshaler wraps the default marshaler with transformations
type TransformingMarshaler struct {
    runtime.JSONPb
    transforms []ResponseTransform
}

type ResponseTransform func(any) any

func (m *TransformingMarshaler) Marshal(v any) ([]byte, error) {
    // Apply transforms
    for _, transform := range m.transforms {
        v = transform(v)
    }
    return m.JSONPb.Marshal(v)
}

// WrapResponse wraps responses in a data envelope
func WrapResponse(v any) any {
    return map[string]any{
        "data": v,
    }
}

// RequestBodyTransformer transforms incoming request bodies
func RequestBodyTransformer(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Transform snake_case to camelCase in request body
        if r.Body != nil && r.ContentLength > 0 {
            var body map[string]any
            if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
                transformed := transformKeys(body, snakeToCamel)
                newBody, _ := json.Marshal(transformed)
                r.Body = io.NopCloser(bytes.NewReader(newBody))
                r.ContentLength = int64(len(newBody))
            }
        }
        next.ServeHTTP(w, r)
    })
}

func snakeToCamel(s string) string {
    words := strings.Split(s, "_")
    for i := 1; i < len(words); i++ {
        if len(words[i]) > 0 {
            words[i] = strings.ToUpper(words[i][:1]) + words[i][1:]
        }
    }
    return strings.Join(words, "")
}

func transformKeys(m map[string]any, transform func(string) string) map[string]any {
    result := make(map[string]any)
    for k, v := range m {
        newKey := transform(k)
        switch val := v.(type) {
        case map[string]any:
            result[newKey] = transformKeys(val, transform)
        case []any:
            arr := make([]any, len(val))
            for i, item := range val {
                if m, ok := item.(map[string]any); ok {
                    arr[i] = transformKeys(m, transform)
                } else {
                    arr[i] = item
                }
            }
            result[newKey] = arr
        default:
            result[newKey] = v
        }
    }
    return result
}
```

### Custom Response Headers

gRPC servers send response metadata via `grpc.SetHeader` and `grpc.SendHeader`. gRPC-Gateway's `WithOutgoingHeaderMatcher` option determines which metadata keys are promoted to HTTP response headers. Setting `Grpc-Metadata-` prefix headers and configuring the matcher to forward them is how correlation IDs and server-timing headers flow from the gRPC handler back to the REST client.

```go
package gateway

import (
    "context"
    "net/http"

    "github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
    "google.golang.org/protobuf/proto"
)

// ForwardResponseOptions adds custom response headers
func ForwardResponseOptions() []runtime.ServeMuxOption {
    return []runtime.ServeMuxOption{
        runtime.WithForwardResponseOption(forwardResponse),
    }
}

func forwardResponse(ctx context.Context, w http.ResponseWriter, resp proto.Message) error {
    // Get metadata from context
    md, ok := runtime.ServerMetadataFromContext(ctx)
    if !ok {
        return nil
    }

    // Forward specific headers
    if vals := md.HeaderMD.Get("x-request-id"); len(vals) > 0 {
        w.Header().Set("X-Request-Id", vals[0])
    }

    if vals := md.HeaderMD.Get("x-ratelimit-remaining"); len(vals) > 0 {
        w.Header().Set("X-RateLimit-Remaining", vals[0])
    }

    if vals := md.HeaderMD.Get("x-ratelimit-reset"); len(vals) > 0 {
        w.Header().Set("X-RateLimit-Reset", vals[0])
    }

    // Set caching headers based on response type
    if isListResponse(resp) {
        w.Header().Set("Cache-Control", "private, max-age=60")
    } else {
        w.Header().Set("Cache-Control", "no-cache")
    }

    return nil
}

func isListResponse(resp proto.Message) bool {
    // Check if response is a list type
    // Implementation depends on your proto definitions
    return false
}
```

### Junior -> FAANG: When Transformation Is the Right Tool

Request/response transformation in gRPC-Gateway is a practical feature and a maintenance risk. The section shows two transformation mechanisms: the `TransformingMarshaler` for response shaping and the `ForwardResponseOption` for header manipulation. Knowing when to use each, and when to avoid both, is the skill to develop.

Use `ForwardResponseOption` when you need to promote gRPC response metadata (set via `grpc.SetHeader` in the handler) to HTTP response headers. This is the correct mechanism for rate-limit headers, trace IDs, and cache directives. The transformation is narrow: it reads metadata keys and writes header values. It does not touch the response body.

Avoid custom marshalers that transform field names or wrap responses in envelopes unless there is a documented client compatibility requirement. Every transformation layer is code that must be tested, maintained, and understood by the next engineer. If you add a `WrapResponse` transform that wraps every response in `{"data": ...}`, you must also update the OpenAPI spec to reflect the envelope, update any SDK generation templates, and write tests that verify the wrapping happens correctly for every response type including error responses.

The `RequestBodyTransformer` that converts `snake_case` to `camelCase` is an example of a transformation that should not exist. If the client sends `snake_case` and the gateway expects `camelCase`, the correct fix is to set `UseProtoNames: true` on the marshaler so the gateway accepts `snake_case` natively. Adding a preprocessing transformation to compensate for a marshaler setting is adding complexity to fix a configuration problem.

Interview habit: when asked about request/response transformation, lead with the marshaler options (`UseProtoNames`, `EmitUnpopulated`, `DiscardUnknown`) before reaching for custom middleware. Marshaler options are zero-cost and generated-code-safe. Middleware transformations are bespoke and fragile.

### Senior @ FAANG: Transformation as a Migration Tool and Its Governance Constraints

The most legitimate use case for request/response transformation at the gateway layer is backward compatibility during migration. When a proto field is renamed, the old JSON key must continue to work for clients that have not yet migrated. The transformation layer can translate the old key to the new field name transparently, giving clients a deprecation window without requiring a simultaneous cutover.

The correct implementation of this migration pattern has three components:

First, the transformation must be time-bounded. Add a deadline (a date or a traffic threshold) after which the transformation will be removed. Document the deadline in a comment adjacent to the transformation code and in the API changelog. Without a deadline, migration transformations accumulate and become permanent. Ten such transformations is a legacy maintenance burden. One hundred is a system that nobody understands.

Second, the transformation must be observable. Log (at debug level) every request where the old key was used, and export a metric counting those requests. When the metric reaches zero for 30 days, remove the transformation. This is the only way to know it is safe to remove.

Third, the transformation must be tested against the exact client behavior it is compensating for. Write an integration test that sends a request with the old field name and asserts the response is correct. This test becomes the removal gate: when you delete the transformation, the test should also be deleted, and the test suite should still pass because clients have migrated.

**Response envelope governance.** The `WrapResponse` transform wraps every response in a `{"data": ...}` envelope. Once this envelope is in production, removing it is a breaking change for every client. Before adding a response envelope, ask: is this envelope needed by all clients, or just by some? If only some clients need the envelope, consider adding it as an opt-in via a request header (`X-Response-Envelope: true`) rather than making it universal. At Google scale, API response shapes are frozen for years, and the cost of adding an envelope "for consistency" and then being unable to remove it is higher than the cost of not having it.

**The `ForwardResponseOption` and cache header policy.** The `isListResponse` function in this section is a stub that always returns false. In production, you need a real implementation that classifies responses and sets appropriate cache TTLs. This classification logic belongs in a platform-level library, not copy-pasted into each service's gateway config. A platform library also lets you centrally update the cache policy (e.g., after a CDN change) without editing 30 service configs.

**Header forwarding and security.** The `ForwardResponseOption` that copies `x-ratelimit-remaining` to the HTTP response is exposing information about the backend's rate limiting implementation. At FAANG scale, this is intentional: clients use rate limit headers to implement adaptive throttling. But it also tells attackers how close to the limit they are. The decision to expose these headers should be documented in the security review for the API, with the threat model made explicit.

---
