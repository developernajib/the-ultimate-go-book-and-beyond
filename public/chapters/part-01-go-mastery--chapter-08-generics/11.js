export default `## 8.10 Interview Questions

Generics questions show up in FAANG interviews for any Go role at senior or staff level. Interviewers use them to check whether you understand the design constraints (why Go took so long to add generics, what GC-shape stenciling is, why method type parameters are still disallowed) and whether you reach for generics appropriately, not as a default pattern.

> **What FAANG actually tests here**: whether you can articulate when generics beat interfaces, when they do not, and what the runtime actually does. Candidates who treat generics as a replacement for interfaces usually fail the senior bar.

### Question 1: When Should You Use Generics vs Interfaces?

**What FAANG expects**: a clear rule based on whether the operation depends on the type or the behavior, plus awareness that interfaces and generics often compose (a generic function whose type parameter is itself constrained by an interface).

**Answer**: Use generics when:
- You need type-specific operations (arithmetic, comparison)
- Return type should match input type
- You want to avoid runtime type assertions
- You're building container types (Stack, Queue, Set)
- Performance is critical (no interface boxing)

Use interfaces when:
- Behavior matters more than type (polymorphism)
- Different types should be treated uniformly
- You're defining contracts for implementation
- Dynamic dispatch is acceptable/desired

Example:
\`\`\`go
// Interfaces: behavior-focused
type Logger interface { Log(string) }
func LogAll(loggers []Logger, msg string) { ... }

// Generics: type-focused
func Unique[T comparable](slice []T) []T { ... }
\`\`\`

**Follow-ups**:
- Can a generic function accept an interface type as its type parameter? What changes if it does?
- Why does \`slices.Sort\` take a generic constraint rather than a \`sort.Interface\` argument?

### Question 2: What Is Type Inference and When Does It Fail?

**What FAANG expects**: the two common failure modes (return-type-only parameters, ambiguous inference), the solution (explicit type arguments), and knowledge that Go 1.21 improved inference for partial type-argument lists.

**Answer**: Type inference lets the compiler deduce type arguments from the concrete values passed to a generic function, so callers do not need to write explicit type arguments. It succeeds when function parameters provide enough information and fails when type parameters appear only in return types or when the static type of an argument is \`any\` rather than a concrete type.

\`\`\`go
// Works: inferred from arguments
result := Max(1, 2)  // T = int

// Works: inferred from multiple constraints
func Pair[K, V any](k K, v V) (K, V) { return k, v }
k, v := Pair("key", 42)  // K = string, V = int

// Fails: can't infer from return only
func Zero[T any]() T {
    var zero T
    return zero
}
// Must specify: Zero[int]()

// Fails: ambiguous inference
func Convert[T, U any](t T) U { ... }
// Must specify both: Convert[int, string](42)
\`\`\`

**Follow-ups**:
- Why can't Go infer a type parameter from a struct literal like \`Point[int]{X: 1}\` by looking at the field types?
- What changed about type inference in Go 1.21?

### Question 3: Explain the ~ Operator

**What FAANG expects**: a correct distinction between "named type matches exactly" and "any type with this underlying type", and the canonical use case (allowing domain-specific wrapper types like \`type UserID int64\` to satisfy numeric constraints).

**Answer**: The \`~\` operator matches any type with a specific underlying type:

\`\`\`go
type ~int  // Matches: int, type MyInt int, type UserID int, etc.
type int   // Matches: only int (not derived types)

// Use case: Allow custom types
type UserID int
type OrderID int

// Without ~: only works with int
func Double(x int) int { return x * 2 }

// With ~: works with any int-based type
func Double[T ~int](x T) T { return x * 2 }

var id UserID = 5
Double(id)  // Returns UserID(10)
\`\`\`

**Follow-ups**:
- Why is the \`constraints\` package from \`golang.org/x/exp\` considered largely unnecessary after Go 1.21 introduced \`cmp.Ordered\`?
- What does a \`[T ~string | ~int]\` constraint allow that \`[T string | int]\` does not?

### Question 4: How Do Generics Affect Performance?

**What FAANG expects**: correct description of GC-shape stenciling (not full monomorphization, not boxing), the tradeoff (binary-size vs per-call cost), and awareness that virtual calls through \`itab\` still happen for method calls on type parameters.

**Answer**: Generics in Go use "GC shape stenciling":
- Types with the same "GC shape" (same size, same pointer pattern) share code
- Pointer types all share one implementation
- Value types may get specialized implementations
- No runtime overhead like interface boxing
- May slightly increase binary size

Benchmarks show generics perform identically to hand-written type-specific code for the common case of pointer types or same-shape value types, unlike \`interface{}\` which has runtime overhead from type assertions and boxing. One subtlety: calling a method on a value through its type parameter still dispatches through the dictionary (a small per-call overhead similar to an interface call), so generics do not automatically devirtualize every call.

**Follow-ups**:
- Why did the Go team choose GC-shape stenciling instead of full monomorphization like C++?
- When would you see a meaningful binary-size increase from adding a generic function?

### Question 5: Implement a Generic Cache

**What FAANG expects**: correct constraint combination (\`K comparable, V any\`), thread safety via \`sync.RWMutex\`, and awareness that if you want TTL eviction you need either a background goroutine or lazy expiration on Get.

**Answer**: A generic cache parameterizes both the key and value types, combining \`comparable\` (for map keys) with \`any\` (for stored values). The implementation below uses \`sync.RWMutex\` for concurrent safety.

\`\`\`go
type Cache[K comparable, V any] struct {
    mu    sync.RWMutex
    items map[K]V
    ttl   time.Duration
}

func NewCache[K comparable, V any](ttl time.Duration) *Cache[K, V] {
    return &Cache[K, V]{
        items: make(map[K]V),
        ttl:   ttl,
    }
}

func (c *Cache[K, V]) Get(key K) (V, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.items[key]
    return v, ok
}

func (c *Cache[K, V]) Set(key K, value V) {
    c.mu.Lock()
    c.items[key] = value
    c.mu.Unlock()
}
\`\`\`

**Follow-ups**:
- The \`ttl\` field is declared but not enforced. Show how you would add lazy expiration without a background goroutine.
- Why is \`V any\` rather than \`V comparable\`? When would \`comparable\` be the right constraint?

### Question 6: What did Go 1.26 change about generics, and when would you use self-referential types?

**What FAANG expects**: you know Go 1.26 lifted the ban on generic types referring to themselves in their own constraint list, and you can name one legitimate use (fluent builders that preserve the concrete return type, custom ordered containers). Candidates who reach for self-referential generics reflexively are showing a red flag.

**Answer**: Go 1.26 (February 2026) lifted the restriction that a generic type could not reference itself in its own type parameter list. A type declaration like \`type Adder[A Adder[A]] interface { Add(A) A }\` is now legal. The feature is narrow on purpose. It makes a small set of patterns cleaner without expanding the type system to the scale of Haskell or Scala generics.

Two patterns justify it. First, fluent builders where the chained method must return the concrete builder type rather than an interface, so callers keep access to builder-specific methods without repeated type assertions. Second, custom ordered containers where each element type defines its own ordering through a self-referential constraint (\`Ranked[T Ranked[T]]\`), giving a type-safe alternative to \`sort.Interface\` with the concrete type preserved through the generic operations. For everything else, including simple value transformations and standard containers, non-self-referential generics remain the right default. See the standalone section on self-referential generics in this chapter for worked examples.

**Follow-ups**:
- What enforcement does the compiler apply to prevent infinite-depth constraint checking with self-referential types?
- Why are method type parameters still disallowed, even after this relaxation?

### Q (Senior track): How would you decide whether a new function should be generic?

**What FAANG expects**: a concrete test, not "it depends".

**Answer**: Three questions. First, would the non-generic version force me to pick \`any\` or write N copies? If yes, generics. Second, would the non-generic version use an interface with a single method? If yes, use the interface. Third, do I have more than one call site with different types today? If no, defer generics until there are.

The bar is deliberately high. Generics add complexity. Add them when the alternative is measurably worse, not because they are available.

### Q (Senior track): Your team wants to convert a hand-rolled slice helper into a generic version. How do you evaluate?

**What FAANG expects**: a thoughtful trade-off answer, not "yes" or "no".

**Answer**: Three checks. First, does the standard library \`slices\` package already do this? If yes, use it. Second, is the hand-rolled version on a hot path? If so, benchmark both, as generics sometimes have dictionary overhead that the specific-type version avoids. Third, how many callers would benefit? If one, leave the hand-rolled version alone. If ten, convert.

---
`;
