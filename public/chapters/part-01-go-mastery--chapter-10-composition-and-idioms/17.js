export default `## Exercises

These exercises build on each other in complexity. The first three focus on individual patterns. The last three combine multiple patterns into realistic designs. Aim to write tests alongside your implementation.

1. **Functional Options Pattern for a Server Config**: Design an \`HTTPServer\` struct with fields for address, port, read timeout, write timeout, max header bytes, and an optional TLS config. Expose a \`NewHTTPServer(opts ...Option) (*HTTPServer, error)\` constructor where each field is configured via a dedicated \`With*\` option function (e.g., \`WithPort(p int) Option\`). Each option must validate its input and return an error through a sentinel or typed error so the constructor can collect and report all invalid options at once rather than stopping at the first failure. Write tests that verify the zero-value defaults, that invalid options surface the correct errors, and that combining multiple valid options produces the expected configuration.

2. **Middleware Chain Composition**: Implement a minimal HTTP middleware system without using any framework. Define \`Middleware\` as \`func(http.Handler) http.Handler\` and write a \`Chain(middlewares ...Middleware) Middleware\` function that composes them so the first middleware in the slice is the outermost wrapper. Implement three concrete middlewares: \`RequestLogger\` (logs method, path, and duration), \`Recoverer\` (catches panics and returns 500), and \`RateLimiter(rps int)\` (token-bucket limiting per remote IP). Wire them together with \`Chain\` and attach the result to a simple handler. Write integration tests using \`httptest\` that verify log output, that a panic returns 500 without crashing the server, and that requests beyond the rate limit receive 429.

3. **Embedding for Behavioral Extension**: Create a \`BaseRepository[T any]\` generic struct that implements common CRUD operations backed by an in-memory \`map[string]T\`. Define a \`UserRepository\` that embeds \`BaseRepository[User]\` and extends it with a \`FindByEmail(email string) (User, error)\` method without duplicating the base CRUD logic. Then create an \`AuditedRepository[T any]\` that embeds \`BaseRepository[T]\` and overrides \`Create\` and \`Delete\` to write audit log entries before delegating to the embedded method. Demonstrate that embedding promotes methods correctly, that overriding works as expected, and that the type satisfies a \`Repository[T]\` interface. Write tests that verify both the promoted and the overridden behavior, making clear this is composition, not inheritance.

4. **Decorator Pattern**: Define a \`Storage\` interface with \`Get(key string) ([]byte, error)\` and \`Set(key string, value []byte) error\`. Implement a \`MemoryStorage\` as the base. Then build three decorators as separate structs that each wrap a \`Storage\`: \`CachingStorage\` (in-memory LRU cache in front of the wrapped store), \`EncryptingStorage\` (AES-GCM encrypt on \`Set\`, decrypt on \`Get\` using a provided key), and \`MetricsStorage\` (counts calls and measures latency for each operation). Compose all three so the call order is \`MetricsStorage -> CachingStorage -> EncryptingStorage -> MemoryStorage\`. Write tests verifying that each decorator adds only its own behavior, that composition produces the correct layered effect, and that removing one decorator does not break the others.

5. **Builder Pattern**: Implement a \`QueryBuilder\` for constructing SQL SELECT statements in a fluent, safe manner. The builder must support \`.Table(name string)\`, \`.Select(cols ...string)\`, \`.Where(condition string, args ...any)\`, \`.OrderBy(col string, dir string)\`, \`.Limit(n int)\`, and \`.Offset(n int)\` methods, each returning \`*QueryBuilder\` for chaining. A final \`.Build() (string, []any, error)\` method must return the parameterized query string (using \`\$1\`, \`\$2\` placeholders), the bound arguments slice, and a validation error if required fields like the table name are missing. Ensure no raw user input is ever interpolated directly into the query string. Write table-driven tests covering valid chains, missing-table errors, repeated \`Where\` clauses, and the exact expected SQL output.

6. **Idiomatic Go API Design**: Design a small but complete Go package called \`notify\` that sends notifications through pluggable backends (email, SMS, webhook). Apply all effective Go guidelines: define narrow interfaces (\`Sender\` with a single \`Send(ctx context.Context, msg Message) error\` method), use functional options for backend configuration, return concrete types from constructors, accept interfaces as function parameters, make the zero value of \`Message\` valid and useful, export only what is necessary, and document every exported symbol with a godoc comment. Include a \`Dispatcher\` that fans a single message out to multiple \`Sender\` backends concurrently, collects all errors (using the aggregator from Exercise 6 of Chapter 9 as inspiration), and returns a combined error. Write an example function (\`Example_dispatcher\`) that serves as both documentation and a runnable test, and run \`go vet\` plus \`golint\` to verify the package passes all idiomatic checks.

### Senior at FAANG Track

7. **Team style guide authorship.** Write the team's Go style guide based on this chapter. Three to five pages. Include before-and-after examples for each pattern. Publish.

8. **Refactor a service to idiomatic Go.** Pick one service. Identify three non-idiomatic patterns. Refactor each over a quarter. Document what changed and why.

9. **Framework evaluation.** If your team uses an internal Go framework, evaluate whether it is earning its keep. If not, propose the migration off. If yes, document the maintenance cost.

10. **Onboarding walkthrough.** Design the one-hour walkthrough you give new Go engineers on the team. Cover the composition patterns, the team's idioms, and the patterns to avoid. Record it.

### Staff / Principal Track

11. **Write the idiom RFC.** Pick one idiom your team has not adopted (example: "all new services use functional options with the interface variant, not the function variant"). Write the RFC: motivation, alternatives considered, migration plan, grace period, enforcement. Socialise with the senior pool. Drive to decision.

12. **Custom linter authoring.** Ship a \`golangci-lint\` custom linter that catches one team-specific pitfall (example: "no constructor may take a filename string, it must take io.Reader or fs.FS"). Measure false-positive rate. Tune over four weeks. Document.

13. **Cross-service convergence.** Audit five services in your org. For each, identify the non-idiomatic patterns. Write a convergence plan that unifies them without a flag-day migration. Drive the rollout over two quarters. Deliver a retrospective at the end.

14. **Idiom deprecation campaign.** Pick one idiom that was correct in older Go but is obsolete in Go 1.26 (example: hand-rolled clock interfaces replaced by \`testing/synctest\`, or \`interface{}\` replaced by generics). Author the deprecation: the replacement pattern, the migration tooling, the hard removal date. Drive the campaign.

15. **Pattern-library audit.** For a mature Go org, inventory every shared pattern library. For each: the owning team, the last release, the number of consuming services, the maintenance cost. Produce a one-page summary. Recommend retention, consolidation, or retirement for each. This is unglamorous but high-impact principal work.

16. **Onboarding doc for the senior pool.** Write the two-page doc that a new staff engineer joining your org reads on day one to understand the team's Go idioms and the reasoning behind them. Include the history of the decisions that shaped the current state. The doc is the asset that lets the senior pool self-maintain the idiom discipline as turnover happens.

17. **Idiom vs anti-idiom showdown.** Pick a controversial idiom choice (example: interface variants of functional options, module boundaries, use of \`pkg/\`). Write a decision doc presenting the competing positions, the context in which each wins, and the team's recommendation with caveats. The output is not "pick one". The output is "here is how to decide".
`;
