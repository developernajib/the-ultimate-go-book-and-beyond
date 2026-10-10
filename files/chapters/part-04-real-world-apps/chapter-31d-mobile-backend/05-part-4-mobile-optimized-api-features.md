## Part 4: Mobile-Optimized API Features

### Response Compression and Partial Responses

Three techniques reduce payload size for mobile clients. First, compression middleware wraps the response writer so every JSON response is compressed transparently. Prefer **Brotli** (`br`) when the client's `Accept-Encoding` advertises it, Brotli compresses JSON 15-25% smaller than gzip at comparable CPU cost, and all iOS 11+ / Android 6+ clients support it. Fall back to gzip (`gzip`) otherwise. Typical API responses compress 4-10× with either. Second, sparse fieldsets let the client specify `?fields=id,name` to receive only the fields it needs, skipping large text columns or nested objects the current screen does not display. Third, ETag-based conditional requests return `304 Not Modified` when data has not changed, eliminating redundant downloads entirely, pair `ETag`/`If-None-Match` with `Cache-Control: private, max-age=...` so intermediate proxies don't leak one user's response to another.

**Binary encodings for constrained networks.** When payloads are the bottleneck rather than wall-clock RTT, swap JSON for a binary format:

- **Protocol Buffers**, smallest and fastest when you own both ends (first-party mobile + gRPC/Connect services). Schema-evolution rules are explicit. generated code is type-safe across Swift / Kotlin / Dart.
- **MessagePack.** JSON-compatible shape, ~50% smaller than JSON without a schema. Good for analytics ingestion where fields vary per event.
- **CBOR** (RFC 8949), similar to MessagePack, standardized by the IETF, used by WebAuthn and COSE. Pick it when you need schemaless binary with a formal spec (health/IoT interoperability).

Gzip'd JSON reaches ~80% of protobuf's size advantage at zero tooling cost. Only reach for binary when profiling shows serialization or bytes-on-the-wire dominate the request budget.

```go
package mobile

import (
	"compress/gzip"
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// CompressionMiddleware applies gzip/brotli compression for mobile clients
func CompressionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept := r.Header.Get("Accept-Encoding")

		if strings.Contains(accept, "gzip") {
			gz := gzip.NewWriter(w)
			defer gz.Close()
			w.Header().Set("Content-Encoding", "gzip")
			next.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, writer: gz}, r)
			return
		}

		next.ServeHTTP(w, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (g *gzipResponseWriter) Write(data []byte) (int, error) {
	return g.writer.Write(data)
}

// FieldFilter supports sparse fieldsets: ?fields=id,name,email
func FieldFilter(data map[string]any, fields []string) map[string]any {
	if len(fields) == 0 {
		return data
	}

	fieldSet := make(map[string]bool, len(fields))
	for _, f := range fields {
		fieldSet[strings.TrimSpace(f)] = true
	}

	result := make(map[string]any)
	for k, v := range data {
		if fieldSet[k] {
			result[k] = v
		}
	}
	return result
}

// ParseFields extracts field list from URL parameter
func ParseFields(r *http.Request) []string {
	fields := r.URL.Query().Get("fields")
	if fields == "" {
		return nil
	}
	return strings.Split(fields, ",")
}

// ETags for conditional requests (saves bandwidth if data unchanged)
type CacheableHandler struct {
	next     http.Handler
	cacheDB  ETagStore
}

type ETagStore interface {
	GetETag(ctx context.Context, key string) (string, error)
	SetETag(ctx context.Context, key, etag string) error
}

func (h *CacheableHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cacheKey := r.URL.Path + "?" + r.URL.RawQuery

	etag, err := h.cacheDB.GetETag(r.Context(), cacheKey)
	if err == nil && etag != "" {
		// Check If-None-Match
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
	}

	// Record response for ETag generation
	rec := &responseRecorder{ResponseWriter: w}
	h.next.ServeHTTP(rec, r)

	if rec.status == http.StatusOK {
		newETag := fmt.Sprintf(`"%d"`, hashBytes(rec.body))
		w.Header().Set("ETag", newETag)
		_ = h.cacheDB.SetETag(r.Context(), cacheKey, newETag)
	}
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	body   []byte
}

func (r *responseRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseRecorder) Write(b []byte) (int, error) {
	r.body = append(r.body, b...)
	return r.ResponseWriter.Write(b)
}

func hashBytes(b []byte) uint64 {
	h := uint64(14695981039346656037)
	for _, c := range b {
		h ^= uint64(c)
		h *= 1099511628211
	}
	return h
}

// Pagination with cursor (better than offset for mobile)
type CursorPage struct {
	Items      []any `json:"items"`
	NextCursor string        `json:"next_cursor,omitempty"`
	HasMore    bool          `json:"has_more"`
	Total      int           `json:"total,omitempty"` // optional, expensive
}

// EncodeCursor creates an opaque cursor from a position
func EncodeCursor(id string, timestamp time.Time) string {
	data := fmt.Sprintf("%s|%d", id, timestamp.UnixMilli())
	return base64.URLEncoding.EncodeToString([]byte(data))
}

// DecodeCursor decodes a cursor to its components
func DecodeCursor(cursor string) (id string, timestamp time.Time, err error) {
	data, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("invalid cursor: %w", err)
	}

	parts := strings.SplitN(string(data), "|", 2)
	if len(parts) != 2 {
		return "", time.Time{}, fmt.Errorf("malformed cursor")
	}

	var ms int64
	fmt.Sscanf(parts[1], "%d", &ms)
	return parts[0], time.UnixMilli(ms), nil
}
```

### Junior → FAANG: Bandwidth Discipline Is Not Optional On Mobile

A junior engineer tests a response that is 200KB uncompressed and thinks "fine, it's fast on my machine." A senior engineer knows that 200KB on a 2G edge connection in a rural area takes five to ten seconds to arrive, and that the user will have closed the app before it completes. Mobile bandwidth discipline is not a nice-to-have. It is the difference between an app that works for the bottom half of your global user base and one that does not. The code above hits the three main levers: compression (20x reduction on JSON is typical with Brotli at max quality), sparse fieldsets (order-of-magnitude payload reduction when a screen only needs four of forty fields), and ETags (304 Not Modified responses avoid the bytes entirely).

Worked example of the image story that the code above does not cover. Images dominate mobile payload size. A single hero image at 2000x1500 JPEG is often larger than all the JSON on a screen combined. The right answer is adaptive: serve WebP to clients that advertise it, AVIF to clients that advertise it (iOS 16+, Android 12+), JPEG as fallback, and vary the dimensions to the device's actual screen density from the `User-Agent` or a client-supplied pixel-density header. A Go image service using `golang.org/x/image/webp` and `github.com/Kagami/go-avif` can serve all three from a single source image with a transform cache. The staff-level extension is a CDN-level image transformation layer (Cloudflare Images, Imgix, Fastly Image Optimizer) so the origin never materializes the transformed version.

Interview framing. If asked "how would you optimize a slow mobile endpoint," the junior answer is "add a cache." The senior-track answer walks the stack: compression (is Brotli enabled? what quality level? is the edge actually compressing or is the origin?), payload shape (is the client receiving fields it does not render?), conditional requests (are we sending 304s when unchanged?), connection reuse (is the client on HTTP/2 or HTTP/3 with a warm connection?), and only then caching. Each layer is measurable independently and each can dominate in different scenarios.

First-job context. You will find an endpoint that returns a 500KB JSON blob because five years ago someone added a field that was a full copy of another table. You will propose to deprecate the field and meet resistance because three unknown clients might still read it. The path forward is a deprecation dashboard: log field access per client version, announce the deprecation, watch the read traffic drop, and remove the field when it falls below the threshold. That loop, end to end, is often a six-month project, and it is the kind of unglamorous work that promotes new grads to L4.

### Senior @ FAANG: HTTP/3, Adaptive Payloads, and the Mobile-First API Evolution Discipline

At staff level the bandwidth story is a system property, not a per-endpoint optimization. Three properties must be established and defended: end-to-end compressed payload size at p50, p95, and p99 per screen. Cold-start bytes to first meaningful render for each critical user journey. Per-screen field coverage, meaning what percentage of clients use each field in the response. These three numbers are the inputs to the API evolution discipline. If you cannot produce them on demand for a staff review, the mobile team does not yet have the observability it needs.

HTTP/3 deserves an ADR specifically for mobile. The wins that justify the operational cost are connection migration (Wi-Fi to LTE handoff without reconnect), 0-RTT resumption for returning sessions (shaves the TLS handshake on reconnect), and head-of-line-blocking elimination at the transport layer (a lost packet on one stream does not stall other streams, which matters on lossy cellular). The costs are observability (fewer tools understand QUIC traces cleanly in 2026), debugging (middleboxes that mangle UDP traffic still exist, particularly in enterprise and some national networks), and fallback complexity (the Alt-Svc negotiation and the happy-eyeballs fallback to HTTP/2 must be tested). The right staff-level answer for most teams is: HTTP/3 at the edge, HTTP/2 origin-to-edge, with a flag-gated HTTP/3 origin path for latency-critical flows where the operational complexity is justified by the SLO.

Adaptive bitrate and payload shaping for mobile is a category staff engineers often under-invest in. Three levers: payload variants by network type (client sends a hint header, server returns a smaller response on slow networks), payload variants by client capability (older client versions get fewer fields or simpler response shapes), and payload variants by user segment (paying users may get higher-fidelity content while free users get compressed variants). The shape contract must be explicit and versioned. The anti-pattern is implicit shaping ("if `User-Agent` contains `LowEnd` we return a smaller response") because it creates invisible API surface that clients cannot reason about and tests cannot cover.

Mobile-first API versioning deserves an explicit discipline. The rule is additive evolution: fields are added, never removed. Field semantics are never changed in place. When semantics must change, a new field is introduced with the new name and the old field is deprecated on a timeline governed by client version distribution. Breaking changes, when absolutely required, are gated by a forced-update floor that is raised only when the at-risk client version falls below a traffic threshold. The tooling for this at staff level is a schema registry that tracks every field, its added version, its deprecated version, the clients still reading it, and the removal target. Google's mobile services internally and Meta's Thrift and GraphQL tooling both converge on this model. Teams that skip the registry re-learn the lesson through an outage where a field removal breaks an old client that still has measurable traffic.

Battery and thermal considerations are the silent constraint. Every doubling of poll frequency is a measurable battery cost at the device level that shows up as user churn. Every payload that the client must parse on the main thread in the critical render path is a jank and thermal cost. The staff-level ADRs here: polling frequency per screen (with a default of "no polling, push-initiated or user-initiated only"), background refresh budget (iOS BGTaskScheduler, Android WorkManager, with documented expected wake intervals and max bandwidth per wake), and CPU budget per render (a contract with the client team that server responses will not exceed a target decode and layout cost, measured at the client and reported back in analytics). These are not technical decisions made by one team. They are cross-team contracts that the staff engineer on the mobile backend team is responsible for drafting and reviewing quarterly.

Binary protocols deserve a caveat. Protobuf and Connect are the right choice when you own both ends and the shape is stable enough that schema evolution is a weekly event, not a daily one. But the operational cost of protobuf at mobile scale is non-trivial: you must ship schemas to clients via generated code (build-time coupling), you must enforce the field-number immutability rule across a distributed team, and you must handle the "unknown field" behavior consistently between Go server and Swift/Kotlin clients. For first-party teams at Google, Meta, and Stripe-scale, protobuf is worth the cost. For smaller teams where schema churn is high and team coordination overhead dominates, JSON with Brotli is within 20% of protobuf's wire size at zero coordination cost, and that 20% is often the right tradeoff.

---
