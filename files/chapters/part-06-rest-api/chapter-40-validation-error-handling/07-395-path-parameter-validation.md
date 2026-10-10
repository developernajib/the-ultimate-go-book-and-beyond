## 40.5 Path Parameter Validation

### Path Parameter Validators

`PathValidator.UUID` parses the value with `uuid.Parse` before returning it, so a handler never processes a malformed identifier that would cause a confusing database error downstream. The `Location: "path"` field in the error detail helps API clients distinguish path parameter violations from body or query string problems.

Note that it returns `parsed.String()`, not the raw path segment. `uuid.Parse` deliberately accepts several textual forms, so the canonical string, the `urn:uuid:` form, the braced form, the unhyphenated form, and any casing of each all parse successfully to the same value. Returning the raw segment lets five different URLs address one row, which silently breaks cache keys, idempotency keys, and audit trails. Parse, then hand the rest of the system the canonical form and nothing else.

```go
// ... imports omitted for brevity (fmt, net/http, regexp, strconv,
// github.com/go-chi/chi/v5, github.com/google/uuid)

// PathValidator validates path parameters
type PathValidator struct {
    r      *http.Request
    errors []ErrorDetail
}

func NewPathValidator(r *http.Request) *PathValidator {
    return &PathValidator{r: r}
}

func (v *PathValidator) UUID(name string) string {
    value := chi.URLParam(v.r, name)
    if value == "" {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "REQUIRED",
            Message:  fmt.Sprintf("%s is required", name),
            Location: "path",
        })
        return ""
    }

    parsed, err := uuid.Parse(value)
    if err != nil {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "INVALID_UUID",
            Message:  fmt.Sprintf("%s must be a valid UUID", name),
            Value:    value,
            Location: "path",
        })
        return ""
    }

    // Return the canonical form, never the raw segment. uuid.Parse accepts
    // the URN, braced, unhyphenated, and mixed-case forms, all of which map
    // to this same value.
    return parsed.String()
}

func (v *PathValidator) Slug(name string) string {
    value := chi.URLParam(v.r, name)
    if value == "" {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "REQUIRED",
            Message:  fmt.Sprintf("%s is required", name),
            Location: "path",
        })
        return ""
    }

    // slugRegex is compiled once at package level, not per request.
    if !slugRegex.MatchString(value) {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "INVALID_SLUG",
            Message:  fmt.Sprintf("%s must be a valid slug", name),
            Value:    value,
            Location: "path",
        })
    }

    return value
}

func (v *PathValidator) Int(name string) int64 {
    value := chi.URLParam(v.r, name)
    if value == "" {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "REQUIRED",
            Message:  fmt.Sprintf("%s is required", name),
            Location: "path",
        })
        return 0
    }

    num, err := strconv.ParseInt(value, 10, 64)
    if err != nil {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "INVALID_TYPE",
            Message:  fmt.Sprintf("%s must be an integer", name),
            Value:    value,
            Location: "path",
        })
        return 0
    }

    return num
}

func (v *PathValidator) Errors() []ErrorDetail {
    return v.errors
}

func (v *PathValidator) HasErrors() bool {
    return len(v.errors) > 0
}

// Usage example
func getUserHandler(w http.ResponseWriter, r *http.Request) {
    pv := NewPathValidator(r)
    userID := pv.UUID("id")

    if pv.HasErrors() {
        ValidationErrorResponse(w, r, pv.Errors())
        return
    }

    user, err := userService.GetByID(r.Context(), userID)
    // ...
}
```

### Junior → FAANG: Prerequisites and Worked Example

The prerequisite vocabulary for path validation is smaller than body validation but more subtle. Start with what a path parameter actually is. In chi, `chi.URLParam(r, "id")` returns the substring the router captured from the URL pattern `/users/{id}`. The router has already percent-decoded the segment, which means a URL like `/users/%2E%2E%2Fadmin` becomes `../admin` before your validator sees it. If your validator only checks "non-empty" and you forward that value into a filesystem path or a URL template, you just built a path traversal vulnerability. The second prerequisite is understanding that Go's `strconv.ParseInt(value, 10, 64)` succeeds on leading zeros, so `"00000042"` parses to `42`. This matters when you build cache keys from the raw string because `/users/42` and `/users/00000042` become distinct cache entries for the same row, halving your hit rate and letting an attacker inflate cache memory cheaply. The third prerequisite is that `uuid.Parse` from `google/uuid` accepts multiple textual forms including the URN form `urn:uuid:...` and braced form `{...}`, which means two different strings can both parse successfully to the same UUID value. If you hash the raw string for an idempotency key, you get duplicate writes.

Worked example. An intern ships a feature where `GET /orders/{id}` looks up an order, and QA reports that `/orders/0` returns a 500 with a stack trace in production logs. You trace the flow: `pv.Int("id")` returns `0` on missing, the handler calls `orderService.GetByID(ctx, 0)`, the repository runs `SELECT ... WHERE id = 0` which returns no rows, and then unhandled code dereferences a nil order pointer. The junior fix is to add a nil check in the handler. The correct fix is two-layered. First, make `PathValidator.Int` take a min value so `0` becomes an explicit validation error, distinguishing "missing" from "zero" with a distinct sentinel return. Second, the repository should return a typed `ErrNotFound` that the handler maps to 404 via `errors.Is`. Now the same class of bug cannot resurface in any other handler.

Interview entry-point questions. Why is UUIDv4 sometimes a bad choice for primary keys even though validation is easy? Because v4 is random and destroys B-tree insert locality, producing write amplification on InnoDB and RocksDB. UUIDv7 embeds a millisecond timestamp in the high bits, giving you time-sortable IDs with the same uniqueness guarantee. Why does Stripe use prefixed IDs like `cust_abc123`? Because the prefix is a self-describing type tag that prevents a client from accidentally passing a subscription ID where a customer ID was expected, and it makes log grep trivially scoped. How would you validate a prefixed ID? Split on the first underscore, match the prefix against a per-route allowlist, then validate the suffix as a base62 string of fixed length. Identifier design comes up often enough in entry-level system design rounds that these three questions are worth having ready.

### Senior @ FAANG: Identifier Strategy and Path Hardening at Scale

At staff level, path parameter validation is the visible edge of a much larger identifier governance problem. The first decision is whether to expose primary keys at all. Exposing auto-increment integer IDs leaks business metrics (IDOR attackers count your daily signups, competitors watch your growth curve) and enables trivial enumeration. The industry-standard answer in 2026 is opaque prefixed IDs similar to Stripe's scheme, where the on-the-wire form is `cust_01HZ...` and the database actually stores a UUIDv7 or a ULID. The prefix gives you three production wins. You can route to different storage backends by prefix without URL restructuring. You can scope rate limits, audit logs, and permissions by type without reflecting on the value. And when a customer pastes an ID into a support ticket, the type is self-evident, cutting support triage time measurably. The validator becomes a single function per ID type registered in a central catalog, and the router is wired so `{customer_id}` implicitly applies the prefixed-ID validator for `cust_`.

UUIDv7 versus v4 is not a stylistic debate at scale. Random v4 keys scatter inserts across the whole keyspace, so once the index no longer fits in memory, each insert tends to touch a cold page and the buffer pool thrashes. v7 keys are time-ordered, so inserts append near the rightmost page and stay cache-resident. The size of the gap depends on your row width, index count, buffer pool size, and write rate, so measure it on your own schema rather than trusting a number from a blog post, but the direction is consistent and the effect grows as the table outgrows RAM. For high-write tables (events, audit logs, messages) this is the difference between a single primary and needing to shard. The caveat is that v7 leaks creation time, which is a side-channel in some threat models (knowing a user account was created seconds before a targeted phishing event has value to an attacker). For security-sensitive resources (password reset tokens, session IDs, invitation codes) you still use v4 or a CSPRNG-derived opaque string, never v7. The validator must not care which generation algorithm produced the value, only that the textual form is well-formed.

Integer ID parsing has three subtle production hazards. Overflow: `ParseInt(value, 10, 64)` rejects numbers larger than `2^63-1`, but if downstream code casts to `int32` for a legacy gRPC proto, you get silent truncation where `4294967298` becomes `2`. Always parse into the narrowest type the downstream consumer needs, or validate `num <= math.MaxInt32` explicitly before casting. Leading zeros: described above, and the fix is to re-encode the parsed int back to string with `strconv.FormatInt` and compare to the original, rejecting any mismatch. Negative values: a common bug is `/items/-1` passing validation and then being used as a slice index or an offset in pagination math. The min bound is mandatory, not optional.

Path traversal prevention deserves its own review gate when the service touches any filesystem or object-store path. The attack surface is anywhere you do `filepath.Join(baseDir, userInput)` or `s3Bucket + "/" + userInput`. Defense in depth: validate the parameter against a strict character class (`[a-zA-Z0-9_-]+` for most IDs), call `filepath.Clean` and then assert `strings.HasPrefix(cleaned, baseDir+string(filepath.Separator))`, and finally open with `os.OpenFile` in a directory that has been `openat2`-scoped on Linux via the `golang.org/x/sys/unix` wrapper with `RESOLVE_BENEATH`. The cleaned-prefix check alone is defeated by symlinks on some filesystems, which is why the kernel-enforced `RESOLVE_BENEATH` flag is the belt-and-braces answer for services that serve user-uploaded content.

URL normalization before routing is an under-appreciated control. Many routers perform case-sensitive matching on path segments, so `/Users/123` and `/users/123` route differently, and if only one path has a validator wired, the other is a bypass. Standard practice is a middleware that collapses duplicate slashes, resolves `.` and `..` segments, and rejects any path containing null bytes, before the router dispatches. Resist the temptation to lowercase the whole path: it normalizes the static route segments you wanted, and also destroys the case-sensitive parameter segments you did not, turning a base62 or ULID identifier like `cust_01HZAB` into a different and probably nonexistent ID. If you want case-insensitive routing, apply it to the registered route prefixes only and leave captured parameters untouched. The middleware should also enforce a maximum path length, because unbounded paths are free memory and CPU for an attacker and no legitimate client needs them, and emit a metric for normalization rewrites so you can see which clients are sending noisy URLs.

Observability for path validation ties back to the error catalog. Each rejection emits `route_template` (the pattern, not the concrete path, to avoid high-cardinality metric explosion), `param_name`, `error_code`, and a hash of the offending value. The hash lets you detect scanning patterns (thousands of distinct invalid UUIDs from one source IP) without logging PII. Pair this with a per-route counter of 404s from validation failures versus 404s from not-found-in-database, because the ratio is diagnostic: a sudden spike in validation 404s means a deployed client is constructing malformed URLs, while a spike in database 404s usually means a data migration deleted rows a client still references.

---
