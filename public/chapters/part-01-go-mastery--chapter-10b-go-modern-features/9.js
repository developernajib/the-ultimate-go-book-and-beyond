export default `## 10B.7 json/v2 (encoding/json/v2)

### Breaking Changes from json v1

Go 1.26 introduces \`encoding/json/v2\` with improved semantics. The package ships inside the standard library but is still gated by \`GOEXPERIMENT=jsonv2\` at build time, it is not yet covered by the Go 1 compatibility promise. Expect stabilization in a near-future release and check the Go release notes before depending on it in production. The original \`encoding/json\` remains unchanged.

\`\`\`go
// Requires: GOEXPERIMENT=jsonv2 go build ./...
import "encoding/json/v2"
\`\`\`

The behavioral changes fall into four categories: zero-value handling, field matching, output escaping, and unknown field treatment. Each one can break existing code that relied on v1 defaults.

**1. Zero-value omission:**
\`\`\`go
type User struct {
    Name  string \`json:"name"\`
    Email string \`json:"email,omitzero"\` // v2: explicit opt-in to omit zero values
    Age   int    \`json:"age,omitzero"\`
}

// v1 behavior with "omitempty":
// - Omits: "", 0, false, nil, empty slice/map
// - Does NOT omit: struct{}, custom types with zero value

// v2 behavior with "omitzero":
// - Omits any value where v == zero(T) - works correctly for all types
// - More predictable, no surprising behavior with custom types
\`\`\`

**2. Case-sensitive field matching:**
\`\`\`go
// v1: case-insensitive field matching
// {"Name": "Alice"} matches json:"name" in v1

// v2: case-sensitive by default
// {"Name": "Alice"} does NOT match json:"name" in v2
// Use json:",nocase" for case-insensitive matching when needed

type User struct {
    Name string \`json:"name"\`          // v2: only "name" matches, not "Name"
    Email string \`json:"email,nocase"\` // v2: explicit case-insensitive opt-in
}
\`\`\`

**3. No HTML escaping by default:**
\`\`\`go
// v1: Marshal always HTML-escapes <, >, &
// output: "link": "\\u003ca\\u003e" for "link": "<a>"

// v2: No HTML escaping by default (correct for JSON APIs)
data := map[string]string{"url": "https://example.com?a=1&b=2"}

// v1:
b1, _ := jsonv1.Marshal(data)
// {"url":"https://example.com?a=1\\u0026b=2"}  ← HTML-escaped

// v2:
b2, _ := jsonv2.Marshal(data)
// {"url":"https://example.com?a=1&b=2"}  ← clean
\`\`\`

**4. Strict unknown field handling:**
\`\`\`go
// v2: unknown fields are an error by default (use json:",unknown" to collect them)
type Config struct {
    Host string \`json:"host"\`
    Port int    \`json:"port"\`
    // json/v2: extra field causes decode error
    // json/v1: extra field silently ignored
}

// To preserve v1 behavior in v2:
type Config struct {
    Host    string         \`json:"host"\`
    Port    int            \`json:"port"\`
    Unknown map[string]any \`json:",unknown"\` // Capture unknown fields
}
\`\`\`

### Migration Guide

Migrating from \`encoding/json\` to \`encoding/json/v2\` is not a drop-in replacement due to behavioral changes in key matching, unknown field handling, and number marshaling. This guide covers the most common issues.

\`\`\`go
// Safe migration: use v2 for new code, migrate existing code gradually

// Wrapper for transition period - same interface, v2 semantics
package jsonutil

import (
    "encoding/json/v2"
)

// Marshal is v2 Marshal
func Marshal(v any) ([]byte, error) {
    return json.Marshal(v)
}

// MarshalV1Compat marshals with v1-compatible HTML escaping
func MarshalV1Compat(v any) ([]byte, error) {
    return json.MarshalOptions{EscapeHTML: true}.Marshal(v)
}

// Unmarshal is v2 Unmarshal (strict unknown fields)
func Unmarshal(data []byte, v any) error {
    return json.Unmarshal(data, v)
}

// UnmarshalV1Compat unmarshals with v1 case-insensitive, unknown-field-ignoring behavior
func UnmarshalV1Compat(data []byte, v any) error {
    return json.UnmarshalOptions{
        RejectUnknownMembers: false,
    }.Unmarshal(data, v)
}

// Testing: verify JSON output is identical between v1 and v2
func TestMarshalCompatibility(t *testing.T) {
    users := []User{
        {Name: "Alice", Email: "alice@example.com", Age: 30},
    }

    v1Out, _ := jsonv1.Marshal(users)
    v2Out, _ := jsonv2.Marshal(users)

    // Note: v2 may differ in HTML-escaped characters
    // Use explicit comparison of parsed output
    var v1Parsed, v2Parsed any
    jsonv1.Unmarshal(v1Out, &v1Parsed)
    jsonv1.Unmarshal(v2Out, &v2Parsed)
    assert.Equal(t, v1Parsed, v2Parsed)
}
\`\`\`

---
`;
