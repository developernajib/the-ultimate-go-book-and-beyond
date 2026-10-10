## Mobile-Specific API Patterns

Mobile clients operate under constraints that typical web APIs ignore: intermittent connectivity, metered data, slow CPUs, and app versions that cannot be force-updated. This section covers the patterns that address each constraint directly.

### Sparse Fieldsets

Mobile screens display a subset of a resource's fields. Returning the full user object (50+ fields) for a list of 100 avatars wastes bandwidth and parse time. Sparse fieldsets let the client declare exactly which fields it needs.

```
GET /api/v1/users?fields=id,name,avatar_url
```

```go
package fieldset

import (
	"net/http"
	"strings"
)

// FieldSet holds the set of requested fields for a response.
type FieldSet struct {
	fields map[string]struct{}
	all    bool
}

// Parse builds a FieldSet from the ?fields= query parameter.
// If the parameter is absent, all fields are included.
func Parse(r *http.Request) FieldSet {
	raw := strings.TrimSpace(r.URL.Query().Get("fields"))
	if raw == "" {
		return FieldSet{all: true}
	}

	fs := FieldSet{fields: make(map[string]struct{})}
	for _, f := range strings.Split(raw, ",") {
		f = strings.TrimSpace(f)
		if f != "" {
			fs.fields[f] = struct{}{}
		}
	}
	return fs
}

// Include reports whether the named field should appear in the response.
func (fs FieldSet) Include(name string) bool {
	if fs.all {
		return true
	}
	_, ok := fs.fields[name]
	return ok
}

// Filter removes keys from a map[string]any that are not in the set.
// Use this to prune a serialization-ready map before writing the response.
func (fs FieldSet) Filter(m map[string]any) map[string]any {
	if fs.all {
		return m
	}
	out := make(map[string]any, len(fs.fields))
	for k, v := range m {
		if fs.Include(k) {
			out[k] = v
		}
	}
	return out
}
```

Handler usage:

```go
func (h *UserHandler) List(w http.ResponseWriter, r *http.Request) {
	fs := fieldset.Parse(r)

	users, err := h.repo.List(r.Context())
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	type userView struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
		Email     string `json:"email,omitempty"`
		Bio       string `json:"bio,omitempty"`
	}

	result := make([]map[string]any, 0, len(users))
	for _, u := range users {
		raw := map[string]any{
			"id":         u.ID,
			"name":       u.Name,
			"avatar_url": u.AvatarURL,
			"email":      u.Email,
			"bio":        u.Bio,
		}
		result = append(result, fs.Filter(raw))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
```

### API Versioning for Mobile

Web apps can be force-reloaded. Mobile apps cannot. A user on iOS 12 may run your app version from two years ago indefinitely. Mobile API versioning rules:

- **Never remove a field** - add new fields instead.
- **Never change a field's type** - a string turning into an integer crashes the client.
- **Version via URL prefix** (`/api/v2/`) not headers - easier to debug in logs and proxies.
- **Maintain N-2 versions** - support current and two previous major versions.
- **Deprecation window** - announce deprecation in response headers, not as a breaking change.

```go
package versioning

import (
	"fmt"
	"net/http"
	"strings"
)

// Version represents a parsed API version.
type Version struct {
	Major int
	Minor int
}

// FromRequest extracts the API version from the URL path.
// Paths must begin with /api/vN or /api/vN.M.
// Returns Version{1, 0} as default when no version prefix is found.
func FromRequest(r *http.Request) Version {
	parts := strings.SplitN(r.URL.Path, "/", 4) // ["", "api", "v2", "users"]
	if len(parts) < 3 {
		return Version{1, 0}
	}
	vStr := strings.TrimPrefix(parts[2], "v")
	segments := strings.SplitN(vStr, ".", 2)
	v := Version{Major: 1}
	if len(segments) > 0 {
		fmt.Sscanf(segments[0], "%d", &v.Major)
	}
	if len(segments) > 1 {
		fmt.Sscanf(segments[1], "%d", &v.Minor)
	}
	return v
}

// DeprecationMiddleware attaches Deprecation and Sunset headers when serving
// an old API version. Mobile clients can surface these to engineering dashboards.
func DeprecationMiddleware(currentMajor int, sunsetDate string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			v := FromRequest(r)
			if v.Major < currentMajor {
				w.Header().Set("Deprecation", "true")
				w.Header().Set("Sunset", sunsetDate) // RFC 7231 date: "Sat, 01 Jan 2027 00:00:00 GMT"
				w.Header().Set("Link", `</api/v`+fmt.Sprint(currentMajor)+`>; rel="successor-version"`)
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

### Delta Sync

Delta sync returns only records that changed after a client-supplied timestamp. This is the backbone of offline-first apps and battery-efficient background sync.

```
GET /api/v1/todos?since=2024-11-01T10:00:00Z
```

Response includes new/updated records plus tombstones for deleted ones:

```json
{
  "items": [...],
  "deleted_ids": ["abc", "def"],
  "server_time": "2024-11-01T10:05:33Z"
}
```

The client stores `server_time` and uses it as `since` on the next sync. Always use server time, never client time - clock skew invalidates client-side timestamps.

```go
package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// DeltaResponse is the wire format for a delta-sync response.
type DeltaResponse[T any] struct {
	Items      []T       `json:"items"`
	DeletedIDs []string  `json:"deleted_ids"`
	ServerTime time.Time `json:"server_time"`
}

// Todo represents a task item for synchronization.
type Todo struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Completed bool      `json:"completed"`
	UpdatedAt time.Time `json:"updated_at"`
}

// TodoRepository defines data-access operations needed for delta sync.
type TodoRepository interface {
	UpdatedSince(ctx context.Context, since time.Time) ([]Todo, error)
	DeletedSince(ctx context.Context, since time.Time) ([]string, error)
}

type DeltaSyncHandler struct {
	repo TodoRepository
}

func NewDeltaSyncHandler(repo TodoRepository) *DeltaSyncHandler {
	return &DeltaSyncHandler{repo: repo}
}

func (h *DeltaSyncHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	sinceStr := r.URL.Query().Get("since")
	var since time.Time
	if sinceStr != "" {
		var err error
		since, err = time.Parse(time.RFC3339, sinceStr)
		if err != nil {
			http.Error(w, "invalid 'since' parameter: use RFC3339", http.StatusBadRequest)
			return
		}
		// Guard against clock skew: reject future timestamps
		if since.After(time.Now().Add(5 * time.Minute)) {
			http.Error(w, "'since' is in the future", http.StatusBadRequest)
			return
		}
	}

	// Capture server time before queries to avoid missing records written
	// between the two DB calls.
	serverTime := time.Now().UTC()

	items, err := h.repo.UpdatedSince(r.Context(), since)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	deletedIDs, err := h.repo.DeletedSince(r.Context(), since)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	if items == nil {
		items = []Todo{} // never return null arrays to mobile clients
	}
	if deletedIDs == nil {
		deletedIDs = []string{}
	}

	resp := DeltaResponse[Todo]{
		Items:      items,
		DeletedIDs: deletedIDs,
		ServerTime: serverTime,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
```

### Cursor-Based Pagination for Mobile Feeds

Offset pagination (`LIMIT 20 OFFSET 40`) breaks on feeds: new items shift offsets while a user is scrolling. Use opaque cursors instead.

```go
package pagination

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// Cursor encodes the position in a feed.
// Using created_at + id makes the cursor stable even with ties on the timestamp.
type Cursor struct {
	CreatedAt time.Time `json:"ca"`
	ID        string    `json:"id"`
}

// Encode serializes the cursor to a URL-safe opaque string.
func (c Cursor) Encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeCursor deserializes an opaque cursor string.
func DecodeCursor(s string) (Cursor, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
	}
	var c Cursor
	if err := json.Unmarshal(b, &c); err != nil {
		return Cursor{}, fmt.Errorf("invalid cursor: %w", err)
	}
	return c, nil
}

// PageResponse wraps a page of results with navigation cursors.
type PageResponse[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"` // empty when no more pages
	HasMore    bool   `json:"has_more"`
}
```

SQL query using the cursor (avoids OFFSET entirely):

```sql
SELECT id, title, created_at
FROM todos
WHERE user_id = $1
  AND (created_at, id) < ($2, $3)   -- cursor condition
ORDER BY created_at DESC, id DESC
LIMIT $4;
```

### Protocol Buffers vs JSON for Mobile

| Metric | JSON | Protocol Buffers |
|--------|------|-----------------|
| Payload size | 1× (baseline) | 0.3-0.5× |
| Parse speed | Slow (string parsing) | Fast (binary, typed) |
| Schema evolution | Manual, convention-based | Built-in field numbering |
| Human-readable | Yes | No (binary) |
| Mobile support | Universal | Requires generated code |

For most apps, gzip-compressed JSON reaches 80% of protobuf efficiency. Use protobuf when you control both ends of the wire (internal microservices, Flutter apps with generated Dart stubs) and payload size is a critical bottleneck (audio metadata, large list responses).

### Junior → FAANG: The Hidden Contracts In These Patterns

Each pattern above is not just a technique. It is a contract with every installed client that has already shipped. Sparse fieldsets: the server promises to honor any registered field name forever, which means adding a field today is a twenty-year commitment to never rename or remove it. Delta sync: the server promises that `since` timestamps are ordered and complete, which means any backfill or repair operation must preserve monotonicity or force clients to full-resync explicitly. Cursor pagination: the cursor encoding is a contract, because a cursor held by an offline client for a week must still decode correctly when the client comes back online. API versioning: URL-prefix versioning is a contract visible in every server log, every analytics event, every debugging session, for the life of the API.

Worked example of the hidden-contract bug. A junior engineer notices the delta-sync handler uses `time.Now().UTC()` for `serverTime` before querying, and refactors it to use the database's `now()` in a transaction for "consistency." The change seems harmless. It is not. The database clock and the server clock can disagree by tens of milliseconds under replication lag, and now some delta responses have `server_time` that precedes records returned in the same response. The next sync misses those records. The fix is to keep `serverTime` on the application side but to bound the query to `updated_at <= serverTime` explicitly in the SQL, which is the pattern the staff-track implementation uses.

Interview framing. These patterns are the "show me code" section of a mobile backend interview. If asked to implement delta sync on a whiteboard, start with the clock-skew defense (reject client timestamps in the future), then the server-time capture before queries, then the "updated-since plus deleted-since" union, then the never-null arrays invariant, and finally the response schema. Walking through these in order signals that you have actually shipped this pattern and know where the bugs hide.

### Senior @ FAANG: Mobile API Patterns As Portfolio Architecture

At staff level these patterns are not standalone. They compose into a portfolio architecture that the mobile backend team owns across years of client versions. The portfolio questions to ask.

On sparse fieldsets. Is the field list enforced by a schema registry, or can any backend team add any field at will? If the latter, you are accumulating surface faster than you can govern it. The mature pattern is that sparse fieldsets are a view over a registered canonical schema, and only registered fields can be requested. Unknown fields are rejected at the BFF boundary so that a client cannot probe for internal fields and create a de facto dependency.

On versioning. URL-prefix versioning (`/api/v2/`) is debuggable but couples version to URL structure, which makes granular deprecation harder (deprecating one endpoint requires a full v-bump or a parallel URL). Header-based versioning is invisible in logs unless you instrument carefully, but enables per-endpoint deprecation. The staff-level answer is usually URL-prefix for major versions plus header-based feature gates for finer control. The ADR names which is which and why.

On delta sync cursors. Using RFC3339 timestamps as the `since` parameter is readable but exposes server time to the client, which couples the client to server clock behavior. The mature pattern is an opaque cursor token that the client never parses: the server encodes sequence numbers, timestamps, or whatever internal state it needs, and changes the encoding without notifying clients. The chapter's delta sync example uses RFC3339, which is fine for introductory material but should evolve to opaque cursors in production.

On cursor pagination. The cursor includes both `created_at` and `id` to handle ties, which is correct. What the staff-level implementation adds: a version byte in the cursor so the encoding can evolve, an expiration timestamp so stale cursors are rejected (six months is typical), and an HMAC signature so clients cannot forge cursors. Forged cursors are a real attack class because they allow a client to probe arbitrary positions in the feed, which may expose data the client should not see, or trigger expensive database queries outside the happy path.

On protobuf versus JSON. The table above is a decision matrix. The staff-level addition is the operational cost: protobuf requires schema distribution, code generation across iOS, Android, and backend, and a field-number-immutability discipline enforced across a distributed team. At small scale JSON with Brotli is within 20% of protobuf on wire size at zero coordination cost. At large scale the 20% and the type safety and the streaming benefits of gRPC/Connect dominate. The crossover point is usually around fifty engineers working on the same API surface. Below that, the coordination cost of protobuf exceeds its wire-size benefit. Above that, protobuf pays for itself in correctness.

The staff-level synthesis is that these patterns form a stack where each layer constrains the others. Sparse fieldsets require schema registry. Schema registry requires versioning discipline. Versioning discipline requires observability on field usage. Observability requires analytics that are governed by... schema registry. The ouroboros is not a bug. It is the reason mobile backend architecture at scale is a portfolio rather than a pile of endpoints.

---
