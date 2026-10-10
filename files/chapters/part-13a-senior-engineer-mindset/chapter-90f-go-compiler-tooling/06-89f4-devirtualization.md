## 90F.4 Devirtualization

### Interface Method Calls and Devirtualization

Interface method calls use a dispatch table (vtable-style). Each call: load interface type pointer → look up method in table → indirect call. Expensive compared to direct calls.

Devirtualization: when the compiler can determine the concrete type at the call site, it replaces the indirect call with a direct call (which can then be inlined).

```bash
# See devirtualization decisions
go build -gcflags="-d=ssa/opt/debug=2" . 2>&1 | grep "devirtualize\|interface"
```

```go
// Example: devirtualization in action
type Stringer interface {
    String() string
}

type User struct {
    Name string
}

func (u *User) String() string {
    return u.Name
}

// This call CAN be devirtualized if compiler sees only one concrete type
func printStringer(s Stringer) {
    fmt.Println(s.String())
}

func main() {
    u := &User{Name: "Alice"}
    printStringer(u) // Compiler may devirtualize: knows s is *User, calls u.String() directly
}

// Generics enable guaranteed devirtualization:
func printAny[T Stringer](t T) {
    fmt.Println(t.String()) // T is known at compile time → always devirtualized + inlined
}
```

### Junior → FAANG: Devirtualization as a Generics Justification

When interviewers ask "when would you use generics instead of interfaces in Go?" devirtualization is a concrete, performance-grounded answer: "Generics guarantee devirtualization and enable inlining of the concrete method, which matters on hot paths where the interface dispatch overhead is measurable. I would benchmark both to confirm the trade-off is worth the added type complexity." This is a far stronger answer than "generics are faster" without explanation.

### Senior @ FAANG: Devirtualization and API Design at Scale

At L6, the interface-versus-generics decision is an API design decision that affects every caller, not just the hot path. Changing a public API from interface to generic type parameter is a breaking change. The ADR for this decision needs to document: what is the measured overhead of interface dispatch on this path, what is the readability cost of the generic version, what is the API stability impact, and which callers benefit from devirtualization? Without this analysis, engineers make the change based on instinct and reverse it six months later for the same reason.

---
