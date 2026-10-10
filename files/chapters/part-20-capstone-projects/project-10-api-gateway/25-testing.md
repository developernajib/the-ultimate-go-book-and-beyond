## Testing

The Makefile exposes three test targets that map to distinct verification phases: `test` runs the full unit and integration suite with the race detector enabled, `coverage` generates an HTML report highlighting untested branches, and `bench` executes microbenchmarks against the core routing and middleware hotpaths. Running all three before submitting a change ensures correctness, adequate coverage, and no performance regressions.

```bash
# Run all tests
make test

# Run with coverage
make coverage

# Run benchmarks
make bench
```
