## Key Takeaways

- **RAII is Go's `defer`, generalized.** `ScopeGuard` and `TransactionGuard` bring Go's "clean up on scope exit" pattern to C++ with block-level granularity, distinct success/failure paths via `scope_success`/`scope_fail`, and deterministic ordering. C++23 standardizes these as `std::scope_exit`, `std::scope_fail`, and `std::scope_success` in `<scope>`.

- **Pimpl solves a problem Go does not have.** Because Go enforces package-level encapsulation through unexported identifiers, there is no cascading recompilation from private member changes. In C++, Pimpl, a `unique_ptr` to a forward-declared `Impl`, is the standard solution for large headers that drag in heavy dependencies. The destructor must always be defined out-of-line in the `.cpp` file where `Impl` is complete.

- **Type erasure is the mechanism beneath Go's interfaces.** Go builds it into the language (two-word iface header). C++ makes you choose your mechanism, virtual dispatch, `std::function` with SBO, `std::any` with RTTI, or a hand-rolled inline callable. The hand-rolled version lets you tune the SBO buffer, eliminate heap allocation, and drop the RTTI requirement.

- **Policy-based design achieves zero-overhead compile-time composition.** By parameterizing a class with template policies, you get M+N+P implementations covering M×N×P behavior combinations with no vtable, no runtime dispatch, and full optimizer visibility. The cost: each instantiation is a distinct type, longer compile times, and no runtime swapping.

- **`std::variant` + `std::visit` replaces classical Visitor and enum state machines.** The key advantage over both is compile-time exhaustiveness: adding a new alternative to the variant causes every `std::visit` call that does not handle it to fail to compile. The `overload` helper, two lines, zero overhead, makes inline multi-case visitors ergonomic.

- **State machines encoded as variant types are self-documenting and safe.** Each state carries exactly the data relevant to that state. Invalid state/data combinations are structurally impossible. Transition functions via nested `std::visit` enumerate all valid (state, event) pairs explicitly. This replaces the common `enum + switch + optional fields` pattern that accumulates invariant violations silently.

- **Strategy pattern cost is a deployment-time decision.** Template strategy: zero overhead, compile-time only. `std::function` strategy: ~3-5 ns per call, runtime-swappable, SBO for small callables. Virtual dispatch strategy: ~5-10 ns, up to 30 ns for megamorphic call sites. Choose by profiling the actual call frequency, not by intuition.

- **Observer lifetime safety requires RAII handles or `weak_ptr` auto-unsubscription.** Raw pointer observers that outlive their signal produce silent crashes. RAII subscription handles, whose destructor calls `unsubscribe()`, are the C++ equivalent of Go channel close: ownership is explicit, cleanup is automatic.

- **Builder with CRTP solves the return-type problem in fluent inheritance.** When a derived builder inherits from a base builder, base methods naively return `Base&`, breaking the chain. CRTP (base parameterized on derived type) makes base methods return `Derived&` at zero cost. Go's functional options pattern is simpler and more open for extension. C++ Builder is better for centralized validation.

- **ECS is a performance-specific architecture, not a default.** Entity-Component-System separates identity, data, and logic to achieve cache-friendly dense iteration over component arrays. The sparse set delivers O(1) add, remove, and lookup with contiguous dense storage. Reach for ECS only when profiling reveals that OOP per-entity object scatter is the actual bottleneck, typically at 10,000+ homogeneous entities iterated every frame.

---

| [◀ Chapter 140: Custom Memory Allocators](../chapter-140-custom-allocators/00-introduction.md) | [Chapter 141: Design Patterns in Modern C++](00-introduction.md) | [Chapter 142: Build Systems and Tooling](../chapter-142-build-systems-tooling/00-introduction.md) ▶ |
