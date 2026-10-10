## Section 5: encoding/json/v2

In Go 1.25, `encoding/json/v2` shipped inside the standard library behind the `GOEXPERIMENT=jsonv2` build flag, and it stayed experimental through Go 1.26. Go 1.27 (shipped August 2026, baseline 1.27.1) promotes it: `encoding/json/v2` is generally available, and the classic `encoding/json` API is itself implemented on top of the v2 engine, so v1 callers get the performance gains without a code change (`GOEXPERIMENT=nojsonv2` restores the old implementation during the transition). The older external experiment `github.com/go-json-experiment/json` tracks the same design and remains useful for teams still on 1.26.

The v2 design fixes a long list of v1 corners (case-insensitive key matching by default, silent duplicate keys, slow reflection, weak streaming support) without breaking existing v1 code, which remains the default.

### 5.1 Key Improvements

The `encoding/json/v2` package redesigns JSON handling with case-sensitive key matching by default, correct handling of duplicate keys, a streaming API, and significantly improved performance.

```
json/v1 Issues:              json/v2 Fixes:
─────────────                ─────────────
Inconsistent nil vs empty    Consistent null handling
No streaming marshal         Full streaming support
Slow reflection              Faster codec caching
No custom marshaling context Options via context
Duplicate key handling       Strict duplicate rejection
Int64 precision loss         Proper number handling
```

### 5.2 json/v2 Usage

The v2 API is largely compatible with v1 but has breaking changes in default behavior around case sensitivity and unknown field handling. Migration requires explicit opt-in to preserve v1 semantics where needed.

```go
package jsonv2

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"time"

	// In the stdlib since Go 1.25 behind GOEXPERIMENT=jsonv2, GA in Go 1.27.
	// On older toolchains, github.com/go-json-experiment/json mirrors this API.
	"encoding/json/jsontext"
	"encoding/json/v2"
)

// Basic marshaling with the v2 engine
type User struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Tags      []string  `json:"tags,omitempty"`

	// omitzero omits zero values, not just empty ones
	// (introduced by v2, backported to v1 in Go 1.24)
	Score float64 `json:"score,omitzero"`

	// v2-specific: inline embedding
	Address `json:",inline"`
}

type Address struct {
	Street  string `json:"street"`
	City    string `json:"city"`
	Country string `json:"country"`
}

// Marshal with options
func MarshalUser(u User) ([]byte, error) {
	return json.Marshal(u, json.WithMarshalers(
		// Custom marshaler for time.Time
		json.MarshalToFunc(func(enc *jsontext.Encoder, t time.Time) error {
			return enc.WriteToken(jsontext.String(t.UTC().Format(time.RFC3339Nano)))
		}),
	))
}

// Streaming JSON encoding (v2 fully supports this)
type StreamEncoder struct {
	w io.Writer
}

func NewStreamEncoder(w io.Writer) *StreamEncoder {
	return &StreamEncoder{w: w}
}

func (se *StreamEncoder) EncodeArray(items []User) error {
	enc := jsontext.NewEncoder(se.w)

	if err := enc.WriteToken(jsontext.BeginArray); err != nil {
		return err
	}

	for _, item := range items {
		if err := json.MarshalEncode(enc, item); err != nil {
			return err
		}
	}

	return enc.WriteToken(jsontext.EndArray)
}

// v2 Options system replaces json.Decoder/Encoder methods
func DecodeStrict(data []byte, v any) error {
	return json.Unmarshal(data, v,
		json.RejectUnknownMembers(true),      // Fail on unknown fields
		jsontext.AllowDuplicateNames(false),  // Fail on duplicate keys (the v2 default)
	)
}

// Context-aware options
type RequestOptions struct {
	AllowUnknownFields bool
	StrictNumbers      bool
}

func DecodeWithContext(ctx context.Context, data []byte, v any) error {
	opts, _ := ctx.Value("json_opts").(RequestOptions)

	options := []json.Options{}
	if !opts.AllowUnknownFields {
		options = append(options, json.RejectUnknownMembers(true))
	}

	return json.Unmarshal(data, v, options...)
}

// Custom marshaler/unmarshaler interfaces (v2's MarshalerTo/UnmarshalerFrom)
type Duration time.Duration

func (d Duration) MarshalJSONTo(enc *jsontext.Encoder) error {
	return enc.WriteToken(jsontext.String(time.Duration(d).String()))
}

func (d *Duration) UnmarshalJSONFrom(dec *jsontext.Decoder) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	if tok.Kind() != '"' {
		return fmt.Errorf("duration: expected JSON string, got %v", tok.Kind())
	}
	dur, err := time.ParseDuration(tok.String())
	if err != nil {
		return err
	}
	*d = Duration(dur)
	return nil
}

// Performance comparison
func BenchmarkComparison() {
	data := []byte(`{"id":1,"name":"Alice","email":"alice@example.com","created_at":"2024-01-01T00:00:00Z"}`)

	// v2 unmarshal runs roughly 2-3x faster than v1 on typical payloads
	// v2 marshal is at par with v1 or modestly faster

	var u User
	_ = json.Unmarshal(data, &u)  // v2

	// JSON streaming for large datasets
	var buf bytes.Buffer
	enc := jsontext.NewEncoder(&buf)
	_ = json.MarshalEncode(enc, u)
}
```

### Adoption Story

`encoding/json/v2` is generally available since Go 1.27 (baseline 1.27.1, `GOEXPERIMENT=jsonv2` in 1.25 and 1.26). The case for adopting now:

1. **Performance.** Decoding is where the big win is: v2 unmarshal runs two to three times faster than v1 on typical payloads, while marshal is at par or modestly faster. For services where JSON decoding is a measurable share of CPU, the win is real.
2. **Correctness.** v2 fixes long-standing inconsistencies in v1 (case-insensitive matching, default tag handling, behavior around `omitempty` with zero-but-explicitly-set fields). Some of the changes are breaking, which is why the migration is opt-in.
3. **Streaming API.** v2 introduces a streaming encoder/decoder (`jsontext.NewEncoder`, `jsontext.NewDecoder`) that is more flexible than v1's. For large-payload services, this is a real ergonomic win.

The case for waiting:

1. **Breaking changes.** Some v1 behaviors that teams accidentally depended on are changed. A migration audit is required.
2. **Stability.** As of 1.27.1, v2 is GA and backs `encoding/json`. Keep `GOEXPERIMENT=nojsonv2` only as a temporary rollback during migration.
3. **Library compatibility.** Third-party libraries that wrap `encoding/json` may not yet support v2. The transition will take a release or two.

The senior-track recommendation: roll v2 out service by service with the migration playbook (round-trip tests, wire-format audit for external consumers). The engine swap is free, the v2 API is opt-in per package.

### Code-Review Lens (Senior Track)

Three patterns to flag in v1-to-v2 migration PRs:

1. **A naive `s/json/jsonv2/g` substitution.** The behavioral differences require an audit, not a renaming.
2. **A test suite that does not cover serialization round-trips.** The migration changes the wire format in subtle ways. Without round-trip tests, regressions go undetected.
3. **A breaking change to an external API.** If your service exposes JSON to external consumers, v2's serialization differences may be a breaking change for them. Coordinate the rollout.

### Migration Lens

The closest analogue to `encoding/json/v2` in other languages is the major-version split that JSON libraries periodically undergo (Jackson 2.x to 3.x in Java, simplejson to ujson in Python, JSON.NET to System.Text.Json in C#). Each of these has the same shape: a faster, more correct successor that requires a migration audit. Go's discipline of "the same package, but versioned" is unusual. The equivalent in npm would be a separately-named package.

---
