export default `## Section 8: The \`unique\` Package (Go 1.23)

The \`unique\` package provides value interning (deduplication), storing only one copy of each distinct value and returning a lightweight handle for comparison. String-heavy applications (parsers, compilers, network servers) often store millions of duplicate strings. Each duplicate wastes memory and makes comparison O(n) on string length. \`unique.Handle[T]\` stores one canonical copy. Handles compare in O(1) via pointer equality.

### 8.1 Basic Interning

The API surface is minimal: \`unique.Make(v)\` returns a \`Handle[T]\`, and \`Handle.Value()\` retrieves the original. Two handles created from equal values compare equal via \`==\`.

\`\`\`go
package uniquepkg

import (
	"fmt"
	"unique" // Go 1.23+
)

func DemonstrateUnique() {
	// Intern strings - same value returns same handle
	h1 := unique.Make("hello")
	h2 := unique.Make("hello")
	h3 := unique.Make("world")

	fmt.Println(h1 == h2) // true - same underlying value
	fmt.Println(h1 == h3) // false

	// Retrieve original value
	fmt.Println(h1.Value()) // "hello"
}
\`\`\`

The key insight: \`unique.Make\` with the same value always returns the same \`Handle\`. Two handles are equal if and only if they were created from equal values, but the equality check is a single pointer comparison, not a byte-by-byte string comparison.

### 8.2 Practical Use Case: Metric Label Sets

High-cardinality label sets in observability systems are a prime candidate for interning. A service processing millions of requests per second might see only a few hundred distinct label combinations, but each request creates a new copy of the same strings.

\`\`\`go
package uniquepkg

import "unique"

// Labels with interned strings - cheap comparison, low memory
type Labels struct {
	Service  unique.Handle[string]
	Method   unique.Handle[string]
	Status   unique.Handle[string]
}

func NewLabels(service, method, status string) Labels {
	return Labels{
		Service: unique.Make(service),
		Method:  unique.Make(method),
		Status:  unique.Make(status),
	}
}

// Labels with same values are cheap to compare - O(1) pointer equality
func (l Labels) Equal(other Labels) bool {
	return l.Service == other.Service &&
		l.Method == other.Method &&
		l.Status == other.Status
}
\`\`\`

### 8.3 When to Use \`unique\`

**Good candidates for interning:**
- Deduplicating strings from parsed input (JSON keys, HTTP headers, log fields)
- Reducing memory in caches with many identical keys
- Fast equality checks for frequently compared values (metric labels, routing keys)
- Symbol tables in parsers, compilers, or template engines

**When NOT to use interning:**
- Small datasets where dedup overhead exceeds savings
- Values that are rarely compared, the O(1) comparison benefit is wasted
- Short-lived values, interning has GC interaction costs because the runtime must track canonical values
- High-cardinality unique values (UUIDs, timestamps), every value is distinct, so interning adds overhead with zero deduplication benefit

### Adoption Story

The \`unique\` package is the canonical replacement for hand-rolled string pools. Its adoption is a one-function-call migration: replace the custom intern table's \`Intern(s)\` call with \`unique.Make(s).Value()\`. The payoff:

1. **Memory reduction.** Cloudflare and Datadog publicly reported single-digit-percent RSS reductions after adoption on services with high string duplication.
2. **Cleaner code.** The hand-rolled pool disappears, along with its mutex and its memory leak potential.
3. **Correct GC interaction.** The hand-rolled pool retains strings forever. \`unique.Make\` uses weak references internally, so canonical strings are released when no handle refers to them.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A hand-rolled intern pool.** Always replaceable with \`unique.Make\`. File the refactor.
2. **\`unique.Make\` on a high-cardinality value.** A service interning UUIDs has a leak: every unique UUID becomes a canonical entry, and the pool grows without bound. Interning is for values that repeat.

---
`;
