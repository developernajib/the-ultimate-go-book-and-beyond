export default `## Summary

This chapter covered the essential building blocks of every Go program:

- **Program structure**: \`package main\`, \`import\`, \`func main()\`, and Go's module system
- **Variables and types**: Declaration with \`var\` and \`:=\`, zero values, basic types, constants with \`iota\`, explicit type conversions
- **Functions**: Multiple return values, named returns, variadic functions, closures, and \`defer\`
- **Control flow**: \`if\` with init statements, \`for\` as Go's only loop (covering classic, while, infinite, and range), \`switch\` without fallthrough
- **Structs and methods**: Value vs pointer receivers, struct embedding for composition, the \`New\` constructor pattern
- **Arrays, slices, and maps**: Slices as Go's primary collection, the \`append\`/\`copy\`/\`range\` trio, maps for key-value storage, maps as sets
- **Error handling**: The \`value, err\` pattern, \`errors.New\` and \`fmt.Errorf\`, why Go chose explicit errors over exceptions

These fundamentals appear in every Go program you'll ever read or write. The next chapters build directly on this foundation.

### What you should be able to do now

- Read an unfamiliar twenty-line Go function, identify its package, its receivers, its returns, and its error contract, and explain it aloud the way an interviewer would expect.
- Write a small program (twenty to fifty lines) from a blank \`main.go\` without reference, including module init, imports, struct, methods, error handling, and a working \`main\`.
- Explain why a slice is not the same as its backing array and why \`append\` sometimes aliases the input and sometimes does not.
- Articulate the difference between value and pointer receivers, why mixing them on the same type is a code smell, and which one to default to for a non-trivial type.
- Recognise the shadowed-\`err\` bug, the loop-variable-capture bug (and the 1.22 fix), and the nil-map-write panic, on sight.

### What this chapter intentionally did not teach

Concurrency is in Chapter 7. Generics, the type system in depth, and interface satisfaction are in Chapter 4. Mental-model shifts for engineers from other backgrounds are in Chapter 3. The runtime, scheduler, and garbage collector are in Chapters 13 through 15. The full taxonomy of error-handling patterns (sentinel errors, typed errors, wrapping discipline at scale, structured errors with \`errors.Join\`) is in Chapter 9. If this chapter felt fast, that is by design. The goal here was the syntax surface, not the engineering depth.

### For the FAANG-entry track

Spend the next week typing every example from this chapter from scratch, then close the book and reproduce the contact book. If you can produce it from memory in 15 minutes, you have the syntax fluency that an entry-level Go interview assumes. If you cannot, repeat until you can. The interview signal is fluency under pressure, and pressure is the default state of a 45-minute coding round.

### For the senior-at-FAANG track

The structural lesson of this chapter is the order in which Go syntax should be taught: package, then types, then functions, then methods, then structs, then collections, then errors. That order is not arbitrary. It mirrors the dependency graph of the concepts. Use this structure (or its equivalent in your team's voice) for the Go onboarding doc you wish your last hire had read. The single highest-leverage change a senior Go engineer can make in their first quarter at a new team is to write that doc and put it where the next hire can find it on day one.
`;
