## Interview Questions and Answers

**Q: What is property-based testing and how does it differ from example-based testing?**

A: Example-based testing means you provide specific inputs and expected outputs, such as asserting that `Max(1, 2)` is `2`. You only test what you think of. Property-based testing: you state a universal invariant, `forall a,b: max(a,b) >= a && max(a,b) >= b && (max(a,b)==a || max(a,b)==b)`, and a framework generates hundreds of random inputs to find a counterexample. Properties are stronger because they define behavior for all inputs, and the framework finds the counterexample you would not have written. On failure, a good library (like `pgregory.net/rapid`) shrinks the counterexample to its minimal form before reporting it.

What FAANG expects: you can classify a candidate function into property categories (round-trip, invariant, oracle comparison, idempotence, commutativity, metamorphic) and write the corresponding property on a whiteboard. You also know the library you would reach for in Go and why you would not pick `testing/quick` for anything non-trivial (no shrinking).

Follow-ups:
- "What is a metamorphic property and when would you use one instead of an oracle?" (Answer: metamorphic relations state that if `f(x)` has some result, then `f(transform(x))` has a related result, for example `sort(reverse(s)) == sort(s)`. Useful when you have no simple oracle to compare against, common in ML systems and optimizing compilers.)
- "Your property test passes 10,000 iterations but production still has a bug. What went wrong?" (Answer: generator bias. The default generator likely does not sample the problematic region. Inspect generator distribution, add targeted generators, or widen ranges.)
- "How do you write a property test for code that has side effects?" (Answer: state machine testing with `rapid.T.Repeat`, operate against both SUT and a pure model, compare observable state after each action.)

**Q: What is the difference between fuzzing and property-based testing?**

A: Property-based testing generates structured random inputs using typed generators and verifies a logical property. Fuzzing starts from a seed corpus and applies byte-level mutations (flip bits, insert/delete bytes, splice inputs) guided by code coverage feedback to find inputs that trigger panics, crashes, or property violations. Fuzzing excels at finding parser bugs, buffer overflows, and unexpected code paths. Property testing excels at verifying semantic invariants over typed domains. They compose: use property testing for algorithmic invariants, fuzzing for parsing and serialization code, and add semantic invariants inside fuzz targets so you catch logic bugs, not just crashes.

What FAANG expects: you know Go's fuzzer is coverage-guided (`libFuzzer`-style), that seeds live in `testdata/fuzz/<FuzzName>/`, that the generated corpus is kept under `$GOCACHE/fuzz/` and is machine-local, and that `f.Add` argument types must match the `f.Fuzz` signature exactly. You also know to never write a fuzz target that only checks "did not panic".

Follow-ups:
- "How do you integrate Go fuzzing with OSS-Fuzz?" (Answer: native support, commit fuzz targets with `Fuzz` prefix, register project with OSS-Fuzz, it continuously fuzzes and emails crashes.)
- "Your fuzzer finds a crash at 2am. What is your triage workflow?" (Answer: the failing input is written to `testdata/fuzz/<FuzzName>/<hash>`, commit it as a regression test, run `go test -run=FuzzName/<hash>` to reproduce locally, then fix.)
- "How do you fuzz a gRPC handler?" (Answer: fuzz the proto bytes, unmarshal inside the target, pass through the handler, assert no panic and that any marshaled response round-trips.)

**Q: Explain the steady-state hypothesis in chaos engineering.**

A: The steady-state hypothesis defines what normal operation looks like as a measurable metric: "99% of requests return 200 within 200ms" or "error rate < 0.1%". Before injecting turbulence you verify the system is in steady state. During turbulence you observe whether the system maintains or gracefully degrades from steady state. After recovery you verify steady state returns. Without a defined steady state, chaos experiments are theater. You are breaking things without measuring impact, and any claim about resilience is unfalsifiable.

What FAANG expects: you can articulate a complete experiment spec (hypothesis, method, blast radius, abort condition, rollback, observability), you know chaos is run in production at Netflix and Amazon but always with a scoped blast radius, and you can name the four canonical failures (latency, error, resource exhaustion, partition) and give concrete injection techniques for each.

Follow-ups:
- "Where does the chaos experiment abort automatically?" (Answer: auto-abort when steady state breaches a safety threshold, when error budget burn rate exceeds N x nominal, or when pager alerts fire for real customers.)
- "Compare Toxiproxy and your own middleware-based fault injection." (Answer: Toxiproxy shapes real TCP at the kernel level and is language-agnostic. Middleware is faster to iterate on but only injects where the middleware runs, so it cannot reproduce socket-level issues like RST floods or half-open connections.)
- "How would you run a GameDay for a payments service without risking real money?" (Answer: dark traffic replay, shadow environment with synthetic transactions, feature flag to route only internal test accounts through the chaos scenario.)

**Q: How do you prevent mutation testing from becoming a burden?**

A: (1) Target it at business-critical logic only, not boilerplate or generated code. (2) Use diff-scoped mode (`gremlins unleash --diff origin/main`) so CI only mutates code that changed in the PR. (3) Start advisory in CI (do not fail PRs) until the score stabilizes, then enforce. (4) Accept 70-80% efficacy as sufficient. 100% is unreachable due to equivalent mutants. (5) Configure the mutant set. Disable mutation categories that produce mostly noise in your codebase (for example, arithmetic mutations in pure-routing code).

What FAANG expects: you know gremlins is the maintained option in 2026, you do not treat mutation score as a vanity metric, and you can explain what an equivalent mutant is and why it caps the achievable score below 100%.

Follow-ups:
- "Give an example of an equivalent mutant." (Answer: changing `i < len(s)` to `i != len(s)` inside a `for i:=0;` loop that only increments. Both terminate identically, no test can distinguish.)
- "A mutant lives. How do you decide whether to kill it with a new test or ignore it?" (Answer: trace the mutated line, if it affects observable behavior write the test, if it is semantically equivalent or dead code mark it as expected-live via config.)
- "How would you use mutation testing to find redundant tests?" (Answer: group tests, compute per-test mutation contribution, tests that kill zero unique mutants are candidates for removal.)

**Q: When should you use `testing/synctest` vs real time in a chaos test?**

A: Use `testing/synctest` (stable in Go 1.25) for any chaos or resilience test whose logic depends on `time.Sleep`, `time.After`, `time.Timer`, or `context.WithTimeout`. Virtual time advances instantly once all goroutines in the bubble are blocked on a timer, so a "60 second reset window" test finishes in microseconds and is deterministic. Use real time only when you are exercising behavior that genuinely depends on wall clock (external HTTP calls, OS scheduling, file-system timing).

What FAANG expects: you know the Go version it shipped in (1.24 experimental, 1.25 stable), you can explain why sleeping in a test is a code smell in 2026, and you know the bubble isolation rule (every goroutine the test cares about must be started inside `synctest.Test`).

Follow-ups:
- "What happens if you start a goroutine outside the bubble and it calls `time.Sleep`?" (Answer: it is not part of the bubble, so it sleeps in real time. Worse, a bubble goroutine waiting on it is not durably blocked, so virtual time stops advancing and `Test` reports a deadlock.)
- "How do you test a retry policy that backs off for 5 minutes?" (Answer: wrap the test in `synctest.Test`, call the retrying function, assert the retry count matches expectation after virtual time advances, total wall time is milliseconds.)
- "When would you still prefer real time?" (Answer: integration tests against real network services where latency is produced by the OS, or when you are explicitly testing that the clock itself is used correctly.)

---

**Q (Junior-track onramp): You have never written a property test. Where do you start?**

A: I would pick the smallest function in my codebase that has a natural invariant. A sort function (idempotent), a reverse function (involution), or a serializer (round-trip). Write a property test using `pgregory.net/rapid` following the template in section 1.1. Run it, watch `rapid` generate 100 random inputs. Deliberately break the function (for example, make sort skip the last element) and watch the property fail. Note the shrunk counterexample. Fix the function, rerun, watch it pass. That exercise teaches more than reading about property testing. I would also ask a senior colleague to review the property itself, because writing a meaningful property is a skill that transfers with feedback.

Follow-ups:
- "What if you cannot find a natural invariant?" (The function may be too complex or too simple for a property test. Try breaking it into smaller pieces, or fall back to table-driven tests.)
- "How do you know your property is meaningful?" (Deliberately break the code in the most plausible wrong way and see whether the property fails. If it passes the break, the property is too weak.)

---

**Q (Staff-track): Your org has no chaos engineering practice. You are the staff engineer asked to introduce it. Write the six-month rollout plan.**

A: Month one: build the fault-injection middleware, run local chaos tests for one service, document the patterns. Month two: run the first GameDay, a single pre-announced scenario in a staging environment, with post-event debrief. Month three: expand to two more services, refine the playbook based on lessons learned. Month four: introduce continuous chaos (weekly low-blast-radius experiments in staging). Month five: propose a production GameDay with executive sign-off, starting with a trivial scenario (kill one pod in a stateless service during business hours with on-call ready). Month six: formalize the chaos-engineering charter, including blast-radius policies, abort criteria, and communication protocols. Success metric: number of real-world incident post-mortems where the root cause maps to a chaos scenario the team had previously rehearsed. If the number grows, the investment is paying back. If not, the scenarios are not targeting real risks, and the plan needs refinement. The key staff-level move is to couple the technical work with organizational buy-in. Without sign-off from SRE, product, and leadership, even a successful exercise can be perceived as reckless, and the practice dies after the first near-miss.

Follow-ups:
- "How do you handle executive pushback on the first production experiment?" (Start with the lowest-risk possible scenario, show measured blast radius, offer a pause button. Demonstrate the safety machinery before asking for risk tolerance.)
- "What if your first GameDay causes a real incident?" (Debrief, publicize the lessons, refine the safety controls. Do not hide the failure. Teams learn more from the post-mortem than from success.)
- "How do you convince a skeptical engineer that chaos is worth their time?" (Run one exercise that exposes a bug in code they own. That single experience is usually sufficient.)

