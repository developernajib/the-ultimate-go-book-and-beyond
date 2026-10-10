## Defensive vs Offensive Programming

Two opposing schools, both with merit. **Defensive** says: assume callers will misuse you, guard every input, never trust anything. **Offensive** says: state the contract loudly, crash hard on violation, never paper over bugs. The right answer in a large C++ codebase is neither pure: validate at the trust boundary, contract everywhere inside.

### The Trust Boundary

Code lives in zones of trust. At each zone boundary, you choose between:

- **Validate:** check input, return error on failure.
- **Contract:** assume input is valid, if not, crash.

The boundaries that matter:

| Boundary | Posture |
|---|---|
| Network input (HTTP body, RPC arg) | Validate. Untrusted. |
| User input (CLI args, config file) | Validate. Could be mistyped. |
| Cross-process IPC | Validate. Other process could be malicious or buggy. |
| Public library API | Validate or contract. Document which. |
| Internal module API | Contract. Crash on violation. |
| Function inside a module | Contract. Crash on violation. |

Mixing the two within one zone is the bug. A function that both validates and contracts the same property is doing duplicate work, if the validation passes, the contract is by definition true. A function that does neither is the worst of both worlds: undefined behavior on bad input, no diagnostic.

### Fail Fast

The fail-fast principle: when an invariant is violated, crash immediately with the most context possible. Do not try to "recover" by inserting a default value or skipping the bad input. Either the bad input was a programmer bug (fix the bug, not the input) or it was a security issue (recovery is a vector for further compromise).

The pattern:

```cpp
void Process(const Frame& f) {
    CHECK_GE(f.size(), kHeaderSize) << "frame too small: " << f.size();
    CHECK(f.crc_valid()) << "frame crc invalid";
    // Now we trust f. No more checks.
    DispatchByType(f);
}
```

After the `CHECK`s, the rest of the function treats `f` as valid. No more `if (f.size() < kHeaderSize) return;` defensive code. That code path is unreachable, if it is reached, the invariant analysis is wrong and you want to know now.

### Fuzzer-Friendly Assertions

A fuzzer (libFuzzer, AFL++) explores program states and looks for crashes. Assertions are signal flares for the fuzzer: every reachable assertion is a finding. Two consequences for code style:

- **Use `assert` (or `CHECK`) liberally on internal invariants.** The fuzzer runs them as discovery surfaces.
- **Sanitizer-flag invariants.** UBSan, ASan, MSan instrument operations the assert macro does not see. Build the fuzzer target with all three.

```cpp
// Fuzz target
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    try {
        Parse(data, size);   // throws on malformed input (validation)
    } catch (const ParseError&) {
        // Expected. Not a fuzz finding.
    }
    return 0;
}
```

The validation path swallows expected errors. Internal `CHECK` inside `Parse` for invariants does not. If a fuzzer triggers an internal `CHECK`, it has found a bug in `Parse`, not bad input.

### Exception Guarantees

Three levels, due to Dave Abrahams:

**No-throw guarantee.** The operation will not throw. Used for destructors, swap, deallocation.

**Strong guarantee (commit-or-rollback).** If the operation throws, the program state is unchanged. Used for transactional operations. Implementation often uses copy-and-swap.

**Basic guarantee.** If the operation throws, the program is in a valid (but unspecified) state. Invariants hold, no resources leaked, but the operation may have partial effects.

A function with no exception guarantee at all is a bug. Some operation that throws halfway and leaves the program in an invalid state is undefined behavior in waiting.

### `std::vector::push_back` Guarantee

Per `[vector.modifiers]`:

- If `T`'s move constructor is `noexcept` or `T` is not copy-constructible, the strong guarantee holds.
- Otherwise, only the basic guarantee holds.

The reasoning: when `push_back` triggers a reallocation, it must move (or copy) all existing elements. If a move throws partway, the new buffer is half-populated and the old buffer is gone. There is no rollback. So the standard says: if moves can throw, fall back to copying (which can fail without losing the old buffer), if moves cannot throw, use them and keep the strong guarantee.

```cpp
struct Item {
    std::string a;
    std::string b;
    Item(Item&&) noexcept = default;        // critical
    Item& operator=(Item&&) noexcept = default;
};

std::vector<Item> v;
v.reserve(1000);
v.push_back(/* ... */);  // strong guarantee, fast path
```

Without `noexcept` on the move, `push_back` copies on grow, which is slow and changes the guarantee.

### Strong Guarantee in Your Own Code

The copy-and-swap idiom:

```cpp
class Connection {
public:
    void Reconfigure(const Config& cfg) {
        Connection tmp = BuildFrom(cfg);   // may throw; no state change yet
        swap(*this, tmp);                  // noexcept
    }                                       // tmp dtor runs; old state cleaned up
};
```

If `BuildFrom` throws, the original `Connection` is unchanged (strong guarantee). If `swap` is `noexcept` (which it must be), no exception escapes after the commit point.

The pattern requires:

- `swap` is `noexcept`.
- All destructors are `noexcept`.
- The "build" step is purely allocation/computation, no shared mutation.

### Transactional Code Patterns

For multi-step operations, prepare-then-commit:

```cpp
struct Transaction {
    void AddInsert(Row r);
    void AddUpdate(RowId id, Row r);
    void AddDelete(RowId id);
    void Commit();      // last step; throws on conflict
    void Rollback() noexcept;
};

void DoBatch() {
    Transaction t = db.Begin();
    auto guard = absl::Cleanup([&]() noexcept { t.Rollback(); });
    t.AddInsert(...);
    t.AddUpdate(...);
    t.AddDelete(...);
    t.Commit();
    std::move(guard).Cancel();    // commit succeeded, do not rollback
}
```

If anything throws between `Begin` and `Commit`, the cleanup runs `Rollback` automatically. After `Commit` succeeds, `Cancel` defuses the cleanup.

### Defensive Bug Patterns to Avoid

**Silent input clamping.** "If size > MAX, just use MAX." Hides the bug, produces wrong answers downstream.

**Default-on-error.** "If parse fails, return 0." Caller never knows the input was bad.

**Catch-and-continue at internal boundaries.** Internal modules should let exceptions propagate. Catching at the wrong layer destroys context.

**Null check before every dereference.** If a pointer can be null, the type should reflect it (`optional`, `unique_ptr`). If it cannot, do not check.

**`if (!input.empty())` followed by `input.front()` followed by another `if (!input.empty())`.** Either trust or do not. Both wastes branches and adds places to disagree.

### Offensive Bug Patterns to Avoid

**`assert` on user input.** User input is untrusted by definition. Validate, do not assert.

**Crash on a recoverable condition.** Network timeout is not a programmer bug. Retry or surface, do not abort.

**No diagnostic with the crash.** `abort()` with no context is hostile. `CHECK_EQ(x, y) << ctx` shows both values and the context.

**Crashing in production for "debug" checks.** Use `DCHECK` (debug only) for sanity, `CHECK` (always on) for safety. Mixing them produces release crashes from debug-only code.

### When to Pick Which Guarantee

- **No-throw.** Destructors, deallocation, swap, move (where possible).
- **Strong.** Top-level transactional operations: HTTP request handling, database transactions, "save settings".
- **Basic.** Most other code. Document it: "if this throws, the object is valid but its contents are unspecified".

The basic guarantee is fine. The bug is "no guarantee at all", which means future-you (or future-coworker) does not know whether it is safe to retry, log, or destroy after an exception.

### FAANG Bar

A senior engineer should:

- Identify the trust boundary in the code under review.
- Pick validate vs contract per boundary.
- Apply fail-fast for invariants, validation for inputs.
- Pick and document an exception guarantee for every API.
- Use copy-and-swap or scope-guard rollback for strong-guarantee transactions.
- Recognize defensive anti-patterns (silent clamping, default-on-error).
- Recognize offensive anti-patterns (assert on user input, crash without context).
