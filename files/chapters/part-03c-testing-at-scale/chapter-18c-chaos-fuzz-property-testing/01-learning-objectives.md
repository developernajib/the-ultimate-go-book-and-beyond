## Learning Objectives

By the end of this chapter, you will be able to:
- Implement property-based tests using `pgregory.net/rapid` and Go's native `testing/quick`
- Write fuzz tests with Go's native fuzzer (`testing.F`, stable since 1.18, refined through 1.27)
- Design chaos engineering experiments for Go services, using Toxiproxy and `pingcap/failpoint` where appropriate
- Build fault injection middleware for resilience testing
- Apply mutation testing with `gremlins` to measure test suite quality
- Use `testing/synctest` (stable in Go 1.25) to remove flakiness from time-based tests
- Integrate all advanced testing techniques into a CI pipeline with appropriate time budgets

**Junior → FAANG track.** You should finish the chapter able to write one property test against a function you have written and watch `rapid` shrink a failing input to its minimal case, run `go test -fuzz` against a parser you control and interpret the discovered crashers, explain in one sentence why Toxiproxy is valuable for integration tests, and articulate why mutation testing can detect gaps that line coverage hides.

**Senior @ FAANG track.** Beyond the mechanics, you should be able to write the invariant catalog for a service (the properties it promises to maintain for every input), facilitate a GameDay exercise with blast-radius controls and a written rollback plan, defend or reject a proposed chaos experiment in design review, and mentor a junior engineer through their first property-test shrinking session without taking the keyboard. Those are the staff-level artifacts the advanced-testing knowledge in this chapter ultimately feeds into.

---
