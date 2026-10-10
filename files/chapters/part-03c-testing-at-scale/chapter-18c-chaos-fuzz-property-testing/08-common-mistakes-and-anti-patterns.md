## Common Mistakes and Anti-Patterns

| Mistake | Problem | Fix |
|---------|---------|-----|
| Property that's always true | Tests nothing | Include falsifiable boundary conditions |
| Fuzz test without invariants | Tests only "no panic" and misses logic bugs | Add property checks inside fuzz function |
| Chaos test without steady-state definition | Can't measure degradation | Define measurable steady-state (RPS, p99, error rate) |
| Running chaos on production | Accidental data loss or outages | Use chaos only in staging with blast radius limits |
| Mutation test with >80% survived | Tests don't verify behavior | Add boundary value tests for each function |
| Not saving fuzz crash inputs | Bug resurfaces after corpus reset | Commit `testdata/fuzz/*/` to version control |
| Property test with too narrow generators | Misses edge cases | Test with full range including min/max int, empty strings, nil |
| Chaos without rollback | Experiment leaves system broken | Always implement Turbulence.Cleanup |
| Long-running fuzz in unit test suite | CI takes hours | Separate fuzz with `-fuzztime` flag and dedicated job |
| Real `time.Sleep` in resilience tests | Flaky on slow runners, slow CI | Wrap in `testing/synctest.Test` (Go 1.25 stable) for virtual time |
| Using `testing/quick` for large structured inputs | No shrinking, unreadable failures | Use `pgregory.net/rapid` for automatic minimization |
| Mutation testing across the whole repo on every PR | CI minutes balloon | Run `gremlins unleash --diff origin/main` in PR jobs, full run nightly |
| Fuzz target with only "did not panic" check | Silent corruption passes | Add a semantic invariant (round-trip, oracle comparison) inside the target |
| Chaos middleware left enabled in prod build | Live traffic gets injected faults | Gate with a build tag or runtime env check that defaults off |
| Property that depends on random state (non-determinism) | Test fails on some seeds, passes on others | Seed the generator deterministically, treat failures as real bugs |
| Fuzz corpus not committed to git | Regression bugs resurface, every new run starts from zero knowledge | Commit `testdata/fuzz/<Target>/` to the repo |
| Chaos experiment with no observation window | Failure mode occurs but test ends before detection | Extend observation for at least 2-3x the configured timeout |
| Mutation score set as hard PR gate | Teams game the metric with meaningless tests | Use as quarterly trend metric, not per-PR gate |
| One engineer writes all property tests for a team | Bus factor of 1, suite dies when they leave | Require property tests in code review, spread ownership |
| Fuzz harness that can itself panic on hostile input | The fuzzer "finds" a crash in your test, not your code, and you debug the wrong thing for a morning | Build inputs with APIs that return errors. Never `httptest.NewRequest` on a fuzzed target: it panics. Skip inputs the harness cannot represent |
| Chasing a mutant that no test could ever kill | Hours spent on an equivalent mutant, then the team concludes mutation testing is noise | Learn the shape: if two branches return the same value, `>` and `>=` are the same function. Accept it and move on |
| `switch n % 3` on a generator that emits negatives | Go's `%` keeps the dividend's sign, so `-1 % 3` is `-1`, matches no case, and a third of generated inputs silently do nothing | Normalize with `((n % 3) + 3) % 3`, or draw from a constrained generator like `rapid.IntRange` |

### Junior → FAANG: the "what would break this test?" reflex

For every property test, fuzz target, or chaos experiment you write, ask and answer: what specific bug is this test designed to catch? If you cannot name the bug, the test is decoration. A property test that asserts `x == x` catches nothing. A fuzz target that only checks "no panic" misses silent corruption. A chaos experiment without a hypothesis cannot fail usefully. Running this self-check on every test you write builds the reflex that separates good testers from great ones.

### Senior @ FAANG: the hidden cost of flaky advanced tests

Advanced tests (property, fuzz, chaos, mutation) have a failure mode that unit tests rarely do: they can be both correct and flaky. A property test with a rare failing seed, a fuzz target that occasionally times out, a chaos experiment whose observation window catches a rare legitimate spike. The temptation is to retry-on-failure or raise thresholds until the test passes reliably. This turns a real signal into noise. The staff-level discipline: when an advanced test flakes, investigate. Often the flakiness reveals a real bug that manifests only under rare conditions, exactly the bugs the advanced test was designed to find. Retrying hides the signal. Fixing the underlying issue (whether in the code or in the test calibration) keeps the suite honest. Teams that investigate every flake produce tests that catch real bugs. Teams that retry into silence produce a suite that looks green while the underlying system decays.

---
