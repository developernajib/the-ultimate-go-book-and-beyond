export default `## Learning Objectives

After completing this chapter, you will be able to:

**Foundational (every reader)**

- Explain how Go organises code into packages, why \`main\` is the only package that produces an executable, and how imports resolve through Go modules.
- Declare variables four ways (\`var\`, short declaration \`:=\`, typed assignment, grouped \`var (...)\`) and pick the idiomatic one for each context.
- List Go's built-in numeric, string, and boolean types and recite the zero value of each from memory.
- Write a function with multiple return values, name the returns when it improves clarity, and recognise when named returns become a footgun.
- Use \`if\`, \`for\`, and \`switch\` correctly, including \`if\` with a short statement, the three forms of \`for\`, and \`switch\` with no condition as a cleaner alternative to \`if/else if\` chains.
- Define a struct, attach methods to it with both value and pointer receivers, and explain when each receiver type is correct.
- Distinguish between arrays, slices, and maps, and predict what \`len\`, \`cap\`, and \`append\` will do in common cases.
- Return and inspect errors using the \`error\` interface, sentinel errors, \`errors.Is\`, \`errors.As\`, and \`%w\` wrapping.
- Compile and run a complete multi-file Go program with \`go run\`, \`go build\`, and \`go test\`.

**Junior to FAANG-entry track**

- Reproduce a small program (FizzBuzz, word counter, CSV reader, temperature converter) from a blank file in under ten minutes, without reference, the way an entry-level interviewer expects.
- Read and explain a thirty-line snippet of unfamiliar Go code aloud, the way a phone-screen interviewer asks you to "walk me through this".
- Recognise the three or four idioms (slice growth, nil map writes, error shadowing, range-loop variable capture pre-1.22) that reliably show up in entry-level Go take-home assignments and on-site debugging rounds.
- Name the difference between \`var x int = 0\`, \`x := 0\`, and \`var x int\` and explain why the last one is preferred at package scope.
- Predict what happens when you append to a slice past its capacity and articulate the reallocation cost in big-O terms.

**Senior at FAANG track**

- Use this chapter as the skeleton of an internal Go onboarding curriculum for engineers migrating from Python, Java, or TypeScript, including the order in which concepts must be introduced to avoid the standard mental-model traps.
- Identify the receiver-type consistency rule (do not mix value and pointer receivers on the same type) as a recurring code-review finding and articulate why it matters for interface satisfaction at scale.
- Articulate the operational consequences of choosing pointer receivers on hot-path methods (escape analysis, heap allocations visible in pprof) when reviewing a junior's PR.
- Define the team's error-wrapping discipline (when to use \`%w\` versus \`%v\`, when to define a sentinel error, when to introduce a typed error) and defend it against the "we will just use \`fmt.Errorf\` everywhere" pushback.
- Explain to an engineer arriving from an inheritance-heavy language why Go has no \`extends\` keyword and why composition with embedding is not a workaround but a deliberate design choice with measurable maintenance benefits at the 200-service scale.
- Identify the three or four syntax-surface decisions (loop-variable capture, slice aliasing, map iteration order, nil interface comparison) that have caused production incidents in your org's history and reference the specific section here as the canonical onboarding reference.
`;
