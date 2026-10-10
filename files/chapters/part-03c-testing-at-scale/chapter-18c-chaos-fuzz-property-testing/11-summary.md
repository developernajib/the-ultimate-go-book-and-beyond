## Summary

Four advanced testing techniques that find bugs traditional unit tests miss:

- **Property-based testing**: State invariants rather than examples. `testing/quick` is built-in but does not shrink and is frozen, which limits it to simple checks. `pgregory.net/rapid` is the modern pick, with automatic minimization and first-class state machine testing. In `rapid.T.Repeat`, the empty-string key is the invariant check that runs after every action, not just another action. Key properties to test: round-trips (encode/decode), idempotency (sort twice = sort once), symmetry (a+b = b+a), invariant maintenance (counter never exceeds max).

- **Fuzz testing**: Go's native coverage-guided fuzzer, stable since 1.18 and refined through 1.27, mutates a seed corpus to find crashes and property violations. Commit `testdata/fuzz/*/` so crashes become permanent regression tests. Run 30s per target in PR CI, 5-15 minutes nightly, hours before release, and register public packages with OSS-Fuzz for continuous fuzzing on Google infrastructure.

- **Chaos engineering**: Define a steady-state hypothesis, inject turbulence (latency, errors, partitions, crashes), observe system behavior, verify recovery. The experiment framework: pre-check, inject, observe, post-check, report. Use Toxiproxy for TCP-level fault shaping, `github.com/pingcap/failpoint` for faults deep inside the binary, and `testing/synctest` (Go 1.25) to make time-dependent chaos tests deterministic. Circuit breakers, bulkheads, and timeouts are validated by chaos tests, not unit tests.

- **Mutation testing**: `gremlins` is the maintained tool in 2026 (with `avito-tech/go-mutesting` as the still-alive fork of the older option). It introduces deliberate bugs (flip `>` to `>=`, swap returns) and measures what fraction your tests catch. A score below 70 percent usually means your tests verify that the code runs rather than that it is correct. Expect a ceiling below 100 percent regardless: an equivalent mutant such as `>` becoming `>=` where both branches return the same value describes the same function, so no test can ever kill it. Use diff-scoped mode in CI to keep the job fast on large repos, and treat the score as a trend, not a gate.

Together: unit tests verify correctness, property tests verify invariants, fuzz tests find edge cases, chaos tests verify resilience, mutation tests measure test quality. A production Go service at FAANG scale uses all five, with defined time budgets per gate.

### For the junior engineer on the FAANG track

Leave this chapter with four habits. First, reach for a property test whenever a function has a natural invariant (round-trip, idempotent, commutative). Second, run `go test -fuzz` against any parser or decoder you write, even for five minutes. Third, wrap time-dependent tests in `synctest.Test` so flakes stop hiding real bugs. Fourth, treat mutation score as a learning signal about your own testing habits, not as a grade. These four habits produce tests that catch real bugs and engineers who write tests that stand up to adversarial scrutiny. Interviewers at FAANG infrastructure and security teams probe for exactly this depth: "have you ever used property tests or fuzzing to catch a bug?" Candidates who have a real story win. Candidates who have only read about it lose.

### For the senior engineer at FAANG

Leave this chapter with three artifacts per service or team. First, an invariant catalog, the properties each service promises to maintain, documented and tested with property tests. Second, a chaos-engineering charter defining scope, blast-radius policies, GameDay cadence, and escalation paths. Third, a CI time budget allocation that keeps PR feedback fast while running fuzz and mutation jobs on the right schedule. The techniques in this chapter are ingredients. The artifacts and policies are what let advanced testing scale across teams and stay effective over years. Staff-level work in testing is measured by the durability of the practices you leave behind. Write the catalog. Mentor the juniors. Run the GameDays. The tooling will evolve. The discipline outlives any specific tool.

