## 10B.7 json/v2 (encoding/json/v2)

### Breaking Changes from json v1

Go 1.25 introduced `encoding/json/v2` inside the standard library, gated by `GOEXPERIMENT=jsonv2` at build time (still gated in Go 1.26). Go 1.27 (shipped August 2026, baseline 1.27.1) promotes it to general availability and reimplements the classic `encoding/json` on top of the v2 engine, so v1 callers inherit the performance without a code change (`GOEXPERIMENT=nojsonv2` is the transition escape hatch). The v1 API itself remains unchanged.

```go
// Requires: GOEXPERIMENT=jsonv2 go build ./...
import "encoding/json/v2"
```

The behavioral changes fall into four categories: zero-value handling, field matching, output escaping, and unknown or duplicate field treatment. Each one can break existing code that relied on v1 defaults.

**1. Zero-value omission:**
```go
type User struct {
    Name  string `json:"name"`
    Email string `json:"email,omitzero"` // v2: explicit opt-in to omit zero values
    Age   int    `json:"age,omitzero"`
}

// v1 behavior with "omitempty":
// - Omits: "", 0, false, nil, empty slice/map
// - Does NOT omit: struct{}, custom types with zero value

// v2 behavior with "omitzero":
// - Omits any value where v == zero(T), works correctly for all types
// - More predictable, no surprising behavior with custom types
```

**2. Case-sensitive field matching:**
```go
// v1: case-insensitive field matching
// {"Name": "Alice"} matches json:"name" in v1

// v2: case-sensitive by default
// {"Name": "Alice"} does NOT match json:"name" in v2
// Use json:",case:ignore" for case-insensitive matching when needed

type User struct {
    Name string `json:"name"`                // v2: only "name" matches, not "Name"
    Email string `json:"email,case:ignore"` // v2: explicit case-insensitive opt-in
}
```

**3. No HTML escaping by default:**
```go
// v1: Marshal always HTML-escapes <, >, &
// output: "link": "\u003ca\u003e" for "link": "<a>"

// v2: No HTML escaping by default (correct for JSON APIs)
data := map[string]string{"url": "https://example.com?a=1&b=2"}

// v1:
b1, _ := jsonv1.Marshal(data)
// {"url":"https://example.com?a=1\u0026b=2"}  ← HTML-escaped

// v2:
b2, _ := jsonv2.Marshal(data)
// {"url":"https://example.com?a=1&b=2"}  ← clean
```

**4. Unknown and duplicate field handling:**
```go
// v2: unknown fields are still ignored by default, but you can now
// reject them explicitly or capture them:

// Reject: json.Unmarshal(data, &cfg, json.RejectUnknownMembers(true))

// Capture:
type Config struct {
    Host    string         `json:"host"`
    Port    int            `json:"port"`
}

// v2 also rejects duplicate member names when decoding:
// {"host":"a","host":"b"} is an error in v2, v1 silently kept the last value
```

### Migration Guide

Migrating from `encoding/json` to `encoding/json/v2` is not a drop-in replacement due to behavioral changes in key matching, output escaping, and duplicate field handling. This guide covers the most common issues.

```go
// Safe migration: use v2 for new code, migrate existing code gradually

// Wrapper for transition period: same interface, v2 semantics
package jsonutil

import (
    jsonv1 "encoding/json"
    json "encoding/json/v2"
)

// Marshal is v2 Marshal
func Marshal(v any) ([]byte, error) {
    return json.Marshal(v)
}

// MarshalV1Compat marshals with full v1 semantics (HTML escaping,
// nil slices as null, and the rest of the v1 defaults)
func MarshalV1Compat(v any) ([]byte, error) {
    return json.Marshal(v, jsonv1.DefaultOptionsV1())
}

// Unmarshal is v2 Unmarshal (case-sensitive, duplicate names rejected)
func Unmarshal(data []byte, v any) error {
    return json.Unmarshal(data, v)
}

// UnmarshalV1Compat unmarshals with v1 case-insensitive,
// duplicate-tolerant behavior
func UnmarshalV1Compat(data []byte, v any) error {
    return json.Unmarshal(data, v, jsonv1.DefaultOptionsV1())
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
```

---
