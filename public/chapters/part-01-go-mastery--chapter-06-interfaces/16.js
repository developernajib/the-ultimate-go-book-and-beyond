export default `## Exercises

1. **Custom io.Reader Implementation**: Implement a \`RangeReader\` type that satisfies \`io.Reader\` and streams a sequence of integers within a given range as newline-separated ASCII text (e.g., \`NewRangeReader(1, 5)\` produces \`"1\\n2\\n3\\n4\\n5\\n"\`). The \`Read\` method must handle the case where the supplied buffer is smaller than a single formatted number. Verify correctness by reading the output through \`bufio.Scanner\` and \`io.ReadAll\`, and confirm via a compile-time interface guard (\`var _ io.Reader = (*RangeReader)(nil)\`).

2. **Interface Composition**: Define three small single-method interfaces - \`Opener\`, \`Closer\`, and \`Seeker\` - then compose them into a \`ReadWriteSeekCloser\` interface by embedding. Build a concrete \`InMemoryFile\` struct that satisfies all three composed interfaces. Write a function \`CopyAndSeekBack(f ReadWriteSeekCloser, data []byte) error\` that accepts the composed interface, writes data, seeks back to the start, then reads and returns the content, demonstrating how composition lets a single value satisfy multiple narrower contracts simultaneously.

3. **Type Assertions and Type Switches**: Write a function \`Describe(v any) string\` that uses a type switch to handle \`int\`, \`float64\`, \`string\`, \`bool\`, \`[]byte\`, \`error\`, \`fmt.Stringer\`, and a default case, returning a human-readable description for each (e.g., \`"integer: 42"\`, \`"stringer: <result of String()>"\`). Then write a separate function \`SafeAssert(v any, target any) (any, bool)\` that performs a comma-ok type assertion and returns the asserted value and whether it succeeded, without ever panicking. Cover both functions with table-driven tests including nil inputs and interface values holding nil pointers.

4. **Mocking with Interfaces for Testing**: Refactor a \`NotificationService\` that sends emails via an \`EmailClient\` struct into a version that depends on a \`Mailer\` interface with a single \`Send(to, subject, body string) error\` method. Create a \`MockMailer\` that records all calls and can be configured to return a specific error on demand. Write unit tests for \`NotificationService.NotifyUser\` and \`NotificationService.BroadcastAll\` using the mock, verifying call count, arguments passed, and correct error propagation, without making any real network calls.

5. **Plugin System with Interfaces**: Design a simple plugin system where each plugin satisfies a \`Plugin\` interface with \`Name() string\`, \`Version() string\`, and \`Execute(ctx context.Context, input map[string]any) (map[string]any, error)\` methods. Implement a \`PluginRegistry\` that registers plugins by name, prevents duplicate registration, and dispatches execution by name with a context deadline. Write two concrete plugins, a \`UpperCasePlugin\` and a \`WordCountPlugin\` - and test the registry's dispatch, error handling for unknown plugin names, and context cancellation propagation.

6. **Implementing Stringer and Error Interfaces**: Create a custom \`ValidationError\` type that holds a field name, the invalid value, and a human-readable reason. Implement the \`error\` interface so that \`err.Error()\` returns a well-formatted message, and implement \`fmt.Stringer\` so that \`fmt.Sprintf("%v", err)\` produces a distinct, more verbose representation. Then build a \`MultiError\` type that aggregates multiple \`ValidationError\` values, implements \`error\` by joining all messages, and implements \`fmt.Stringer\` with a numbered list format. Write tests verifying that \`errors.As\` correctly unwraps individual errors from a \`MultiError\` and that both interfaces produce the expected output strings.

In the next chapter, the discussion covers Go internals, including how the compiler, runtime, and garbage collector work.

### Senior at FAANG Track

7. **Team interface-design guide.** Write your team's interface-design guide. Cover the rules (accept interfaces, return structs, define interfaces on the consumer side, keep interfaces small, compose with embedding). Send to the team for review. Publish as the reference.

8. **Interface inventory.** For one of your team's services, list every public interface. For each, identify the consumer, the implementer, and whether the interface has more than one implementation. Flag interfaces with one implementation for removal.

9. **Refactor a large interface.** Pick an interface with more than eight methods. Split into focused interfaces. Measure LoC for test doubles before and after. Write a retro on the exercise for the team.

10. **Architecture review case study.** Take the interface-driven application from Section 5.9. Present it as a 60-minute architecture walkthrough at a team offsite. Use the discussion to surface the team's open questions about interface design. Publish the Q&A.

### Staff / Principal Track

11. **Build the interface directory.** For a shared-platform repo in your org, compile a directory page listing every exported interface, its owning team, its implementers, and its last review date. Present to the platform council. Get the directory wired into a quarterly review cadence. The exercise is not the page. It is the process it enables.

12. **Author a deprecation.** Pick an interface in your org that has been deprecated in spirit but never formally. Write the deprecation plan: timeline, migration tooling, named owner per affected team, escalation path, and removal date. Ship the plan to the owning team. Track completion.

13. **Design-review rubric.** Draft a one-page rubric the senior pool applies to any PR introducing or changing a public interface in a shared package. Pilot it with one team for a quarter. Measure time-to-approve for interface PRs before and after. Refine based on what the rubric caught and what it missed.

14. **Interface-to-RPC migration case study.** Identify an in-process interface in your system whose usage has grown past what polymorphism can carry (multiple implementations in different binaries, operational coupling across teams, different SLAs per caller). Design the move to an RPC boundary. Cover: the new protobuf contract, the failure semantics the interface did not have to express, the phased migration that preserves the interface during the transition, and the final removal. Write it up as a case study for the staff-track reading list.

15. **Interface vs generics performance paper.** For one latency-critical service, profile the cost of interface dispatch in the hot path. Produce a short paper (two to four pages) documenting the benchmark, the tradeoffs, and the recommendation (keep interface, convert to generic, convert to concrete, enable PGO). Circulate to the performance working group. The output is the documented decision, not the micro-optimisation.
`;
