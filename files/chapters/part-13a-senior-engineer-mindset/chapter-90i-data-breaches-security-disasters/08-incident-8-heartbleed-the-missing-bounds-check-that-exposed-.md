## 90I.8 Heartbleed - The Missing Bounds Check That Exposed the Internet (2014)

### The Attack Timeline

On April 7, 2014, the Heartbleed vulnerability (CVE-2014-0160) was publicly disclosed. It was a critical flaw in
OpenSSL, the cryptographic library used by approximately 66% of all HTTPS websites, that allowed attackers to read
up to 64KB of memory from any affected server with each request. The vulnerability existed in OpenSSL's
implementation of the TLS Heartbeat extension (RFC 6520), introduced in OpenSSL version 1.0.1 on March 14, 2012.
For 27 months, every server running the affected OpenSSL versions was silently leaking memory contents to anyone
who asked.

**The Vulnerability**

The TLS Heartbeat extension is a keep-alive mechanism. A client sends a heartbeat request containing a payload
and the payload's length. The server is supposed to echo the payload back. The vulnerable code looked like this
(simplified from the actual C):

```c
/* Read the heartbeat message type and payload length */
hbtype = *p++;
n2s(p, payload);  /* Read 16-bit payload length from the request */
pl = p;            /* Point to the payload data */

/* Allocate response buffer and copy the payload */
buffer = OPENSSL_malloc(1 + 2 + payload + padding);
bp = buffer;
*bp++ = TLS1_HB_RESPONSE;
s2n(payload, bp);
memcpy(bp, pl, payload);  /* BUG: copies 'payload' bytes, but does not verify
                              that the request actually contained that many bytes */
```

The bug was a missing bounds check. The attacker could send a heartbeat request claiming a payload length of 64KB
but actually send only a 1-byte payload. The `memcpy` would then copy 64KB starting from the payload pointer,
reading 65,535 bytes of adjacent memory - which could contain private keys, session tokens, passwords, and other
sensitive data from other TLS connections being processed by the same server.

**Impact Assessment**

At the time of disclosure:
- Approximately 17% of all SSL web servers (around 500,000 servers) were vulnerable
- The vulnerability was trivially exploitable with no authentication required
- Exploitation left no trace in server logs
- Private keys extracted via Heartbleed could be used to decrypt previously captured traffic (if Perfect Forward
  Secrecy was not enabled)
- The Canadian Revenue Agency confirmed that 900 Social Insurance Numbers were stolen via Heartbleed
- Community Health Systems disclosed a breach of 4.5 million patient records attributed to Heartbleed

**The Two-Year Gap**

Robin Seggelmann, the developer who wrote the vulnerable code, stated it was an honest mistake - he simply forgot
to include the bounds check. The code was reviewed by Stephen Henson before being committed to the OpenSSL
repository, but neither caught the error. The bug survived in production for 27 months before Neel Mehta of Google
Security discovered it (independently, Codenomicon researchers also discovered it around the same time).

### Technical Root Cause Analysis

1. **Manual memory management in C**: The C programming language requires developers to manually track buffer
   sizes and perform bounds checks. Forgetting a single check can create a critical vulnerability.

2. **Insufficient code review**: The code was reviewed before commit, but the reviewer did not catch the missing
   bounds check. For security-critical code, formal verification or at minimum two independent security-focused
   reviews should be required.

3. **Underfunded critical infrastructure**: OpenSSL was maintained by a handful of volunteers despite being
   relied upon by most of the internet. The project received minimal funding until Heartbleed demonstrated the
   consequences.

### Go Code: Memory Safety by Design

Go's type system and runtime eliminate the entire class of vulnerability that caused Heartbleed. Slices carry
their own length, bounds are checked at runtime, and there is no way to read arbitrary memory. Here is a safe
implementation of a heartbeat-like protocol in Go that demonstrates these protections:

```go
package memsafe

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	// MaxHeartbeatPayload is the maximum allowed heartbeat payload size.
	// Limiting this prevents memory exhaustion attacks.
	MaxHeartbeatPayload = 16384

	heartbeatRequest  byte = 1
	heartbeatResponse byte = 2
)

var (
	ErrPayloadTooLarge   = errors.New("heartbeat payload exceeds maximum size")
	ErrPayloadMismatch   = errors.New("declared payload length does not match actual data")
	ErrInvalidMessage    = errors.New("invalid heartbeat message format")
	ErrMessageTooShort   = errors.New("heartbeat message too short")
)

// HeartbeatRequest represents a parsed and validated heartbeat request.
type HeartbeatRequest struct {
	Type    byte
	Payload []byte
}

// ParseHeartbeatRequest safely parses a heartbeat message from raw bytes.
// This function demonstrates Go's built-in protections against Heartbleed-style
// bugs:
//
// 1. Slices carry their own length - you cannot read past the end
// 2. All slice access is bounds-checked at runtime
// 3. There is no pointer arithmetic that could bypass bounds checks
// 4. copy() is bounded by the smaller of src and dst
func ParseHeartbeatRequest(data []byte) (*HeartbeatRequest, error) {
	// Go's len() always returns the actual length of the slice.
	// There is no way to confuse "declared length" with "actual length"
	// because slices ARE their length.
	if len(data) < 3 {
		return nil, ErrMessageTooShort
	}

	msgType := data[0]
	if msgType != heartbeatRequest {
		return nil, fmt.Errorf("%w: unexpected type %d", ErrInvalidMessage, msgType)
	}

	// Read the declared payload length from the message.
	declaredLength := binary.BigEndian.Uint16(data[1:3])

	// CRITICAL: Validate that the declared length matches the actual data.
	// This is the exact check that was missing in OpenSSL.
	// In Go, this check is natural because we compare against len(data),
	// which is always the TRUE length of the data we received.
	actualPayloadLength := len(data) - 3
	if int(declaredLength) != actualPayloadLength {
		return nil, fmt.Errorf(
			"%w: declared %d bytes but message contains %d bytes",
			ErrPayloadMismatch, declaredLength, actualPayloadLength,
		)
	}

	if declaredLength > MaxHeartbeatPayload {
		return nil, fmt.Errorf(
			"%w: %d bytes (max %d)",
			ErrPayloadTooLarge, declaredLength, MaxHeartbeatPayload,
		)
	}

	// Safe copy: even if we made a mistake above, Go's slice bounds
	// checking would prevent reading past the end of data.
	// data[3:3+declaredLength] will panic if 3+declaredLength > len(data).
	payload := make([]byte, declaredLength)
	copy(payload, data[3:])
	// copy() copies min(len(dst), len(src)) bytes - it CANNOT overflow.

	return &HeartbeatRequest{
		Type:    msgType,
		Payload: payload,
	}, nil
}

// BuildHeartbeatResponse creates a response that echoes the validated payload.
func BuildHeartbeatResponse(req *HeartbeatRequest) []byte {
	response := make([]byte, 3+len(req.Payload))
	response[0] = heartbeatResponse
	binary.BigEndian.PutUint16(response[1:3], uint16(len(req.Payload)))
	copy(response[3:], req.Payload)
	return response
}

// SafeReadN reads exactly n bytes from the reader, returning an error if
// fewer bytes are available. This prevents the "read more than available"
// class of bugs.
func SafeReadN(r io.Reader, n int) ([]byte, error) {
	if n <= 0 {
		return nil, fmt.Errorf("invalid read size: %d", n)
	}
	if n > MaxHeartbeatPayload {
		return nil, fmt.Errorf("read size %d exceeds maximum %d", n, MaxHeartbeatPayload)
	}

	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	if err != nil {
		return nil, fmt.Errorf("reading %d bytes: %w", n, err)
	}
	return buf, nil
}

// BoundedBuffer provides a fixed-size buffer that prevents overflow by design.
// All write operations check remaining capacity before writing.
type BoundedBuffer struct {
	data []byte
	pos  int
}

// NewBoundedBuffer creates a buffer of the specified capacity.
func NewBoundedBuffer(capacity int) *BoundedBuffer {
	return &BoundedBuffer{
		data: make([]byte, capacity),
		pos:  0,
	}
}

// Write appends data to the buffer, returning an error if it would overflow.
func (b *BoundedBuffer) Write(p []byte) (int, error) {
	remaining := len(b.data) - b.pos
	if len(p) > remaining {
		return 0, fmt.Errorf(
			"buffer overflow prevented: tried to write %d bytes, only %d remaining",
			len(p), remaining,
		)
	}
	n := copy(b.data[b.pos:], p)
	b.pos += n
	return n, nil
}

// Bytes returns the written portion of the buffer as a new slice.
// The returned slice is a copy, preventing callers from modifying the buffer.
func (b *BoundedBuffer) Bytes() []byte {
	result := make([]byte, b.pos)
	copy(result, b.data[:b.pos])
	return result
}

// Remaining returns the number of bytes that can still be written.
func (b *BoundedBuffer) Remaining() int {
	return len(b.data) - b.pos
}

// Reset clears the buffer for reuse, zeroing the memory to prevent
// information leakage (another Heartbleed-adjacent concern).
func (b *BoundedBuffer) Reset() {
	for i := range b.data {
		b.data[i] = 0
	}
	b.pos = 0
}
```

### Engineering Lessons

1. **Memory-safe languages eliminate entire vulnerability classes.** Heartbleed is impossible in Go because
   slice bounds are checked at runtime. The `copy` function copies `min(len(dst), len(src))` bytes and cannot
   overflow. This is not a marginal improvement - it is the elimination of a class of bug that has caused
   billions of dollars in damage across the industry.

2. **Critical open-source infrastructure needs sustainable funding.** OpenSSL was maintained by volunteers.
   After Heartbleed, the Core Infrastructure Initiative (now the Open Source Security Foundation) was created
   to fund critical projects. Go's standard library TLS implementation is maintained by Google engineers as
   part of their regular work.

3. **Defense in depth still matters.** Even with memory safety, implement payload size limits, validate all
   declared lengths against actual data, and use bounded buffers. Defense in depth means not relying on any
   single protection.

4. **Code review must be security-focused for critical code.** The Heartbleed code was reviewed but the
   missing bounds check was not caught. Security-critical code requires reviewers specifically trained to
   identify memory safety issues - or better yet, a language that makes such issues impossible.

---

### Junior → FAANG: Memory Safety and Go's Cryptography Standard Library as Interview Topics

Heartbleed is the interview answer to "why does memory safety matter for security?" The bug was a missing bounds check: the server trusted the client's claim about the length of a heartbeat payload, copied that many bytes from memory without verifying that a payload of that length existed, and returned adjacent memory that happened to contain private keys, session tokens, and passwords. In Go, this class of vulnerability is impossible: slice bounds are checked at runtime, and any out-of-bounds access causes a panic rather than silently reading adjacent memory. For FAANG interviews, the specific point is that Go's memory safety is not just about preventing crashes: it eliminates an entire class of security vulnerabilities that have been responsible for some of the most significant breaches in history. Go's `crypto/tls` implementation, maintained by Google engineers, handles TLS without the memory management vulnerabilities that plagued C-based TLS libraries. Use it instead of CGO bindings to OpenSSL.

### Senior @ FAANG: Language Choice as a Security Decision and Open Source Infrastructure Funding

At L6, Heartbleed is an argument for language choice as a security architecture decision, not just a performance or productivity decision. OpenSSL is written in C, which gives the programmer complete control over memory but also complete responsibility for preventing every buffer overflow, use-after-free, and out-of-bounds access. When security-critical code is written in a memory-unsafe language by volunteers working without dedicated security review, Heartbleed is a predictable outcome. At staff level, for any new security-critical service, the language selection must include an explicit assessment of the memory safety properties of the language and its standard library. Go's memory safety eliminates the Heartbleed vulnerability class by construction. Rust's memory safety is enforced at compile time. The cost in engineering complexity of choosing a memory-safe language is offset by the elimination of an entire vulnerability class that has been responsible for a disproportionate share of critical CVEs across the industry. This is a measurable security improvement, not a style preference, and it belongs in the ADR for any security-critical service.

