## Error-Handling Rubric for Code Review

A code review rubric is the difference between subjective ("looks fine to me") and consistent ("this is the standard, the change does or does not meet it"). Error handling is one of the densest sources of review comments at any FAANG-scale company. The rubric below maps to the L4 / L5 / L6 ladder common in industry: L4 writes correct code in a defined module, L5 reviews and shapes APIs across modules, L6 sets policy and reviews architectures. Each rung has a higher bar.

### L4: Writes Correct Error Code

What an L4 must produce, and what an L4 review must catch.

**Mandatory.**

- Every fallible function returns or throws something the caller must handle. No silent failures.
- `[[nodiscard]]` on functions returning `expected`, `Status`, `error_code`, or `bool` that means "ok or not".
- No `catch (...) { /* ignore */ }`. If you catch all, you log at minimum.
- No `assert` on user input. Validation, not assertion.
- No `throw` from a destructor.
- Move ctors and dtors `noexcept` where the type allows.
- Resources owned by RAII types (`unique_ptr`, scope guards, file handle wrappers). No raw `new` followed by code that can throw.

**Common L4 mistakes flagged in review.**

```cpp
// Bug 1: swallowing
try { Process(req); } catch (...) {}
// Fix: log, rethrow, or surface as Status.

// Bug 2: discarding result
ParsePort(input);     // returns Status
// Fix: ASSIGN_OR_RETURN or explicit if (auto s = ...; !s.ok()) ...

// Bug 3: defensive followed by trust
if (p == nullptr) return;
DoSomething(*p);       // ok now
DoSomethingElse(*p);   // also ok... wait, did we change p? Audit.

// Bug 4: throwing from dtor
~Connection() {
    if (auto ec = flush()) throw std::system_error(ec);  // calls terminate during unwind
}
// Fix: log, set a flag, or close-then-discard. Never throw from dtor.

// Bug 5: assert on input
void Handle(const Request& r) {
    assert(r.port() > 0);   // will be compiled out in release
    // production sees the bug only when port == 0
}
// Fix: validate (if (r.port() <= 0) return InvalidArg(...);) or CHECK if internal invariant.

// Bug 6: noexcept on a function that may throw via callee
void SafeWrap() noexcept { LogIt("hello"); }   // LogIt may throw; abort if it does
// Fix: catch internally, or remove noexcept.
```

### L5: Owns API Shape and Module Error Policy

L5 designs error vocabularies, picks between exceptions and codes, and reviews whose responsibility it is to log.

**Ownership.**

Every error has a single owner: the function that decides whether to surface, wrap, or absorb. Bad reviews see errors logged at three layers and surfaced at the top, producing triple log lines per failure. Good reviews see exactly one log line per error and a propagation chain with clear ownership.

The standard pattern:

- **Producer:** detects the error, returns/throws with full context. Does not log.
- **Mid-layer:** wraps with additional context if needed. Does not log unless catching to surface a different error.
- **Boundary:** logs once with full chain, decides retry vs surface, returns to caller (RPC client, HTTP layer, etc.).

A review for new module code asks: where is the boundary? Is logging consolidated there? Can the producer be reused without forcing a log?

**Wrap vs Surface.**

Wrapping (`throw_with_nested`, `Status` with cause payload, custom error chain) preserves the original cause while adding context. Surfacing means returning the original error unchanged.

Wrap when the new context adds information ("failed to load config" wrapping "file not found at /etc/svc.toml"). Surface when you are a pass-through (a thin RPC stub returning the inner status verbatim).

The wrong move is wrapping with no added information ("operation failed" wrapping "operation failed"). Strip it.

**Retryable vs Fatal Classification.**

Every error code or exception type should be classifiable. The rubric:

| Class | Action | Examples |
|---|---|---|
| Retryable transient | Backoff and retry | UNAVAILABLE, network timeout, connection reset |
| Retryable rate-limited | Wait per server hint, retry | RESOURCE_EXHAUSTED with RetryInfo |
| Permanent client | Surface to caller, do not retry | INVALID_ARGUMENT, NOT_FOUND, PERMISSION_DENIED |
| Permanent server | Surface, alert | INTERNAL with no further hint, unhandled exception |
| Programmer bug | Crash | CHECK failure, assertion, contract violation |
| Canceled | Stop, propagate cancellation | CANCELED, deadline elapsed |

A review for a new error type asks: which class is this? Is the classification documented? Does the wire model expose it (typed code, machine-readable reason)?

**Constructor Failure.**

If a constructor can fail, the choice is:

- Throw from the constructor. Object is never observable in a partial state. Forces try/catch at every call site or RAII discipline.
- Two-step: default-construct, then `init()` returns `Status`. Object exists in an unusable state until init runs. Easy to use incorrectly.
- Static factory returning `expected<T, E>`. No partial object, no exception.

The factory pattern is the modern default. Constructors are reserved for "cannot meaningfully fail" or "throwing is the right answer at every reasonable call site".

```cpp
class Connection {
public:
    static std::expected<Connection, std::error_code> Open(std::string_view host);
private:
    Connection(/* private */);
};
```

L5 review notes: "Why does this constructor throw? Could it be a factory?"

**API Surface.**

A library exposes either exceptions or codes, ideally not both for the same API surface. Mixing forces every caller to handle two paths. The standard library's `<filesystem>` dual-API is the exception that proves the rule: same operations, two overload sets, caller picks.

For your own libraries, pick one and document it. If the library is internal-only and the codebase uses exceptions, exceptions. If the library crosses an ABI or wants zero-overhead success, codes/`expected`.

### L6: Sets Policy, Reviews Architecture

L6 reviews ask whole-system questions.

**Error Budget.**

What fraction of requests can fail before the SLO breaks? The error budget. 99.9% availability means 43 minutes of downtime per month. A 5xx burst that consumes 10 minutes of budget is a third of the month's budget in one incident.

The review for an architecture proposal: what are the failure modes? What is their probability? Does the design exhaust the budget per incident, or does it degrade gracefully?

**Failure Domains.**

A system with N replicas has N failure domains. A system with one shared dependency has one failure domain regardless of N. If the dependency goes, all N go. The review asks: what is the smallest set of failures that takes down the system? Is it correlated with anything?

Error handling at architecture level is about isolating failure domains: bulkheads (separate thread pools per dependency), circuit breakers (fast-fail when a dependency is unhealthy), backpressure (refuse requests instead of queueing forever).

**Alert Hygiene.**

Every error class should map to an alert decision: page (wake someone now), ticket (look at it tomorrow), log (record but ignore). Every alert must be actionable. Pages that trigger ten times an hour and have no action are noise, engineers stop reading them, real fires get missed.

L6 review of monitoring: do alerts correspond to user-visible problems? Is the alert SNR above 0.5? Are there runbooks for each alert?

**Postmortem Loop.**

Every production incident produces a postmortem. The postmortem identifies: what happened, what was the user impact, what was the root cause, what was the contributing factor, what is the action item. Action items go into the queue and get done. If they do not, the loop is broken and the same incident recurs.

Error handling at culture level: the postmortem feeds the rubric. New patterns of failure produce new review checks. Old checks that no longer fire get retired.

### FAQ of Bad Patterns

**Catch and ignore.** `try { x(); } catch (...) {}`. Always wrong. Either you handle (log, recover, return) or you do not catch.

**Catch and rethrow with no transformation.** `try { x(); } catch (...) { throw; }`. Equivalent to no catch. Remove.

**Catch base, not specific.** `catch (std::exception& e)` when only `std::runtime_error` was meant. Catches more than intended. Be specific.

**Throwing in destructors.** Always wrong. Log and continue.

**Pre-condition check that the function then re-checks.** Pick one (validate or contract). Both wastes time and creates places to disagree.

**`if (err) return err; if (err) return err;` ladders.** Use `?`, `ASSIGN_OR_RETURN`, or `and_then`. Long ladders hide which branch was taken.

**Exception used for control flow.** `try { return parse(s); } catch (...) { return -1; }` to handle the parse-failure case. Use `expected`, the catch is too expensive.

**`assert` on production conditions.** `assert(connect(...) == 0)` compiles to nothing in release. Use `CHECK`.

**Discarded return.** `parse(s);` ignoring `expected<int, E>`. Mark `[[nodiscard]]`, fix all warnings.

**Logging at every layer.** Triple-log per error. Pick one layer.

**Silent retry.** Retry without logging the original failure. The successful retry hides the underlying problem until it stops succeeding.

**Wrap with no added info.** "Operation failed" wrapping "Operation failed". Strip.

**Logging secrets.** API keys, tokens, PII. Filter before sink.

**`catch (...)` at every level.** The boundary catches, internal layers propagate.

### Putting It Together

Code review for error handling becomes systematic. Open the diff, ask in order:

1. Does every fallible function declare its failure mode in the signature?
2. Are returns checked at the call site?
3. Is `noexcept` correct on movables and dtors?
4. Where does logging happen, and is it once per error?
5. Is the wrap-vs-surface decision sensible?
6. Is the retry classification right?
7. Are programmer bugs separated from runtime conditions?
8. Are there silent catches?
9. Is the test coverage on error paths real?

Reviews that follow this rubric converge to consistent, debuggable error handling across the codebase. Reviews that do not produce per-engineer, per-mood inconsistency, and the on-call team pays the cost.
