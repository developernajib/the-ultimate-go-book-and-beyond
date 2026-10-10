## 90K.11 Rust: NASA's Potential Future Language

While C dominates NASA's current flight software, there is growing interest in Rust as a
potential successor. Several factors drive this interest:

### Why Rust Is Being Considered

1. **Memory safety without garbage collection.** Rust's ownership system prevents
   use-after-free, dangling pointers, and data races at compile time - without a GC.
   This addresses C's biggest weakness while maintaining NASA's no-GC requirement.

2. **Ferrocene - a qualified Rust compiler.** Ferrocene, developed by Ferrous Systems
   and AdaCore, is a qualified Rust compiler toolchain. It has been qualified under
   ISO 26262 (automotive safety) and IEC 61508 (industrial safety). DO-178C
   qualification (avionics) is a stated goal.

3. **NASA TechPort projects.** NASA has funded research into using Rust for flight
   software. The TechPort database includes projects evaluating Rust for embedded
   space applications.

4. **Zero-cost abstractions.** Rust's abstractions (iterators, closures, generics) compile
   away to the same machine code as hand-written C, maintaining the performance
   characteristics NASA requires.

5. **Concurrency safety.** Rust prevents data races at compile time, which would have
   caught the Mars Pathfinder priority inversion at the type level.

### Why Rust Has Not Qualified Yet

1. **No DO-178C qualified toolchain.** Ferrocene targets automotive (ISO 26262), not
   avionics (DO-178C). DO-178C qualification is significantly more demanding.

2. **Limited WCET tooling.** Few tools exist for Rust WCET analysis on rad-hard
   processors.

3. **No VxWorks tier-1 support.** Rust can compile for VxWorks targets, but it is not a
   tier-1 supported platform.

4. **No flight heritage.** NASA values flight heritage - proven reliability in actual
   missions. C has decades of flight heritage. Rust has zero. The first Rust-in-space
   mission will need to be a low-risk technology demonstration.

5. **Workforce availability.** C programmers with flight software experience are more
   available than Rust programmers with the same background.

6. **Unsafe blocks.** Rust's `unsafe` keyword allows bypassing the borrow checker.
   Flight software would need to restrict or eliminate `unsafe` usage, similar to how
   C++ is restricted to a safe subset at JPL.

### Timeline Estimate

A realistic timeline for Rust in NASA flight software:

- **2024-2026:** Research and prototyping. Rust used for ground tools and non-critical
  software.
- **2027-2029:** Ferrocene achieves DO-178C qualification. First CubeSat or small
  satellite missions use Rust for non-critical subsystems.
- **2030-2035:** Rust achieves flight heritage on multiple missions. First use in
  primary flight software on a Class B mission.
- **2035+:** Rust becomes an accepted language for Class A (flagship) missions alongside
  C.

### What This Means for Go Engineers

Rust's potential adoption at NASA does not affect Go's role in the industry. Go excels
in domains where NASA's constraints do not apply: web services, infrastructure tooling,
distributed systems, and cloud-native applications. However, understanding why Rust might
qualify for flight software while Go cannot illuminates the fundamental trade-offs
between safety, performance, and productivity.

```go
package nasa

import "fmt"

// Assert checks an invariant and panics if false.
func Assert(condition bool, format string, args ...any) {
    if !condition {
        if len(args) == 0 {
            panic("assertion failed: " + format)
        }
        panic(fmt.Sprintf("assertion failed: "+format, args...))
    }
}

// Comparison of memory safety approaches.
//
// C:    Manual memory management. No safety guarantees.
//       Programmer must get it right every time.
//       Bug: Use-after-free, dangling pointers, buffer overflows.
//       NASA mitigation: Static analysis, coding rules, testing.
//
// Go:   Garbage collected. Memory safety at runtime.
//       GC prevents use-after-free and dangling pointers.
//       Bug: GC pauses are non-deterministic.
//       NASA problem: Cannot prove WCET with GC.
//
// Rust:  Ownership system. Memory safety at compile time.
//        No GC. No runtime overhead for safety.
//        Advantage: Catches Mars Pathfinder-style bugs at compile time.
//        NASA problem: No DO-178C toolchain yet. No flight heritage.
//
// Go's niche: Systems where GC pauses in the low milliseconds are
// acceptable. This covers >99% of software ever written.
// NASA's niche: The <1% where millisecond-level non-determinism
// can end a mission.

// RustStyleOwnership demonstrates how to apply Rust-inspired ownership
// patterns in Go to prevent resource leaks. Go does not enforce these
// at compile time, but the patterns still improve reliability.

// OwnedResource represents a resource with clear ownership.
// Only the owner may close it. Transferring ownership is explicit.
type OwnedResource struct {
    name   string
    data   []byte
    closed bool
    owner  string
}

// NewOwnedResource creates a resource with an explicit owner.
func NewOwnedResource(name string, size int, owner string) *OwnedResource {
    Assert(name != "", "resource name must not be empty")
    Assert(size > 0, "resource size must be positive")
    Assert(owner != "", "resource owner must not be empty")

    return &OwnedResource{
        name:  name,
        data:  make([]byte, size),
        owner: owner,
    }
}

// Use accesses the resource. Panics if resource is closed (use-after-free).
func (r *OwnedResource) Use(caller string) ([]byte, error) {
    Assert(!r.closed, "use-after-free: resource %s was already closed", r.name)

    if caller != r.owner {
        return nil, fmt.Errorf("access denied: %s is owned by %s, not %s",
            r.name, r.owner, caller)
    }

    return r.data, nil
}

// Transfer transfers ownership to a new owner. The old owner can
// no longer access the resource.
func (r *OwnedResource) Transfer(oldOwner, newOwner string) error {
    Assert(!r.closed, "cannot transfer closed resource %s", r.name)

    if r.owner != oldOwner {
        return fmt.Errorf("transfer denied: %s is owned by %s, not %s",
            r.name, r.owner, oldOwner)
    }

    r.owner = newOwner
    return nil
}

// Close releases the resource. Only the owner may close it.
func (r *OwnedResource) Close(caller string) error {
    if r.closed {
        return fmt.Errorf("double close: resource %s already closed", r.name)
    }

    if r.owner != caller {
        return fmt.Errorf("close denied: %s is owned by %s, not %s",
            r.name, r.owner, caller)
    }

    // Zero memory before release (defense in depth).
    for i := range r.data {
        r.data[i] = 0
    }

    r.closed = true
    return nil
}
```

---
