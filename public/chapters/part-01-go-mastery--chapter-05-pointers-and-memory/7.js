export default `## 5.6 Value vs Pointer Receivers

### Value Receivers

Value receivers operate on a copy of the struct, making them appropriate for small, immutable types where mutation is not intended. They can be called on both values and pointers.

\`\`\`go
type Point struct {
    X, Y int
}

func (p Point) String() string {
    return fmt.Sprintf("(%d, %d)", p.X, p.Y)
}

func (p Point) Scale(factor int) Point {
    return Point{p.X * factor, p.Y * factor}
}
\`\`\`

Value receivers:
- Receive a copy of the value
- Cannot modify the original
- Are called on both values and pointers

### Pointer Receivers

Pointer receivers operate on the original struct, allowing mutation of the receiver's fields. They must be used consistently: if any method needs to mutate state, all methods should use pointer receivers.

\`\`\`go
func (p *Point) Move(dx, dy int) {
    p.X += dx
    p.Y += dy
}

func (p *Point) Reset() {
    p.X = 0
    p.Y = 0
}
\`\`\`

Pointer receivers:
- Receive a pointer to the value
- Can modify the original
- Are only callable on addressable values (for interface satisfaction)

### Go's Automatic Conversion

When calling a method, Go automatically takes the address of a value or dereferences a pointer as needed. This convenience means you can call a pointer receiver method on a value and vice versa, but only for direct method calls, not for interface satisfaction:

\`\`\`go
p := Point{1, 2}
ptr := &Point{3, 4}

// Value receiver works on both
fmt.Println(p.String())   // OK: value on value
fmt.Println(ptr.String()) // OK: auto-dereference

// Pointer receiver works on both
p.Move(1, 1)    // OK: auto-address (&p).Move
ptr.Move(1, 1)  // OK: pointer on pointer
\`\`\`

Interface satisfaction is stricter. A value stored in an interface variable is not addressable, so Go cannot automatically take its address to call a pointer receiver method:

\`\`\`go
type Mover interface {
    Move(dx, dy int)
}

var m Mover
m = &Point{1, 2}  // OK: *Point has Move
// m = Point{1, 2}   // Error: Point doesn't have Move
\`\`\`

### Choosing Receiver Type

Use pointer receiver when:
- Method modifies the receiver
- Receiver is large (avoid copying)
- Consistency (if any method is pointer, all should be)

Use value receiver when:
- Method doesn't modify receiver
- Receiver is small (map, func, chan, or small struct)
- You want value semantics (safety over efficiency)

**Consistency rule**: If any method has a pointer receiver, all methods should use pointer receivers.

\`\`\`go
// Good: consistent pointer receivers
type User struct { ... }
func (u *User) Save() error { ... }
func (u *User) Validate() error { ... }
func (u *User) String() string { ... }

// Bad: mixed receivers
func (u User) String() string { ... }  // Inconsistent!
\`\`\`

### Google's Receiver Guidelines

Google's internal Go style guide applies a concrete rule: value types that represent mathematical or identity-less concepts (money, coordinates, colors) use value receivers. Types that own mutable state or system resources use pointer receivers throughout.

\`\`\`go
// Value receivers for immutable operations
type Money struct {
    Amount   int64
    Currency string
}

func (m Money) Add(other Money) Money {
    // Returns new value - original unchanged
    return Money{
        Amount:   m.Amount + other.Amount,
        Currency: m.Currency,
    }
}

func (m Money) String() string {
    return fmt.Sprintf("%d %s", m.Amount, m.Currency)
}

// Pointer receivers for mutable operations
type Account struct {
    mu      sync.Mutex
    balance Money
    history []Transaction
}

func (a *Account) Deposit(amount Money) error {
    a.mu.Lock()
    defer a.mu.Unlock()

    a.balance = a.balance.Add(amount)
    a.history = append(a.history, Transaction{
        Type:   "deposit",
        Amount: amount,
        Time:   time.Now(),
    })
    return nil
}
\`\`\`

### Receiver Choice and Allocation Behaviour

For a senior engineer, receiver choice has implications beyond mutability:

1. **Pointer receivers participate in escape analysis differently.** When you call \`obj.Method()\` and \`Method\` has a pointer receiver, the compiler needs to take the address of \`obj\`. If \`obj\` is a local variable that does not otherwise escape, the call may force it to the heap. For hot-path methods on value-semantic types, this is a measurable cost.
2. **Value receivers copy the entire struct on every call.** For a \`Point\` struct with two ints (16 bytes), the copy is essentially free. For a struct with embedded mutexes, slices, and tens of fields, the copy is wasteful. The 64 to 128 byte threshold is the rough cutoff where the copy starts to be visible in profiles.
3. **Receiver type affects interface satisfaction.** Pointer-receiver methods are in the method set of \`*T\` only. Value-receiver methods are in the method set of both \`T\` and \`*T\`. A type with mixed receivers satisfies an interface from \`*T\` but not from \`T\`, which produces inscrutable compile errors in generic code and reflection-based libraries.

The default for any non-trivial type: pointer receivers throughout. The exception: small immutable value types where copying is the desired semantics.

### Sync.Mutex and Embedded Locks

A struct that contains a \`sync.Mutex\` (or any \`sync\` type) must use pointer receivers, because copying a locked mutex is undefined behaviour. The \`go vet\` \`copylocks\` analyser catches the most obvious cases. The code-review rule:

\`\`\`go
// Wrong: value receiver on a type with a mutex
type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (c SafeCounter) Increment() { // copies the mutex!
    c.mu.Lock()
    c.count++ // also modifies a copy
    c.mu.Unlock()
}

// Right: pointer receiver
func (c *SafeCounter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}
\`\`\`

If your type embeds a mutex, all methods must use pointer receivers. There are no exceptions.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in receiver-choice PRs:

1. **Mixed receivers on the same type.** Always a finding. Pick one and apply consistently.
2. **A value receiver on a struct that grew past 128 bytes.** Often the type started small and accumulated fields. The receivers were never updated. Add to the team's review checklist: when a struct grows, audit its receivers.
3. **A pointer receiver on a small value-semantic type.** \`Point\`, \`Time\`, \`Currency\` should usually have value receivers. The pointer receiver forces a heap allocation when the value is constructed and a method is called on the result.

### Migration Lens

Coming from Java, every method is effectively a pointer-receiver method (because \`this\` is a reference). Go's value-vs-pointer distinction restores a control you did not know you had. Coming from Rust, the closest analogue is \`&self\` vs \`&mut self\` vs \`self\`, with Rust's borrow checker enforcing the rules. Go's discipline is convention-driven instead.

---
`;
