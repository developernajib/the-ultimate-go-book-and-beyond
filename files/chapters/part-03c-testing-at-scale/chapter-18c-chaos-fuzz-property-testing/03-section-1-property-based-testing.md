## Section 1: Property-Based Testing

### 1.1 Core Concepts

Property-based testing states *invariants* that must hold for all valid inputs, then generates hundreds of random inputs to find counterexamples. Instead of choosing specific examples like `reverse([1,2,3]) == [3,2,1]`, you express a universal property: "reversing any slice twice produces the original slice." The framework then generates random slices of every awkward shape you would not have bothered to write out: empty, single-element, large, full of duplicates, full of negatives. If the property ever fails, a good framework reports a counterexample, and the better ones shrink it to the smallest input that still reproduces the failure.

Go ships with `testing/quick` in the standard library, which provides a straightforward way to run property checks with configurable iteration counts. It is useful for trivial cases but lacks shrinking, stateful generators, and targeted generators, and it has been frozen for years: the package is explicitly not accepting new features. For production work the pragmatic choice is `pgregory.net/rapid`, which provides automatic failure minimization, a cleaner API than the older `gopter`, and first-class state machine testing. The examples below use `testing/quick` for four classic property categories: structural (reverse-reverse identity), algebraic (sort idempotency and addition commutativity), round-trip (JSON encode/decode), and parsing (URL format/parse). Section 1.2 shows `rapid` for stateful tests.

> **Senior track**: `testing/quick` does not shrink. When a 10,000-element slice triggers a bug, you receive the whole slice in the failure output, not the smallest subsequence that reproduces it. Prefer `rapid` whenever shrinking matters, which is almost always once the inputs are larger than primitives.

```go
package property_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"testing"
	"testing/quick"
	"unicode"
	"unicode/utf8"
)

// Property: reversing a slice twice gives the original slice.
func TestReverseProperty(t *testing.T) {
	reverse := func(s []int) []int {
		out := make([]int, len(s))
		for i, v := range s {
			out[len(s)-1-i] = v
		}
		return out
	}

	// Property: reverse(reverse(s)) == s
	prop := func(s []int) bool {
		return equalSlices(reverse(reverse(s)), s)
	}

	if err := quick.Check(prop, &quick.Config{MaxCount: 1000}); err != nil {
		t.Error(err)
	}
}

func equalSlices(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Property: sorting is idempotent (sort(sort(s)) == sort(s))
func TestSortIdempotent(t *testing.T) {
	prop := func(s []int) bool {
		a := sortCopy(s)
		b := sortCopy(a)
		return equalSlices(a, b)
	}
	if err := quick.Check(prop, nil); err != nil {
		t.Error(err)
	}
}

func sortCopy(s []int) []int {
	out := make([]int, len(s))
	copy(out, s)
	slices.Sort(out)
	return out
}

// Property: JSON encode then decode returns equivalent value
func TestJSONRoundTrip(t *testing.T) {
	type Record struct {
		Name  string `json:"name"`
		Value int    `json:"value"`
		Flag  bool   `json:"flag"`
	}

	prop := func(name string, value int, flag bool) bool {
		// Only test valid UTF-8 strings
		if !utf8.ValidString(name) {
			return true // skip invalid input
		}
		original := Record{Name: name, Value: value, Flag: flag}
		encoded, err := json.Marshal(original)
		if err != nil {
			return true // marshaling failures are not our property
		}
		var decoded Record
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			return false
		}
		return decoded.Name == original.Name &&
			decoded.Value == original.Value &&
			decoded.Flag == original.Flag
	}

	if err := quick.Check(prop, &quick.Config{MaxCount: 500}); err != nil {
		t.Error(err)
	}
}

// Property: addition is commutative
func TestAdditionCommutative(t *testing.T) {
	add := func(a, b int64) int64 { return a + b }
	prop := func(a, b int64) bool {
		return add(a, b) == add(b, a)
	}
	if err := quick.Check(prop, nil); err != nil {
		t.Error(err)
	}
}

// Property: parsing a formatted string gives original values back
func TestURLParseProperty(t *testing.T) {
	// For any valid scheme+host, parse(format(scheme,host)) recovers them
	prop := func(scheme, host string) bool {
		// Constrain to valid characters
		if !isValidURLComponent(scheme) || !isValidURLComponent(host) {
			return true
		}
		raw := fmt.Sprintf("%s://%s/path", scheme, host)
		u, err := url.Parse(raw)
		if err != nil {
			return true
		}
		return u.Scheme == scheme && u.Host == host
	}
	if err := quick.Check(prop, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}

func isValidURLComponent(s string) bool {
	for _, c := range s {
		if !unicode.IsLetter(c) && !unicode.IsDigit(c) && c != '-' {
			return false
		}
	}
	return len(s) > 0 && len(s) < 64
}
```

### 1.2 Stateful Property Testing with rapid

Stateful property testing models a system as a state machine and generates random sequences of operations to verify that the implementation's state transitions match the model's transitions, catching bugs that only manifest after a specific sequence of operations, not on any individual input. `pgregory.net/rapid` is the modern Go library for this. Compared to `gopter` its API is simpler, shrinking is fully automatic (you get a minimal operation sequence on failure without writing shrink logic), and it integrates cleanly with `*testing.T`. The gopter examples below are kept for historical context, but new code should use `rapid`.

```go
// Preferred modern approach with rapid.
package property_test

import (
	"testing"

	"pgregory.net/rapid"
)

// TestCounterWithRapid expresses the same properties as the gopter example
// below with fewer moving parts and automatic shrinking.
func TestCounterWithRapid(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		max := rapid.IntRange(1, 100).Draw(t, "max")
		c := NewCounter(max)
		ops := rapid.SliceOf(rapid.Bool()).Draw(t, "ops")
		for _, inc := range ops {
			if inc {
				c.Increment()
			} else {
				c.Decrement()
			}
			if c.Value() < 0 || c.Value() > max {
				t.Fatalf("invariant broken: value=%d max=%d", c.Value(), max)
			}
		}
	})
}

// TestCounterMachine uses rapid's state machine testing to generate
// random interleavings of Increment/Decrement and compare against a model.
func TestCounterMachine(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		max := rapid.IntRange(1, 50).Draw(t, "max")
		sut := NewCounter(max)
		model := 0

		t.Repeat(map[string]func(*rapid.T){
			"inc": func(t *rapid.T) {
				ok := sut.Increment()
				if model < max {
					if !ok || sut.Value() != model+1 {
						t.Fatalf("inc: model=%d sut=%d ok=%v", model, sut.Value(), ok)
					}
					model++
				} else if ok {
					t.Fatalf("inc at cap should return false")
				}
			},
			"dec": func(t *rapid.T) {
				ok := sut.Decrement()
				if model > 0 {
					if !ok || sut.Value() != model-1 {
						t.Fatalf("dec: model=%d sut=%d ok=%v", model, sut.Value(), ok)
					}
					model--
				} else if ok {
					t.Fatalf("dec at zero should return false")
				}
			},
			// The empty key is special in rapid: it is the invariant check,
			// and Repeat runs it once at the start and again after every
			// successful action. Naming it "check" instead would demote it to
			// an ordinary action that rapid picks at random, so drift could
			// persist for many steps before anything noticed.
			"": func(t *rapid.T) {
				if sut.Value() != model {
					t.Fatalf("drift: model=%d sut=%d", model, sut.Value())
				}
			},
		})
	})
}
```

> **Senior track**: `rapid.T.Repeat` samples the named actions uniformly, and it offers no weighting knob. That matters for caches, queues, and stores, where a realistic workload is read-heavy but a uniform sequence spends most of its steps mutating state nothing ever reads back. Two ways to bias it: draw the sub-operation inside a single action (`rapid.SampledFrom([]string{"get", "get", "get", "set"}).Draw(t, "op")`), or fold the rare operations into one action and the common ones into several. Also note the empty-string key is reserved for the invariant check and is not part of the sampled set, so it runs after every action rather than competing with them.

The legacy `gopter`-based example is retained below for readers maintaining existing suites. `gopter` extends Go's property testing with a command-based framework where each command specifies preconditions, executes an operation on both the model and the implementation, and asserts postconditions.

```go
package property_test

import (
	"fmt"
	"testing"

	"github.com/leanovate/gopter"
	"github.com/leanovate/gopter/gen"
	"github.com/leanovate/gopter/prop"
)

// Counter is the system under test.
type Counter struct {
	value int
	max   int
}

func NewCounter(max int) *Counter { return &Counter{max: max} }
func (c *Counter) Increment() bool {
	if c.value >= c.max {
		return false
	}
	c.value++
	return true
}
func (c *Counter) Decrement() bool {
	if c.value <= 0 {
		return false
	}
	c.value--
	return true
}
func (c *Counter) Value() int { return c.value }

// TestCounterProperties uses gopter for stateful property testing.
func TestCounterProperties(t *testing.T) {
	properties := gopter.NewProperties(nil)

	// Property: incrementing then decrementing returns to original value
	properties.Property("inc then dec is identity", prop.ForAll(
		func(start, max int) bool {
			if max <= 0 || max > 1000 {
				return true
			}
			if start < 0 || start >= max {
				return true
			}
			c := &Counter{value: start, max: max}
			c.Increment()
			c.Decrement()
			return c.Value() == start
		},
		gen.Int(), gen.Int(),
	))

	// Property: value never exceeds max
	properties.Property("value never exceeds max", prop.ForAll(
		func(ops []bool, max int) bool {
			if max <= 0 || max > 100 {
				return true
			}
			c := NewCounter(max)
			for _, inc := range ops {
				if inc {
					c.Increment()
				} else {
					c.Decrement()
				}
				if c.Value() > max || c.Value() < 0 {
					return false
				}
			}
			return true
		},
		gen.SliceOf(gen.Bool()), gen.IntRange(1, 100),
	))

	// Property: increment returns false iff at max
	properties.Property("increment at max returns false", prop.ForAll(
		func(max int) bool {
			if max <= 0 || max > 100 {
				return true
			}
			c := &Counter{value: max, max: max}
			return !c.Increment() && c.Value() == max
		},
		gen.IntRange(1, 100),
	))

	properties.TestingRun(t)
}

// BankAccount demonstrates stateful property testing with invariants.
// Using integer cents (int64 minor units) ensures financial calculations
// are exact without float rounding error.
type BankAccount struct {
	balanceCents int64
}

func (a *BankAccount) Deposit(amountCents int64) error {
	if amountCents <= 0 {
		return fmt.Errorf("deposit amount must be positive")
	}
	a.balanceCents += amountCents
	return nil
}

func (a *BankAccount) Withdraw(amountCents int64) error {
	if amountCents <= 0 {
		return fmt.Errorf("withdrawal amount must be positive")
	}
	if amountCents > a.balanceCents {
		return fmt.Errorf("insufficient funds")
	}
	a.balanceCents -= amountCents
	return nil
}

func (a *BankAccount) BalanceCents() int64 { return a.balanceCents }

func TestBankAccountProperties(t *testing.T) {
	properties := gopter.NewProperties(gopter.DefaultTestParametersWithSeed(1234))

	// Property: balance after deposit equals original + deposit (exact arithmetic)
	properties.Property("deposit increases balance correctly", prop.ForAll(
		func(initial, deposit int64) bool {
			if initial < 0 || deposit <= 0 || deposit > 1e12 || initial > 1e12 {
				return true
			}
			acc := &BankAccount{balanceCents: initial}
			if err := acc.Deposit(deposit); err != nil {
				return false
			}
			return acc.BalanceCents() == initial+deposit
		},
		gen.Int64Range(0, 1e9), gen.Int64Range(1, 1e9),
	))

	// Property: successful withdrawal decreases balance by exactly that amount
	properties.Property("withdraw decreases balance correctly", prop.ForAll(
		func(balance, withdraw int64) bool {
			if balance <= 0 || withdraw <= 0 || withdraw > balance {
				return true
			}
			acc := &BankAccount{balanceCents: balance}
			if err := acc.Withdraw(withdraw); err != nil {
				return true
			}
			return acc.BalanceCents() == balance-withdraw
		},
		gen.Int64Range(1, 1e9), gen.Int64Range(1, 1e9),
	))

	// Property: withdrawing more than balance always fails
	properties.Property("overdraft always fails", prop.ForAll(
		func(balance, excess int64) bool {
			if balance < 0 || excess <= 0 {
				return true
			}
			acc := &BankAccount{balanceCents: balance}
			err := acc.Withdraw(balance + excess)
			return err != nil
		},
		gen.Int64Range(0, 1e9), gen.Int64Range(1, 1e6),
	))

	properties.TestingRun(t)
}
```

### 1.3 Model-Based Property Testing

Model-based testing compares a complex, optimized implementation against a simple, obviously correct reference model by generating random inputs and asserting that both produce identical outputs. This technique is particularly effective for data structure implementations, encoding libraries, and caching layers where the correct behavior is easy to express in a naive implementation but subtle to preserve in an optimized one. The test below pits a high-performance concurrent cache against a simple synchronized map, generating random read/write operation sequences and asserting that both reach the same final state.

```go
package property_test

import (
	"sync"
	"testing"
	"testing/quick"
)

// ConcurrentMap is the system under test.
type ConcurrentMap struct {
	mu   sync.RWMutex
	data map[string]string
}

func NewConcurrentMap() *ConcurrentMap {
	return &ConcurrentMap{data: make(map[string]string)}
}

func (m *ConcurrentMap) Set(key, value string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = value
}

func (m *ConcurrentMap) Get(key string) (string, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.data[key]
	return v, ok
}

func (m *ConcurrentMap) Delete(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, key)
}

// ReferenceMap is the simple, obviously-correct model.
type ReferenceMap struct {
	data map[string]string
}

func NewReferenceMap() *ReferenceMap {
	return &ReferenceMap{data: make(map[string]string)}
}

// Operation describes a single map operation.
type Operation struct {
	Op    int    // 0=Set, 1=Get, 2=Delete
	Key   string
	Value string
}

// TestConcurrentMapMatchesReference verifies ConcurrentMap behaves
// identically to a simple map for all sequences of operations.
func TestConcurrentMapMatchesReference(t *testing.T) {
	prop := func(ops []Operation) bool {
		cm := NewConcurrentMap()
		ref := NewReferenceMap()

		for _, op := range ops {
			// Sanitize keys to avoid empty strings
			if op.Key == "" {
				op.Key = "key"
			}

			// quick generates ints across the full range, so roughly half of
			// op.Op is negative, and Go's % keeps the sign of the dividend:
			// -1 % 3 is -1, not 2. A bare `op.Op % 3` would therefore match
			// none of the cases below and silently drop a third of all
			// generated operations, leaving the test far weaker than it
			// looks. Normalize into [0,3) first.
			switch ((op.Op % 3) + 3) % 3 {
			case 0: // Set
				cm.Set(op.Key, op.Value)
				ref.data[op.Key] = op.Value
			case 1: // Get
				cmVal, cmOk := cm.Get(op.Key)
				refVal, refOk := ref.data[op.Key]
				if cmOk != refOk {
					return false
				}
				if cmOk && cmVal != refVal {
					return false
				}
			case 2: // Delete
				cm.Delete(op.Key)
				delete(ref.data, op.Key)
			}
		}
		return true
	}

	if err := quick.Check(prop, &quick.Config{MaxCount: 200}); err != nil {
		t.Error(err)
	}
}
```

### 1.4 How to write a good property

The single hardest skill in property testing is writing properties that are both meaningful and stable. Five categories catch almost all useful properties. **Round-trip**: `decode(encode(x)) == x`. Works for any serialization or encoding. **Inverse**: `f(f(x)) == x` (for involutions) or `g(f(x)) == x` (for inverse pairs). **Idempotent**: `f(f(x)) == f(x)`. Works for sort, normalization, canonicalization. **Commutative**: `f(a, b) == f(b, a)`. Works for addition, max, union, set operations. **Reference implementation**: `f_optimized(x) == f_simple(x)`. Works when you have a slow but obviously correct version. If you cannot express your function in terms of one of these five categories, the function is either complex enough to need behavioral assertions (not properties) or simple enough that table-driven tests suffice. Spending an hour reviewing your codebase through these five lenses often surfaces a dozen natural property tests that you would never have thought to write otherwise.

### 1.5 Junior → FAANG: watch a shrink happen

The moment property testing clicks is the first time you watch a shrink. Write a deliberately buggy function (for example, a sort that fails when the input length is a multiple of 17). Run a property test with `rapid`. The first failure will probably be a 50-element slice. `rapid` then shrinks it to the minimal counterexample: a 17-element slice with specific values. That shrinking is the superpower. Without it, debugging property-test failures requires manually simplifying the failing input, which is tedious and error-prone. With it, you get a minimal reproducer for free, and debugging becomes a five-minute exercise. This experience is worth any amount of reading about the theory. Once you have felt it, you will reach for property tests in situations where you previously would not have.

### 1.6 Senior @ FAANG: the invariant catalog

At staff level, articulate a catalog of invariants that each service promises to maintain. Example for a rate limiter: "for any input sequence, the number of allowed requests per window never exceeds the configured limit." For a consensus layer: "for any sequence of proposals, at most one value is chosen per ballot." For a cache: "Get returns the most recently Set value, or nothing if Delete was called more recently." This catalog is the specification from which property tests are derived. Document it in the service's README. Review it when the service is designed. Add a property test per entry. When a property test fails, the invariant catalog tells you whether the bug is in the implementation or whether the invariant itself needs refinement. Teams with an invariant catalog ship services whose correctness is articulated and testable. Teams without ship services whose correctness is implicit and untestable, and the first time a subtle invariant is violated is a production incident.

---
