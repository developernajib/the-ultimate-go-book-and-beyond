export default `## Section 12: Go 1.26, Green Tea GC Default, Self-Referential Generics, and Post-Quantum Crypto

### 12.1 Green Tea GC is Now the Default

Green Tea was introduced as an experimental opt-in in Go 1.25 (\`GOEXPERIMENT=greenteagc\`). In Go 1.26 it is the default GC. You get it automatically, no flags needed. See Section 3 of this chapter for the collector's mark-phase architecture.

**What changes in practice**: lower steady-state GC CPU (typically 10 to 40 percent on allocation-heavy workloads) and shorter p99 pauses because the mark phase finishes faster. The language contract, escape-analysis rules, and write-barrier semantics are unchanged.

\`\`\`go
// Measuring GC behavior on any version:
// GODEBUG=gctrace=1 ./your-binary        // prints per-cycle stats
// go build -gcflags="-m" ./...           // prints escape-analysis decisions

// Typical observed impact on services with heavy small-object churn
// after upgrading from Go 1.24 to Go 1.26:
//   GC CPU fraction: 12% -> 7%
//   p99 mark-assist latency: 1.5ms -> 0.6ms
// Your numbers depend on allocation shape. Measure before tuning.

// Same knobs apply as before:
//   GOGC: heap growth ratio target (default 100)
//   GOMEMLIMIT: soft memory cap (Go 1.19+)
//   debug.SetGCPercent and debug.SetMemoryLimit for runtime tuning
\`\`\`

### 12.2 Self-Referential Generic Types (Go 1.26)

Go 1.26 lifts the restriction that prevented a generic type from referring to itself in its own type parameter list. This enables type-safe builder patterns and algebraic type hierarchies.

\`\`\`go
package constraints

// Before Go 1.26: This was ILLEGAL
// type Adder[A Adder[A]] interface { Add(A) A }

// Go 1.26: Now LEGAL
type Adder[A Adder[A]] interface {
	Add(A) A
}

// Use case 1: Type-safe numeric operations
type Vec2[T interface{ ~float32 | ~float64 }] struct {
	X, Y T
}

// Use case 2: Builder pattern that returns the concrete type
type Builder[B Builder[B]] interface {
	Set(key, value string) B
	Build() string
}

type QueryBuilder struct {
	params map[string]string
}

func (q *QueryBuilder) Set(key, value string) *QueryBuilder {
	if q.params == nil {
		q.params = make(map[string]string)
	}
	q.params[key] = value
	return q
}

func (q *QueryBuilder) Build() string {
	// ... build query string
	return ""
}

// Use case 3: Comparable constraint that references itself
type Ordered[T Ordered[T]] interface {
	Less(T) bool
	Equal(T) bool
}

// This enables writing generic sorted containers that work with
// any type that defines its own ordering - without requiring
// the built-in ordered constraint.
type SortedSlice[T Ordered[T]] struct {
	items []T
}

func (s *SortedSlice[T]) Insert(item T) {
	// Binary search for insertion point
	lo, hi := 0, len(s.items)
	for lo < hi {
		mid := (lo + hi) / 2
		if s.items[mid].Less(item) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	s.items = append(s.items, item)
	copy(s.items[lo+1:], s.items[lo:])
	s.items[lo] = item
}
\`\`\`

### 12.3 Post-Quantum Cryptography: crypto/hpke

Go 1.26 adds \`crypto/hpke\`, a full Hybrid Public Key Encryption implementation (RFC 9180) with first-class post-quantum hybrid KEMs. Separately, Go 1.26 TLS defaults to the \`X25519MLKEM768\` key exchange, which means TLS connections from Go 1.26 clients to Go 1.26 servers are already post-quantum secure without any code changes.

The hpke package exposes KEMs as constructor functions, not constants. The available hybrid and post-quantum KEMs include \`MLKEM768X25519\` (the X-Wing hybrid), \`MLKEM768P256\`, \`MLKEM1024P384\`, and the pure post-quantum \`MLKEM768\` and \`MLKEM1024\`.

\`\`\`go
package crypto_demo

import (
	"crypto/hpke"
	"crypto/rand"
	"fmt"
)

// HPKE combines a KEM (key encapsulation), a KDF (key derivation), and an
// AEAD cipher (authenticated encryption). The "hybrid" in the PQ suites
// means classical (X25519 or P-256) combined with ML-KEM so breaking the
// encryption requires breaking both.

func HPKEEncryptDecrypt() error {
	// Choose a suite. X-Wing (MLKEM768 + X25519) is the recommended hybrid.
	kem := hpke.MLKEM768X25519()
	kdf := hpke.HKDF_SHA256
	aead := hpke.AES128GCM
	suite := hpke.NewSuite(kem, kdf, aead)

	// Recipient generates a key pair. The public key is shared out-of-band.
	privKey, err := kem.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	pubKey := privKey.PublicKey()

	// Sender encapsulates a shared secret to the recipient's public key
	// and encrypts the message.
	encapsulatedKey, sealer, err := suite.NewSender(pubKey, []byte("app-info"))
	if err != nil {
		return err
	}
	ciphertext, err := sealer.Seal(nil, []byte("hello, post-quantum world"), []byte("aad"))
	if err != nil {
		return err
	}

	// Recipient decapsulates the shared secret and decrypts.
	opener, err := suite.NewRecipient(privKey, encapsulatedKey, []byte("app-info"))
	if err != nil {
		return err
	}
	plaintext, err := opener.Open(nil, ciphertext, []byte("aad"))
	if err != nil {
		return err
	}
	fmt.Println(string(plaintext))
	return nil
}
\`\`\`

> **Senior track**: the exact method signatures above track the Go 1.26 \`crypto/hpke\` package as shipped. Check \`pkg.go.dev/crypto/hpke\` before copying verbatim, minor API polish can land in patch releases.

**Why post-quantum now**: NIST finalized ML-KEM (formerly CRYSTALS-Kyber) as a standard in August 2024. The threat model is "harvest now, decrypt later", where adversaries collect encrypted traffic today and decrypt it once quantum hardware catches up. For long-lived sensitive data (medical, financial, archival), migrating to hybrid post-quantum exchange now is straightforward and cheap. At the TLS layer on Go 1.26, it is already the default.

### 12.4 Performance: Stack-Allocated Slice Backing Stores

Go 1.26's compiler can now allocate the backing array of slices on the stack in more cases, eliminating heap allocation for short-lived slices.

\`\`\`go
// This pattern now avoids heap allocation in Go 1.26:
func processIDs(input []string) []int {
	result := make([]int, 0, len(input)) // backing array may stay on stack
	for _, s := range input {
		if id, err := strconv.Atoi(s); err == nil {
			result = append(result, id)
		}
	}
	return result // if result doesn't escape, backing array stays on stack
}

// Verify with: go build -gcflags="-m=2" ./...
// Look for "does not escape" for the make() call

// Go 1.26 also reduces cgo overhead by ~30%:
// Before: ~100ns per cgo call baseline
// After:  ~70ns per cgo call baseline
// (Only matters if you're making millions of cgo calls per second)
\`\`\`

### Adoption Story

Go 1.26 is a low-risk, high-payoff upgrade. The Green Tea GC is transparent. Self-referential generics enable patterns that teams have been working around since 1.18. Stack-allocated slice backing arrays reduce heap pressure with no source change. The cgo improvement matters only for cgo-heavy services.

The sequence for adoption:

1. **Pilot on staging.** Verify the test suite passes, benchmarks improve as expected, and no regression surfaces.
2. **Canary in production.** Small percentage of traffic. Capture before-and-after GC CPU, RSS, latency.
3. **Roll to fleet.** Track the org-wide savings and feed the numbers into the next platform review.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **Workarounds for the generics limitations that 1.26 removes.** Self-referential generics (\`type List[T any] struct { Head *List[T] }\`) now work. Patterns that used \`any\` to work around the limitation can be cleaned up.
2. **Services pinned to older Go versions without justification.** 1.26 is a free performance win for most workloads. Pinning to 1.20 or 1.22 has a real cost that the team should be aware of.

---
`;
