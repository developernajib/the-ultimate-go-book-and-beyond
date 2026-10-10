## 42.6 Rate Limit Headers and Responses

### Standard Headers

Two header conventions exist in the wild, and it is worth being precise about the standards status of each, because this area is widely misreported.

The `X-RateLimit-*` style popularized by GitHub and Twitter (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) is the de facto legacy. It is not standardised anywhere, and different APIs disagree about whether `Reset` is a Unix timestamp, a millisecond timestamp, or seconds remaining.

The IETF convention comes from `draft-ietf-httpapi-ratelimit-headers`, which is **still an Internet-Draft and not an RFC**. Do not let anyone tell you it is RFC 9651. RFC 9651 is *Structured Field Values for HTTP*, the generic framework for parsing header syntax. The relationship is real but indirect: the RateLimit draft is *expressed using* the data types RFC 9651 defines, which is why its values look like `"name";q=100;w=60` instead of ad-hoc comma soup. Citing RFC 9651 as the rate limit standard is a category error, roughly like citing the JSON grammar as the standard for your payments API.

The draft's own shape changed materially over its life. Early revisions defined `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` mirroring the legacy trio. Later revisions **withdrew those three** and consolidated them into one `RateLimit` header paired with `RateLimit-Policy`. Code and blog posts teaching the three-header form are targeting a version that no longer exists.

Both conventions pair with the same HTTP furniture: `429 Too Many Requests` (RFC 6585) as the status, and `Retry-After` (RFC 9110, either seconds or an HTTP-date) as the retry hint. Always set `Retry-After` on a `429`. It is the one field every HTTP client library already understands.

```go
// ... imports omitted for brevity (encoding/json, fmt, net/http, strconv, time)

// Headers carries rate limit state for one policy.
type Headers struct {
    Policy    string        // policy name, e.g. "per-user"
    Limit     int           // quota (q)
    Window    time.Duration // window (w)
    Remaining int           // remaining (r)
    Reset     time.Duration // time until reset (t) -- a DURATION, not an instant

    RetryAfter time.Duration
}

// retryAfterSecs converts a delay to whole seconds, rounding UP and flooring
// at 1. Both the header and the response body call this, so the two can never
// disagree. Computing "seconds" twice in two places is how a body that says
// "retry in 1s" ends up next to a header that says 2.
func retryAfterSecs(d time.Duration) int {
    secs := int(d.Seconds())
    if time.Duration(secs)*time.Second < d {
        secs++ // never hand back a delay that still lands inside the window
    }
    return max(secs, 1)
}

// SetHeaders writes the IETF draft headers plus legacy compatibility headers.
func (h Headers) SetHeaders(w http.ResponseWriter) {
    remaining := max(h.Remaining, 0)
    resetSecs := max(int(h.Reset.Seconds()), 0)

    // Current draft shape: one RateLimit header + one RateLimit-Policy.
    w.Header().Set("RateLimit-Policy",
        fmt.Sprintf("%q;q=%d;w=%d", h.Policy, h.Limit, int(h.Window.Seconds())))
    w.Header().Set("RateLimit",
        fmt.Sprintf("%q;r=%d;t=%d", h.Policy, remaining, resetSecs))

    // Legacy compatibility. Note X-RateLimit-Reset is an absolute Unix
    // timestamp because that is what GitHub-style clients parse, while the
    // draft's t is seconds remaining. Two conventions, two meanings, one
    // response. Emitting the same integer into both is the single most
    // common bug in this area.
    w.Header().Set("X-RateLimit-Limit", strconv.Itoa(h.Limit))
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
    w.Header().Set("X-RateLimit-Reset",
        strconv.FormatInt(time.Now().Add(h.Reset).Unix(), 10))

    // Retry-After (RFC 9110) is whole seconds, minimum 1. A Retry-After of
    // 0 invites an immediate retry, which is how a 429 storm starts.
    if h.RetryAfter > 0 {
        w.Header().Set("Retry-After", strconv.Itoa(retryAfterSecs(h.RetryAfter)))
    }
}

// RateLimitError writes a 429 as an RFC 9457 Problem Details document, the
// same error shape the rest of the API uses.
func RateLimitError(w http.ResponseWriter, r *http.Request, h Headers) {
    // A 429 must ALWAYS carry Retry-After. Note the clamp: Reset can be zero
    // or negative if the window elapsed between the limiter check and here,
    // and `if h.RetryAfter > 0` would then silently skip the header on the
    // one response that most needs it.
    if h.RetryAfter <= 0 {
        h.RetryAfter = max(h.Reset, time.Second)
    }
    h.SetHeaders(w)

    w.Header().Set("Content-Type", "application/problem+json")
    w.WriteHeader(http.StatusTooManyRequests)

    retryAfterSeconds := retryAfterSecs(h.RetryAfter)

    json.NewEncoder(w).Encode(map[string]any{
        "type":   "https://example.com/probs/rate-limit-exceeded",
        "title":  "Too Many Requests",
        "status": http.StatusTooManyRequests,
        "detail": fmt.Sprintf("Quota exhausted for policy %q. Retry in %ds.",
            h.Policy, retryAfterSeconds),
        "instance": r.URL.Path,

        // Extension members. Field names here must match what the docs and
        // the SDK tests assert. Pick one name and never drift.
        "policy":              h.Policy,
        "limit":               h.Limit,
        "remaining":           max(h.Remaining, 0),
        "retry_after_seconds": retryAfterSeconds,
    })
}
```

### Junior → FAANG: Rate Limit Headers as a Client Contract

Rate limit headers are not a courtesy feature. They are a contract between your API and every SDK or integration that calls it. Without them, clients have no choice but to guess when to retry, which produces thundering herds: all rate-limited clients waiting an arbitrary interval and retrying simultaneously, overwhelming the server again the moment the window resets.

The three most important things to learn about headers at this level:

First, always set `Retry-After` on every `429` response. RFC 9110 defines it as either a number of seconds or an HTTP-date. Seconds is simpler and universally supported. Watch the boundary conditions: round the value **up**, never down, and floor it at 1. A `Retry-After` that expires just before the window does invites a retry that is rejected again, and a client that gets burned twice starts ignoring your header entirely.

Second, understand the difference between the reset value formats, because the two conventions genuinely disagree. GitHub's `X-RateLimit-Reset` is a Unix epoch timestamp (an instant). The IETF draft's `t` parameter is seconds remaining (a duration). Some APIs use milliseconds. Others use seconds-until-reset under the GitHub-style name. Pick one meaning per header name, document it, and never copy the same integer into both conventions. The classic downstream symptom is an SDK computing a negative sleep and retrying immediately, or sleeping until the year 2054.

Third, `RateLimit-Policy` can describe multiple quotas in one header, for example 100 requests per minute alongside 10,000 per day. This matters when your API has both short-burst limits and daily quotas: without it, a client cannot tell "slow down for a minute" from "you are done for the day."

First-job habit: write an integration test that issues requests until it receives a `429`, then asserts that `Retry-After` is present and at least 1, that the body's `retry_after_seconds` **equals the header**, and that sleeping for that long actually produces a success. That last assertion is the one that matters, and it is the one everyone skips. A limiter whose `Retry-After` does not actually predict when you may retry is worse than no header at all.

### Senior @ FAANG: Headers as an Observability and SDK Governance Surface

**Headers as a Versioned API Contract**

At FAANG scale, rate limit headers are part of the versioned API surface area. Changing `X-RateLimit-Reset` from a Unix timestamp to a duration in seconds is a breaking change for any client that parsed the old format. This means header semantics need to go through the same change-management process as request/response schema changes: a deprecation notice, a migration guide, and a sunset date communicated through the developer portal.

An ADR worth writing: "Should we adopt the IETF `RateLimit` / `RateLimit-Policy` headers alongside the legacy `X-RateLimit-*` headers, or migrate fully?" The pragmatic answer for most platforms is to emit both for a defined compatibility window, log which clients still read the `X-` prefix variant, and retire the legacy headers only once your analytics show adoption of the new shape above an agreed threshold. Factor in that the IETF side is still a draft whose syntax has already changed once (the split three-header form was withdrawn in favour of the consolidated one). Adopting a draft means accepting that you may have to migrate again, which is an argument for keeping the emission logic in exactly one function, as above, rather than scattered across handlers.

**Clock Skew and the Reset Timestamp**

The `X-RateLimit-Reset` Unix timestamp assumes the client's clock is synchronized with the server's. In practice, client clocks can be minutes off. Both `Retry-After` and the draft's `t` parameter are durations rather than instants, which makes them immune to clock skew, and one of them should be the canonical retry hint. This is a large part of why the draft chose seconds-remaining over a timestamp in the first place. The reset timestamp is useful for dashboards and developer tooling, not for programmatic retry logic. An API style guide for your platform should codify this distinction and require SDK authors to derive retry delay from `Retry-After`, not from `now - Reset`.

**Multi-Quota Response Design**

When a request can be limited by multiple independent quotas (per-user per-minute, per-tenant per-day, per-IP burst), the client needs to know which quota was exhausted to take the right action. `RateLimit-Policy` is a list, so it expresses this directly:

```
RateLimit-Policy: "per-user";q=100;w=60, "per-tenant";q=10000;w=86400
RateLimit: "per-user";r=0;t=42
```

Read the syntax carefully, since it is frequently written wrong. Each policy is a **structured-field item**: a quoted policy name first, then parameters hung off it with semicolons. The name is not a `name=` parameter, and `RateLimit` is not a bag of `key=value` pairs. `q` is the quota, `w` the window in seconds, `r` the remaining count, `t` the seconds until reset.

Here `RateLimit` names `per-user` as the binding policy, with 0 remaining and 42 seconds to go, while `RateLimit-Policy` advertises that a per-tenant daily quota also exists. Without that signal a client cannot distinguish "slow down for 42 seconds" from "you are finished until tomorrow," and the two call for completely different client behaviour: one is a sleep, the other is a page to a human.

**Standardization Governance**

Staff engineers operating a developer platform must track `draft-ietf-httpapi-ratelimit-headers` toward RFC status and decide when to adopt it. The decision involves SDK compatibility (older SDK versions will not parse header names that did not exist when they shipped), gateway support (does your API gateway strip or forward unfamiliar headers), and documentation (header semantics need to appear in the OpenAPI spec for every endpoint). Establish a working group that owns header standards across all internal APIs and reviews external-facing header changes as a platform-level concern, not a per-team decision.

A related governance habit: require citations in design docs to name the document number and its actual title. This chapter previously described the rate limit headers as "RFC 9651," which is *Structured Field Values for HTTP* and says nothing about rate limiting. That kind of error is contagious, because the next engineer copies the citation rather than checking it, and eventually a customer-facing doc claims conformance to a specification the API has never implemented. Checking a citation costs thirty seconds.

**Bar-Raiser Interview Signals**

"What is the risk of using a Unix timestamp for `X-RateLimit-Reset` instead of a seconds-until-reset value?" The answer must cover clock skew, the ambiguity of milliseconds vs seconds, and why `Retry-After` (a duration) is the safer primitive for programmatic retry logic.

"How would you design the header contract for an API that has per-user, per-tenant, and per-IP limits, all of which can independently trigger a `429`?" Strong answers reference the `RateLimit-Policy` list form, discuss the need to identify which quota was the binding constraint, and address how SDKs should behave when multiple limits are simultaneously near exhaustion. A candidate who also notes that the draft calls these fields informative hints rather than guarantees, so clients must still handle an unpredicted 429, is showing they read the spec rather than a blog post about it.

---
