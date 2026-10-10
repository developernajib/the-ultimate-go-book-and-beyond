## Testing Strategy Landscape

Three advanced strategies fill the gaps that example-based tests leave: property-based testing, fuzz testing, and chaos engineering. They explore the vast space of inputs a developer would never write out by hand, and they inject the real-world failures that production systems encounter. Each strategy targets a different class of defect: property-based tests find logic errors by generating random valid inputs, fuzz tests find crashes and panics by generating malformed inputs, and chaos engineering finds resilience gaps by injecting infrastructure failures. Knowing which strategy to apply to which type of defect, and how they compose with the existing test pyramid, is the foundation of this chapter.

```
                    Confidence Level
    Low ──────────────────────────────── High
     │                                    │
     │  Unit Tests     (you test what     │
     │  [Example]       you think of)     │
     │                                    │
     │  Property Tests  (computer tests   │
     │  [∀x: f(x)=g(x)] many cases)      │
     │                                    │
     │  Fuzz Tests      (computer finds   │
     │  [corpus→mutate] edge cases)       │
     │                                    │
     │  Chaos Tests     (test unknown     │
     │  [kill,delay]     unknowns)        │
     │                                    │

Property testing: for ALL inputs satisfying constraints,
property P holds. Instead of handcrafting examples, you
state the invariant and let the framework find counterexamples.

Fuzz testing: mutate a seed corpus to find inputs that
crash, hang, or violate invariants.

Chaos engineering: inject failures (latency, errors, crashes)
into a running system and verify it degrades gracefully.
```

### Which technique catches which bug class

Each technique in this chapter catches a specific class of defect. **Property tests** catch logic bugs that hold for typical inputs but fail at algorithmic edges: integer overflow in an aggregation, off-by-one in a sort, violation of associativity in an operation you assumed was associative. **Fuzz tests** catch parser and decoder bugs: malformed input that triggers a panic, unbounded allocation, or infinite loop. Most security-relevant input-handling bugs are in this bucket. **Chaos tests** catch failure-mode bugs: incorrect error handling, timeout propagation failures, resource leak under partial failure, cascading failure across services. **Mutation tests** catch *missing* tests: the cases where your test suite claims coverage but a mutation would have slipped through. Each class of bug is invisible to the other three techniques, so they are additive, not substitutes. A mature testing strategy uses all four, weighted by which bug classes matter most for each service.

### Junior → FAANG: map each production bug to a technique

For every production incident in the last quarter, identify which technique in this chapter should have caught it. A JSON parser that crashed on specific UTF-8 byte sequences? Fuzz test. A rate limiter that allowed bursts above the configured threshold? Property test. A service that cascaded into failure when Redis was slow? Chaos test. A regression where a code branch claimed coverage but the new behavior slipped through? Mutation test. This mapping exercise builds the instinct for when to apply which technique, and it builds a concrete story you can tell in an interview when asked "how do you catch bugs that deterministic tests miss?"

### Senior @ FAANG: the investment portfolio

At staff level, these techniques compete for the same engineering time and CI budget. The allocation question is which bug classes matter most for your services. Services that parse untrusted input (API gateways, serializers, decoders) should prioritize fuzzing heavily. Services that implement algorithms with correctness guarantees (rate limiters, consensus, distributed locks) should prioritize property tests. Services that participate in multi-service workflows should prioritize chaos tests. Services with mature test suites whose quality has plateaued should prioritize mutation testing to find the gaps. The signal for reallocation is the same as in the previous chapter: post-incident analysis tells you which bugs are escaping and which technique would have caught them. Staff engineers who run this analysis quarterly invest their testing budget where it moves the incident rate. Those who skip it end up adopting whichever technique is fashionable that year, then wondering why the incident rate does not move.

---
