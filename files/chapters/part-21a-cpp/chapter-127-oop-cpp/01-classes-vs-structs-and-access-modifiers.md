## Classes vs Structs and Access Modifiers

### The C++ Class

In C++, `class` and `struct` are almost identical. The only difference is the default access level: `class` defaults to `private`, `struct` defaults to `public`. By convention, `struct` is used for plain data aggregates and `class` is used when behavior and invariants are involved.

```cpp
// A class: members are private by default
class BankAccount {
private:
    std::string owner_;
    long long balance_cents_;  // money is integer minor units, never double

public:
    BankAccount(const std::string& owner, long long initial_cents)
        : owner_(owner), balance_cents_(initial_cents) {}

    void deposit(long long amount_cents) {
        if (amount_cents > 0) balance_cents_ += amount_cents;
    }

    long long balance_cents() const { return balance_cents_; }
    const std::string& owner() const { return owner_; }
};

// A struct: members are public by default
struct Point {
    double x;
    double y;
};
```

### The Go Equivalent

Go has only `struct`. There are no access modifiers at the field level. Instead, Go uses capitalization: an uppercase first letter means exported (public to other packages), lowercase means unexported (package-private).

```go
package bank

// BankAccount - exported type, visible outside the package
type BankAccount struct {
    owner        string // unexported: only accessible within package bank
    balanceCents int64  // unexported, money is integer minor units
}

// NewBankAccount is the constructor-like factory function
func NewBankAccount(owner string, initialCents int64) *BankAccount {
    return &BankAccount{owner: owner, balanceCents: initialCents}
}

func (a *BankAccount) Deposit(amountCents int64) {
    if amountCents > 0 {
        a.balanceCents += amountCents
    }
}

func (a *BankAccount) BalanceCents() int64 { return a.balanceCents }
func (a *BankAccount) Owner() string       { return a.owner }
```

### Access Modifier Comparison

| Concept | C++ | Go |
|---|---|---|
| Public to everyone | `public:` | Uppercase first letter |
| Private to type only | `private:` | Lowercase first letter (package-private, not type-private) |
| Protected (subclass access) | `protected:` | No equivalent. Use embedding or package-level access |
| Friend access | `friend` declaration | No equivalent. Package-level access is the closest |
| Default access | `private` in class, `public` in struct | Determined by first letter of identifier |
| Granularity | Per-member within a class | Per-identifier across a package |

A crucial difference: Go's unexported fields are accessible by any code in the same package, not just the defining type. C++ `private` truly restricts access to the class itself (and its friends). This means Go relies on package boundaries as the encapsulation unit, while C++ uses class boundaries.

### The `friend` Keyword

C++ allows a class to grant private access to specific other classes or functions:

```cpp
class Wallet {
    friend class Auditor; // Auditor can access private members
private:
    long long secret_balance_cents_ = 100000;  // $1,000.00

public:
    long long public_balance_cents() const { return secret_balance_cents_; }
};

class Auditor {
public:
    long long inspect(const Wallet& w) {
        return w.secret_balance_cents_; // legal: Auditor is a friend
    }
};
```

Go has no `friend` equivalent. If two types need to share internal details, they live in the same package:

```go
package wallet

type Wallet struct {
    secretBalanceCents int64 // accessible to Auditor because same package
}

type Auditor struct{}

func (a *Auditor) Inspect(w *Wallet) int64 {
    return w.secretBalanceCents // legal: same package
}
```

---

### Junior → FAANG: Access Modifiers as API Design, Not Just Encapsulation

Go has only exported (uppercase) and unexported (lowercase) names, with package-level granularity. C++ has `public`, `protected`, and `private` at the class level. The difference matters: `protected` members are visible to derived classes but not the outside world, creating a third visibility tier.

The common beginner mistake is making members `protected` by default "in case someone needs to subclass." This is premature design: it commits you to maintaining those members as part of the derived-class API forever. Start `private`, and only promote to `protected` when you have a concrete derived class that needs access.

Interview note: "what is the only difference between `class` and `struct` in C++?" The answer: default member access is `private` for `class` and `public` for `struct`. That is the only difference. Conventionally, `struct` is used for passive data holders (Plain Old Data), and `class` is used for types with invariants and behavior.

### Senior @ FAANG: Access Control as a Coupling Metric

At the staff level, access control is a measure of coupling. Every `protected` member is a coupling point between the base class and every possible derived class. Every `friend` declaration is a coupling point between two specific classes. Both should appear in code review as flags for architectural review.

**`friend` usage policy.** `friend` breaks encapsulation for one specific class or function. Its legitimate uses are: unit test classes that need to inspect private state (better: redesign the API to make state inspectable without `friend`), factory functions that construct objects with private constructors, and `operator<<` for stream output. Any other use of `friend` is a design smell that warrants a comment explaining why the coupling is justified.

**Reducing coupling through private inheritance and composition.** When a class needs to reuse an implementation but should not expose the parent's interface, private inheritance achieves "implemented-in-terms-of" without the coupling of public inheritance. However, the same result is achievable with composition and a private member, which is simpler and more explicit. A staff engineer defaults to composition and uses private inheritance only when it reduces code significantly (e.g., using the Empty Base Optimization for a policy class).

