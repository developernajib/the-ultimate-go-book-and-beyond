## Exercises

1. **Property-Test a Data Structure**: Implement a persistent/immutable sorted set. Write property tests for: membership after insert, no duplicates, sorted iteration order, union/intersection laws (idempotent, commutative, associative).

2. **Fuzz a Binary Protocol Parser**: Write a `FuzzDecode` test for the `MessageCodec` from Section 2.2. Run it for 5 minutes (`-fuzztime=5m`). Report how many unique crashes were found and what properties they violated.

3. **Chaos Circuit Breaker**: Implement a circuit breaker (closed/open/half-open states). Write a chaos experiment that: (a) starts with 100% success rate, (b) injects 100% failure for 10 seconds, (c) verifies circuit opens within 5 failures, (d) verifies circuit half-opens after 30 seconds, (e) verifies circuit closes after 3 successful probes.

4. **Mutation Score Improvement**: Use `gremlins unleash` to find a function scoring under 60 percent. Without looking at which mutants lived, add tests until the score reaches 90 percent. Then compare your tests against the mutants they actually killed. Expect at least one survivor you cannot kill, and work out whether it is an equivalent mutant before you spend an afternoon on it.

5. **Model-Based Test for Key-Value Store**: Implement an LRU cache, then write a model-based property test with `rapid.T.Repeat`. Note that the model has to track recency: a bare `map[string]string` can verify (a) but is incapable of expressing (b) or (c), so model the cache as a map plus a slice holding key order. Verify that (a) Get returns the last Set value for a live key, (b) once capacity is reached the least-recently-used key is the one evicted, and (c) a Get makes its key most-recently-used. Put the map-versus-cache comparison in the `""` invariant action so it runs after every operation.

### Junior → FAANG: ramped exercises

6. **Write your first property test**: Follow the junior-track onramp answer in the interview section. Pick one function, write the property, watch it shrink. Commit the test.

7. **Run a fuzz target for five minutes**: Pick a parser or decoder in your code. Write a fuzz target. Run with `-fuzztime=5m`. Document every crasher found, fix each one, and add the failing input to `testdata/fuzz/`.

8. **Build the fault-injection middleware**: Implement the middleware from section 3.1 against an HTTP service you control. Toggle it via an environment variable. Run load locally and observe the failure modes.

9. **Wrap a flaky test in `synctest.Test`**: Find a time-based test in your codebase that flakes. Wrap it in `synctest.Test`. Confirm determinism and speed improvement. Merge.

### Senior @ FAANG: staff-level exercises

10. **Write the invariant catalog for one service**: List every invariant your service promises to maintain. Review with your team. Propose property tests for each entry.

11. **Run one local GameDay**: Pick a scenario ("Redis goes down for 30 seconds"), inject it in a local environment with chaos middleware, document what broke, what did not, and what the lessons are. Share the debrief with your team.

12. **Propose an OSS-Fuzz onboarding for a public library**: If your org maintains any public Go library, write the proposal for OSS-Fuzz onboarding: scope, target selection, maintenance ownership, response SLA.

13. **Mentor a junior through exercise 6**: Sit with a junior while they write their first property test. Ask "what would break this?" at each step. The coaching is the staff-level artifact.

---
