## Section 2: Fuzz Testing with Go's Native Fuzzer

### 2.1 Basic Fuzz Tests

Go's native fuzzer, stable since Go 1.18 and refined through Go 1.27, integrates directly with the `testing` package and generates coverage-guided inputs based on the seed corpus you provide. Unlike property-based tests that generate well-formed random inputs, the fuzzer deliberately mutates bytes, splices known-interesting inputs, and probes boundary conditions designed to trigger panics, hangs, timeouts, and invariant violations. Key mechanics to remember:

- Seed corpus lives in two places. Inline seeds are registered with `f.Add(...)` at the top of the fuzz target. On-disk seeds and regression inputs sit under `testdata/fuzz/<FuzzName>/` and MUST be committed to the repository.
- During a fuzzing run (`go test -fuzz=FuzzName`) the fuzzer writes newly discovered failing inputs into `testdata/fuzz/<FuzzName>/`, where they act as permanent regression tests on every subsequent `go test ./...` run.
- The generated corpus (non-failing interesting inputs) is cached under `$GOCACHE/fuzz/`. This cache is machine-local. For CI, persist it as an artifact or re-seed from the committed corpus.
- `f.Add` argument types MUST match the `f.Fuzz` signature exactly. The supported argument types are restricted to primitives, strings, and `[]byte`.

The fuzz targets below cover a string parser and a binary protocol decoder, demonstrating corpus seeding, input constraints, and the assertion patterns that make fuzz testing effective.

> **Senior track**: a fuzz target that only checks "did not panic" leaves most of the value on the table. Always add at least one semantic invariant, whether that is round-trip equivalence, an output-is-valid check, or agreement with a reference implementation, so the fuzzer can find silent corruption rather than only outright crashes. Watch the harness too: if the code that builds the input can itself panic or error on hostile bytes (as `httptest.NewRequest` does in section 2.3), the fuzzer will find that first and report it as a finding, and you will spend a morning debugging your own test.

```go
package fuzz_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"testing"
)

// FuzzParseURL finds inputs that crash our URL parser.
func FuzzParseURL(f *testing.F) {
	// Seed corpus - interesting starting inputs
	f.Add("https://example.com/path?q=1")
	f.Add("http://user:pass@host:8080/path")
	f.Add("ftp://")
	f.Add("")
	f.Add("://")
	f.Add("http://[::1]:8080/path")
	f.Add("https://xn--nxasmq6b.bitbucket.org")

	f.Fuzz(func(t *testing.T, rawURL string) {
		// Property: parsing never panics
		u, err := url.Parse(rawURL)
		if err != nil {
			return // parse errors are OK
		}
		// Property: parsed URL can be stringified and re-parsed
		reparsed, err := url.Parse(u.String())
		if err != nil {
			t.Errorf("re-parse failed for %q: %v", u.String(), err)
		}
		_ = reparsed
	})
}

// FuzzJSONDecode finds inputs that crash our JSON decoder.
func FuzzJSONDecode(f *testing.F) {
	f.Add([]byte(`{"key":"value","num":42}`))
	f.Add([]byte(`[]`))
	f.Add([]byte(`null`))
	f.Add([]byte(`"string"`))
	f.Add([]byte(`{}`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var v any
		if err := json.Unmarshal(data, &v); err != nil {
			return // invalid JSON is expected
		}
		// Property: marshal(unmarshal(data)) is valid JSON
		encoded, err := json.Marshal(v)
		if err != nil {
			t.Errorf("re-marshal failed: %v", err)
			return
		}
		var v2 any
		if err := json.Unmarshal(encoded, &v2); err != nil {
			t.Errorf("re-unmarshal failed: %v", err)
		}
	})
}

// CustomParser is the system under test.
type ConfigParser struct{}

// Parse parses a simple KEY=VALUE config format.
func (p *ConfigParser) Parse(input string) (map[string]string, error) {
	result := make(map[string]string)
	for _, line := range strings.Split(input, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 0 {
			return nil, fmt.Errorf("invalid line: %q", line)
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		if key == "" {
			return nil, fmt.Errorf("empty key")
		}
		result[key] = value
	}
	return result, nil
}

// FuzzConfigParser finds inputs that crash the config parser.
func FuzzConfigParser(f *testing.F) {
	f.Add("KEY=value\n")
	f.Add("# comment\nKEY=value\n")
	f.Add("KEY=")
	f.Add("")
	f.Add("K=v\nK2=v2\n")

	parser := &ConfigParser{}

	f.Fuzz(func(t *testing.T, input string) {
		// Must not panic
		result, err := parser.Parse(input)
		if err != nil {
			return
		}
		// Property: every key is non-empty
		for k := range result {
			if k == "" {
				t.Error("empty key in result")
			}
		}
		// Property: re-serialized config re-parses to same result
		var sb strings.Builder
		for k, v := range result {
			fmt.Fprintf(&sb, "%s=%s\n", k, v)
		}
		result2, err := parser.Parse(sb.String())
		if err != nil {
			t.Errorf("re-parse failed: %v", err)
			return
		}
		if len(result2) != len(result) {
			t.Errorf("re-parse size mismatch: %d != %d", len(result2), len(result))
		}
	})
}
```

### 2.2 Fuzz Testing Encoding Libraries

Encoding and decoding functions are prime fuzz targets because they process untrusted input and must never panic regardless of what bytes they receive. The encode/decode roundtrip property, `decode(encode(v)) == v` for all valid `v`, is also expressible as a fuzz property, finding cases where the encoder produces output the decoder cannot reconstruct. The fuzz test below targets a custom binary serialization library with both a crash-finding target and a roundtrip property target, and demonstrates how found corpus entries are stored in `testdata/fuzz/` for regression testing.

```go
package fuzz_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"testing"
)

// FuzzBase64RoundTrip verifies base64 encode/decode correctness.
func FuzzBase64RoundTrip(f *testing.F) {
	f.Add([]byte("hello world"))
	f.Add([]byte(""))
	f.Add([]byte{0, 1, 2, 255})
	f.Add([]byte("unicode: 日本語"))

	f.Fuzz(func(t *testing.T, data []byte) {
		encoded := base64.StdEncoding.EncodeToString(data)
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Errorf("decode failed: %v", err)
			return
		}
		if !bytes.Equal(data, decoded) {
			t.Errorf("round-trip mismatch: %q != %q", data, decoded)
		}
	})
}

// FuzzHexRoundTrip verifies hex encode/decode correctness.
func FuzzHexRoundTrip(f *testing.F) {
	f.Add([]byte("test data"))
	f.Add([]byte{0xff, 0x00, 0x7f})

	f.Fuzz(func(t *testing.T, data []byte) {
		encoded := hex.EncodeToString(data)
		decoded, err := hex.DecodeString(encoded)
		if err != nil {
			t.Errorf("decode failed: %v", err)
			return
		}
		if !bytes.Equal(data, decoded) {
			t.Errorf("round-trip mismatch")
		}
	})
}

// MessageCodec is a custom binary protocol codec.
type MessageCodec struct{}

type Message struct {
	ID      uint32
	Type    uint8
	Payload []byte
}

// Encode serializes a message.
func (c *MessageCodec) Encode(msg Message) []byte {
	buf := make([]byte, 5+len(msg.Payload))
	binary.BigEndian.PutUint32(buf[0:4], msg.ID)
	buf[4] = msg.Type
	copy(buf[5:], msg.Payload)
	return buf
}

// Decode deserializes a message.
func (c *MessageCodec) Decode(data []byte) (Message, error) {
	if len(data) < 5 {
		return Message{}, fmt.Errorf("too short: %d bytes", len(data))
	}
	return Message{
		ID:      binary.BigEndian.Uint32(data[0:4]),
		Type:    data[4],
		Payload: append([]byte{}, data[5:]...),
	}, nil
}

// FuzzMessageCodec verifies the codec handles arbitrary binary input.
func FuzzMessageCodec(f *testing.F) {
	codec := &MessageCodec{}

	f.Add([]byte{0, 0, 0, 1, 0, 'h', 'i'})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff, 0xff})
	f.Add([]byte{})
	f.Add([]byte{0, 0, 0, 0, 0})

	f.Fuzz(func(t *testing.T, data []byte) {
		// Decode must not panic
		msg, err := codec.Decode(data)
		if err != nil {
			return
		}
		// Property: encode(decode(data)) can be re-decoded to same message
		reencoded := codec.Encode(msg)
		msg2, err := codec.Decode(reencoded)
		if err != nil {
			t.Errorf("re-decode failed: %v", err)
			return
		}
		if msg.ID != msg2.ID || msg.Type != msg2.Type {
			t.Errorf("message mismatch: %+v != %+v", msg, msg2)
		}
		if !bytes.Equal(msg.Payload, msg2.Payload) {
			t.Errorf("payload mismatch")
		}
	})
}
```

### 2.3 Fuzz Testing HTTP Handlers

HTTP handlers receive attacker-controlled input through request paths, query parameters, headers, and bodies, making them high-value fuzz targets for discovering panics, incorrect error handling, and authentication bypasses. Fuzzing an HTTP handler via `httptest.NewRecorder` and `httptest.NewRequest` is straightforward, and the test can assert both that the handler doesn't panic and that certain invariants hold, for example, that unauthenticated requests always receive a 401 regardless of the request body content. The fuzz target below fuzzes the request body of a JSON API endpoint, asserting no panics and no 5xx responses for any input.

```go
package fuzz_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// FuzzHTTPHandler finds inputs that cause panics or 500 errors.
func FuzzHTTPHandler(f *testing.F) {
	handler := buildUserHandler()

	// Seed interesting paths and bodies
	seeds := []struct {
		path string
		body string
	}{
		{"/v1/users", `{"email":"a@b.com","name":"Alice"}`},
		{"/v1/users/", ""},
		{"/v1/users/123", ""},
		{"/", ""},
	}
	for _, s := range seeds {
		f.Add(s.path, s.body)
	}

	f.Fuzz(func(t *testing.T, path, body string) {
		// Do not use httptest.NewRequest here. It PANICS on any target it
		// cannot parse, and it parses the target as an HTTP request line, so
		// a path as tame as "/ " blows up on "malformed HTTP version". The
		// fuzzer finds inputs like that within seconds, and the result is a
		// crash report against the test harness rather than the handler,
		// which is worse than no test: it looks like a real finding.
		//
		// Build the request from an absolute URL with http.NewRequest, which
		// does no request-line parsing and returns an error instead of
		// panicking. Skip anything that is not a valid request path.
		if !strings.HasPrefix(path, "/") {
			t.Skip()
		}
		u, err := url.ParseRequestURI(path)
		if err != nil {
			t.Skip()
		}

		// Build a reasonable request
		method := "POST"
		if body == "" {
			method = "GET"
		}

		req, err := http.NewRequest(method, "http://example.com"+u.RequestURI(), strings.NewReader(body))
		if err != nil {
			t.Skip()
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()

		// Handler must not panic
		handler.ServeHTTP(rec, req)

		// Property: response must have a valid HTTP status
		if rec.Code < 100 || rec.Code > 599 {
			t.Errorf("invalid HTTP status %d for path %q", rec.Code, path)
		}

		// Property: no input from a client may drive the handler to 5xx.
		// A 5xx means the server blamed itself for input it should have
		// rejected with a 4xx, which is how unhandled decode errors and nil
		// dereferences surface. This assertion is the whole point of the
		// target: without it, the fuzzer only ever finds outright panics.
		if rec.Code >= 500 {
			t.Errorf("client input produced %d (want 4xx) for path %q body %q",
				rec.Code, path, body)
		}
	})
}

func buildUserHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/users", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var req struct {
				Email string `json:"email"`
				Name  string `json:"name"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			if req.Email == "" || req.Name == "" {
				http.Error(w, "missing fields", http.StatusUnprocessableEntity)
				return
			}
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "123", "email": req.Email})
		} else {
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode([]any{})
		}
	})
	return mux
}
```

### 2.4 Fuzz corpus management

The fuzz corpus is a living artifact, not a one-time seed. Three practices keep it useful. First, commit `testdata/fuzz/<FuzzName>/` to the repository. Every failing input discovered during a fuzz run becomes a regression test for all future runs. Second, cap corpus size. An unbounded corpus grows over time and eventually dominates `go test` time. Periodically prune by keeping the most recent N entries or by running corpus-minimization tools. Third, seed the corpus with real production data. A fuzz target for a JSON decoder seeded only with `{"key":"value"}` explores a narrow input space. Seeded with 100 sampled production payloads (scrubbed of PII), it finds real bugs much faster. The seed corpus is the single most important input to fuzz effectiveness, and neglecting it is the reason most fuzz suites underperform their potential.

### 2.5 Junior → FAANG: the five-minute fuzz discovery

Pick any parser or decoder you have written. Write a fuzz target following the template in section 2.1. Run `go test -fuzz=. -fuzztime=5m` locally. Note that `-fuzz` runs until it finds a failure or until `-fuzztime` expires, so without that flag it runs until you stop it. On a hand-written parser that was never designed against hostile input, a short run often finds something. Go's fuzzer minimizes the input automatically before writing it out, so what lands in `testdata/fuzz/` is already close to minimal. Investigate the root cause, fix it, and keep the failing input committed as a permanent regression. That exercise turns fuzzing from an abstract concept into a concrete skill, and it gives you a specific interview answer: not "I know what fuzzing is" but "here is the crasher I found in our config parser and the nil check that was missing."

### 2.6 Senior @ FAANG: the continuous-fuzzing platform

At scale, fuzzing is a platform investment, not a per-service tax. Google's OSS-Fuzz, ClusterFuzz, and the emerging OSS continuous-fuzz tooling let you run fuzz targets for hours or days against every commit. The platform artifacts: (1) a shared runner pool with enough CPU budget to run every registered fuzz target for a configured duration per day. (2) a crash-triage workflow that deduplicates crashers, files issues automatically, and routes them to the owning team. (3) corpus-sharing infrastructure so corpora discovered on one run benefit later runs. (4) metrics on fuzz coverage per service, so leadership can see which areas are under-fuzzed. Organizations with this infrastructure find security-critical bugs long before attackers do. Organizations without have teams running ad-hoc fuzz sessions that discover the same easy bugs repeatedly while missing the deep ones that require sustained compute. The platform is the leverage. Building it is the staff-engineer contribution.

---
