export default `## Section 5: encoding/json/v2

As of Go 1.26, \`encoding/json/v2\` is available inside the standard library but still behind the \`GOEXPERIMENT=jsonv2\` build flag, not yet covered by the Go 1 compatibility promise. The Go team stood up a dedicated working group in late 2025 to drive stabilization. Expect promotion in a near-future release, check the Go release notes before shipping production code against it. The older external experiment \`github.com/go-json-experiment/json\` tracks the same design and is useful for teams that want to try v2 without enabling the GOEXPERIMENT flag.

The v2 design fixes a long list of v1 corners (case-insensitive key matching by default, silent duplicate keys, slow reflection, weak streaming support) without breaking existing v1 code, which remains the default.

### 5.1 Key Improvements

The \`encoding/json/v2\` package redesigns JSON handling with case-sensitive key matching by default, correct handling of duplicate keys, a streaming API, and significantly improved performance.

\`\`\`
json/v1 Issues:              json/v2 Fixes:
─────────────                ─────────────
Inconsistent nil vs empty    Consistent null handling
No streaming marshal         Full streaming support
Slow reflection              Faster codec caching
No custom marshaling context Options via context
Duplicate key handling       Strict duplicate rejection
Int64 precision loss         Proper number handling
\`\`\`

### 5.2 json/v2 Usage

The v2 API is largely compatible with v1 but has breaking changes in default behavior around case sensitivity and unknown field handling. Migration requires explicit opt-in to preserve v1 semantics where needed.

\`\`\`go
package jsonv2

import (
	"bytes"
	"context"
	"io"
	"time"

	// Use the experimental package until stdlib promotion
	"github.com/go-json-experiment/json"
	"github.com/go-json-experiment/json/jsontext"
)

// Basic marshaling - much faster than v1
type User struct {
	ID        int64     \`json:"id"\`
	Name      string    \`json:"name"\`
	Email     string    \`json:"email,omitempty"\`
	CreatedAt time.Time \`json:"created_at"\`
	Tags      []string  \`json:"tags,omitempty"\`

	// v2-specific: omitzero for zero values (not just nil)
	Score float64 \`json:"score,omitzero"\`

	// v2-specific: inline embedding
	Address \`json:",inline"\`
}

type Address struct {
	Street  string \`json:"street"\`
	City    string \`json:"city"\`
	Country string \`json:"country"\`
}

// Marshal with options
func MarshalUser(u User) ([]byte, error) {
	return json.Marshal(u, json.WithMarshalers(
		// Custom marshaler for time.Time
		json.MarshalFuncV2(func(enc *jsontext.Encoder, t time.Time, opts json.Options) error {
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

	if err := enc.WriteToken(jsontext.Delim('[')); err != nil {
		return err
	}

	for _, item := range items {
		if err := json.MarshalEncode(enc, item); err != nil {
			return err
		}
	}

	return enc.WriteToken(jsontext.Delim(']'))
}

// v2 Options system replaces json.Decoder/Encoder methods
func DecodeStrict(data []byte, v any) error {
	return json.Unmarshal(data, v,
		json.RejectUnknownMembers(true),  // Fail on unknown fields
		json.AllowDuplicateNames(false),  // Fail on duplicate keys
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

// Custom marshaler/unmarshaler interface (v2 style)
type Duration time.Duration

func (d Duration) MarshalJSONV2(enc *jsontext.Encoder, opts json.Options) error {
	return enc.WriteToken(jsontext.String(time.Duration(d).String()))
}

func (d *Duration) UnmarshalJSONV2(dec *jsontext.Decoder, opts json.Options) error {
	tok, err := dec.ReadToken()
	if err != nil {
		return err
	}
	if tok.Kind() != '"' {
		return &json.SemanticError{GoType: nil, Err: nil}
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
	data := []byte(\`{"id":1,"name":"Alice","email":"alice@example.com","created_at":"2024-01-01T00:00:00Z"}\`)

	// v1: uses reflection on every call (slower)
	// v2: caches codec, 2-3x faster for repeated types

	var u User
	_ = json.Unmarshal(data, &u)  // v2

	// JSON streaming for large datasets
	var buf bytes.Buffer
	enc := jsontext.NewEncoder(&buf)
	_ = json.MarshalEncode(enc, u)
}
\`\`\`

### Adoption Story

\`encoding/json/v2\` is in \`GOEXPERIMENT=jsonv2\` in 1.26 and is on track to become the default in a future release (likely 1.27 or 1.28). The case for adopting now:

1. **Performance.** Two to three times faster on repeated marshalling of the same type. For services where JSON encoding/decoding is a measurable share of CPU, the win is real.
2. **Correctness.** v2 fixes long-standing inconsistencies in v1 (case-insensitive matching, default tag handling, behaviour around \`omitempty\` with zero-but-explicitly-set fields). Some of the changes are breaking, which is why the migration is opt-in.
3. **Streaming API.** v2 introduces a streaming encoder/decoder (\`jsontext.NewEncoder\`, \`jsontext.NewDecoder\`) that is more flexible than v1's. For large-payload services, this is a real ergonomic win.

The case for waiting:

1. **Breaking changes.** Some v1 behaviours that teams accidentally depended on are changed. A migration audit is required.
2. **Stability.** As of 1.26, v2 is still behind a \`GOEXPERIMENT\` flag. Production adoption is a calculated risk.
3. **Library compatibility.** Third-party libraries that wrap \`encoding/json\` may not yet support v2. The transition will take a release or two.

The senior-track recommendation: pilot v2 in one non-critical service. Build the migration playbook. Be ready to roll out fleet-wide when v2 lands without the experiment flag.

### Code-Review Lens (Senior Track)

Three patterns to flag in v1-to-v2 migration PRs:

1. **A naive \`s/json/jsonv2/g\` substitution.** The behavioural differences require an audit, not a renaming.
2. **A test suite that does not cover serialisation round-trips.** The migration changes the wire format in subtle ways. Without round-trip tests, regressions go undetected.
3. **A breaking change to an external API.** If your service exposes JSON to external consumers, v2's serialisation differences may be a breaking change for them. Coordinate the rollout.

### Migration Lens

The closest analogue to \`encoding/json/v2\` in other languages is the major-version split that JSON libraries periodically undergo (Jackson 2.x to 3.x in Java, simplejson to ujson in Python, JSON.NET to System.Text.Json in C#). Each of these has the same shape: a faster, more correct successor that requires a migration audit. Go's discipline of "the same package, but versioned" is unusual. The equivalent in npm would be a separately-named package.

---
`;
