## Learning Objectives

By the end of this chapter, you will be able to:

1. **Use Go's testing toolchain** - Work with the testing, benchmark, and fuzzing facilities built into the standard library
2. **Write table-driven tests** - Apply the idiomatic Go pattern for high test coverage with minimal duplication
3. **Design testable code** - Structure applications for easy testing through dependency injection and interfaces
4. **Build practical mocks** - Create mock implementations that verify behavior without external dependencies
5. **Test concurrent code** - Apply techniques for testing goroutines, channels, and race conditions
6. **Implement integration testing** - Use testcontainers and build tags for end-to-end testing
7. **Write performance benchmarks** - Create benchmarks that accurately measure and compare implementations
8. **Apply property-based testing** - Use Go 1.18+ fuzzing to discover edge cases automatically
9. **Achieve meaningful coverage** - Set up coverage analysis and meaningful coverage thresholds
10. **Build a complete test framework** - Implement reusable testing utilities for your organization

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        THE TESTING PYRAMID                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                              ┌─────────┐                                        │
│                             ╱           ╲                                       │
│                            ╱   E2E/UI    ╲  <-- Slow, brittle, expensive        │
│                           ╱    Tests      ╲     (Selenium, Playwright)          │
│                          ╱─────────────────╲                                    │
│                         ╱                   ╲                                   │
│                        ╱   Integration       ╲  <-- Database, APIs, services    │
│                       ╱      Tests            ╲     (testcontainers, httptest)  │
│                      ╱─────────────────────────╲                                │
│                     ╱                           ╲                               │
│                    ╱       Unit Tests            ╲  <-- Fast, isolated          │
│                   ╱       (Table-Driven)          ╲     (mocks, interfaces)     │
│                  ╱─────────────────────────────────╲                            │
│                 ╱                                   ╲                           │
│                ╱         Static Analysis            ╲  <-- go vet, staticcheck  │
│               ╱─────────────────────────────────────────╲                       │
│                                                                                 │
│  IDEAL DISTRIBUTION:                                                            │
│  ├── Static Analysis: Automatic (go vet, staticcheck in CI)                     │
│  ├── Unit Tests: 70% (fast, run on every commit)                                │
│  ├── Integration Tests: 20% (medium speed, run on PR)                           │
│  └── E2E Tests: 10% (slow, run nightly/release)                                 │
│                                                                                 │
│  TIME TO RUN (typical Go project):                                              │
│  ├── Unit Tests: ~5 seconds                                                     │
│  ├── Integration Tests: ~2 minutes                                              │
│  └── E2E Tests: ~15 minutes                                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Outcomes

**Mid-level engineer**

- Write table-driven tests as the default pattern for any function with multiple input cases.
- Use `go test -race` locally and understand the output.
- Mock external dependencies via interfaces, avoiding framework-heavy mocks where hand-rolled is simpler.
- Achieve meaningful coverage (not just line coverage) on business logic.

**Senior engineer**

- Review tests for quality: are they testing behavior or implementation? Are error paths covered? Is the test resilient to refactoring?
- Enforce test-suite discipline: `-race` always, `goleak` for concurrent code, deterministic tests.
- Design testable code: narrow interfaces at boundaries, explicit dependencies, fake time sources.

**Staff or Principal**

- Treat the test suite as infrastructure: measure flake rate, wall-clock time, and coverage drift, and invest when they trend wrong.
- Drive adoption of modern testing tooling (`testing/synctest`, fuzzing, `testcontainers-go`) across the service portfolio.
- Set coverage expectations that match the service's risk profile (payment processing vs read-only cache): not uniform across the org.
- Own the test-infrastructure story: CI pipelines, parallelization, flake quarantine, trend dashboards.

---
