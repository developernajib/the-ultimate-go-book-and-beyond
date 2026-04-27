export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Choose the Right Numeric Type**: Select appropriate integer and floating-point types for performance and correctness
2. **Master String Operations**: Handle UTF-8 encoding, optimize string manipulation, and avoid common pitfalls
3. **Work Efficiently with Slices**: Understand slice internals, avoid memory leaks, and write performant code
4. **Design Effective Data Structures**: Use maps, structs, and custom types to model your domain
5. **Optimize Memory Layout**: Understand struct padding and alignment for memory-efficient data structures
6. **Apply Production Patterns**: Use the same type patterns used at Google, Uber, Stripe, and Netflix

### Detailed Outcomes

**Junior to FAANG-entry track**

- Name the zero value of every built-in type (int, float64, string, bool, slice, map, channel, pointer, interface) without reference.
- Predict the output of a slice-aliasing snippet and explain why the behaviour is what it is, the way a phone-screen interviewer expects.
- Diagnose a "nil map assignment" panic on sight and name the fix.
- Write a struct with the right field ordering to avoid wasted padding, when asked to minimise memory footprint.
- Choose between \`int\` and \`int64\` correctly based on the portability constraints of the target system.
- Recognise the five most common type-related interview questions (string bytes vs runes, slice aliasing, map iteration order, typed-nil interface, value vs pointer receivers) and answer each in under two minutes.

**Mid-level engineer coming to Go from another language**

- Translate the patterns your previous language uses for domain modelling (wrapper classes in Java, newtype in TypeScript, newtypes in Rust, NewType in Python's typing module) into Go's named-type pattern.
- Identify when a primitive should be promoted to a named type (when it carries domain meaning) and when it should stay primitive (when it is genuinely a raw number or string).
- Read a Go struct and predict its memory footprint within a few bytes, accounting for alignment and padding.
- Use struct tags (\`json:"..."\`, \`db:"..."\`, \`validate:"..."\`) correctly and spot tag typos that the compiler will not catch.
- Apply the \`accept interfaces, return structs\` convention in the function signatures you write.

**Senior at FAANG track**

- Diagnose a pprof flame graph dominated by \`runtime.growslice\`, \`runtime.mapassign_fast64\`, or \`runtime.mallocgc\` and propose a type-design change that reduces or eliminates the hot symbol.
- Impose a team-wide discipline of named types for every domain identifier and defend the choice in a code review where an engineer argues "but it is just an int".
- Identify the three or four type-level decisions (struct field ordering for cache lines, slice of pointers vs slice of values, map preallocation hints, struct embedding vs named field) that move hot-path performance measurably.
- Specify the team's struct-tag conventions and the lint rule that enforces them in CI.
- Identify when reflection is the right tool (encoding/decoding to unknown schemas, framework-style libraries) and when it is the wrong tool (almost everywhere else), and push back on reflection-heavy code in review.
- Map the Go type system's omissions (no union types with payloads, no algebraic data types, no type classes, limited generics) to the patterns Go uses instead (interfaces, typed errors, small closed-world enums via iota), and defend the trade-offs to engineers arriving from Rust, Haskell, or OCaml.

---
`;
