# Chapter 127: Object-Oriented C++

> "The purpose of abstraction is not to be vague, but to create a new semantic level in which one can be absolutely precise." - Edsger W. Dijkstra

Go does not have classes, inheritance hierarchies, or virtual dispatch tables. It achieves polymorphism through interfaces and composition. C++ takes the opposite path: it gives you a full object-oriented type system with single and multiple inheritance, virtual functions backed by compiler-generated vtables, access control at three granularity levels, and deterministic object lifetimes governed by constructors and destructors. Knowing these mechanisms matters not only for writing C++ but also for appreciating why Go's designers chose a radically different model. This chapter walks you through every major OOP concept in C++, maps each one back to Go, and prepares you for the design questions that appear in FAANG interviews.

---

### Junior → FAANG: Treating OOP as a Mechanism, Not a Philosophy

Go engineers sometimes approach C++ OOP with either reverence ("this is the real way to do objects") or suspicion ("inheritance is bad"). Neither is useful. C++ OOP is a set of mechanisms, each with costs and benefits. Virtual dispatch costs a vtable lookup and prevents inlining. Inheritance exposes private internals to derived classes. Multiple inheritance can introduce the diamond problem. These are not moral judgments. They are engineering trade-offs.

Study each mechanism in this chapter by asking: what problem does it solve, what does it cost, and when would you use it in a real system? Start with a concrete FAANG example for each: the abstract base class pattern in RocksDB's `Comparator`, the Rule of Five in Folly's `IOBuf`, the SOLID principles in Chrome's plugin architecture.

### Senior @ FAANG: OOP Design Reviews at Scale

At the staff level, OOP design is an API contract question with long-term implications. Every virtual function is a commitment to a calling convention that derived classes must satisfy (Liskov Substitution Principle). Every `protected` member is an API surface that derived classes depend on. Breaking these contracts breaks every subclass, which in a large codebase means a company-wide migration.

**Design review checklist for new class hierarchies.** When reviewing a proposed class hierarchy, ask: (1) does each class in the hierarchy satisfy the Liskov Substitution Principle? (2) is the hierarchy shallow (two levels maximum) or does it require deep inheritance? (3) would composition with an interface achieve the same result with fewer coupling points? (4) are all `protected` members intentionally part of the API for derived classes, or are they an implementation detail that should be `private`? (5) is there a virtual destructor on every base class with virtual functions?

**When to prefer composition over inheritance.** A staff engineer's default answer is composition. Use inheritance only when: the relationship is genuinely "is-a" (not "has-a" or "is-implemented-using"), the derived class is a behavioral specialization (not a data container extension), and the base class's virtual function contract is stable for the lifetime of the codebase. When in doubt, factor out an interface (pure abstract class) and have both the base implementation and the specialized implementation implement it independently.

