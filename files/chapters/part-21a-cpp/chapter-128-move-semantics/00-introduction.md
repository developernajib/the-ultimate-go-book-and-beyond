# Chapter 128: Move Semantics and Value Categories

> Move semantics is to C++ what garbage collection is to Java: the single feature that changed how every line of code is written.

Before C++11, every time you returned a large object from a function, passed a temporary to a constructor, or inserted an element into a vector, the compiler made a full copy. A `std::string` holding a megabyte of text would allocate a fresh megabyte, copy every byte, and then destroy the original. A `std::vector` of a million elements would copy all million elements, and each element might itself copy internal resources. Entire categories of "efficient C++" advice existed solely to work around this: returning by pointer, taking output parameters, using `swap` tricks, and avoiding temporaries.

Move semantics eliminated this problem. Instead of copying resources, you can transfer ownership from one object to another, leaving the source in a valid but unspecified state. A moved-from `std::string` gives up its internal buffer pointer to the destination and resets itself to empty. No allocation, no byte-by-byte copy, just a pointer swap. This single feature transformed C++ performance characteristics and made returning large objects by value both idiomatic and efficient.

This chapter covers move semantics from first principles through expert-level nuances. You will understand value categories (the taxonomy that determines what can be moved), write your own move constructors, use `std::move` and `std::forward` correctly, understand when the compiler elides copies entirely, and learn the reference collapsing rules that make perfect forwarding possible. You will also see how Go handles the same problems differently, without any of this machinery.

---

### Junior → FAANG: Why Move Semantics Is the Single Most Important C++11 Feature

Go engineers do not need to think about copies vs. moves because the language and GC handle resource transfer transparently. In C++, every assignment and function call involves a choice, and getting it wrong costs performance. Move semantics is the mechanism that makes that choice explicit and efficient.

The practical entry point: treat `std::move` as a "transfer ownership" annotation. When you write `std::move(x)`, you are saying "I no longer need `x` after this point. Transfer its resources to the destination." After a move, `x` is in a valid-but-unspecified state and should not be used. Violating this is a common bug.

Interview entry point: "what does `std::move` actually do?" The answer: nothing at runtime. It is a cast to an rvalue reference (`T&&`), which enables the move constructor or move assignment operator to be selected by overload resolution instead of the copy constructor. All the work happens in the constructor.

### Senior @ FAANG: Move Semantics in API Design and Performance Auditing

At the staff level, move semantics is an API design concern: does the API enable efficient resource transfer, or does it force unnecessary copies?

**API design for movability.** Any type that manages a resource (memory, file handle, socket, lock) should be movable. If it is not move-constructible, containers of it (e.g., `std::vector<T>`) cannot use move operations and will fall back to copies, making operations like vector resize O(n) in copy cost rather than O(n) in move cost. A staff engineer reviewing a new type checks that it is movable (or explicitly documents why it is not) and verifies that the move constructor and move assignment operator are marked `noexcept`, which is required for `std::vector` to use moves during reallocation.

**Move performance audit.** When a C++ service has unexpectedly high CPU usage from copy operations, a move performance audit is the first investigation step: compile with `-fprofile-generate`, run the workload, analyze with `-fprofile-use` and look for calls to copy constructors in hot paths. Alternatively, use Heaptrack to identify large heap allocations that should have been moves. Each copy in a hot path where a move was possible is a concrete performance improvement opportunity.

