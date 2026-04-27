export default `## Exercises

These exercises reinforce each major feature from this chapter. They progress from pure API usage (iterators, maps) through performance measurement (PGO, Swiss Tables) to operational tooling (leak detection). Completing all five gives you hands-on experience with the features most likely to appear in production Go codebases targeting 1.22+.

1. **Iterator Pipeline**: Build a pipeline that reads user records from a database (simulated with a slice), filters by role, maps to DTOs, and collects the top 10 by score, all without intermediate slice allocations.

2. **GC Optimization**: Profile a simple HTTP server that processes JSON, identify GC pressure points, and reduce allocations by 50% using sync.Pool, pre-sized slices, and json/v2 streaming.

3. **PGO Benchmarking**: Take a JSON processing function, collect a CPU profile, rebuild with PGO, and measure the speedup using \`benchstat\`.

4. **Leak Detector**: Write a \`LeakDetector\` middleware that checks goroutine counts before and after each HTTP request and logs any leaks with stack traces.

5. **Swiss Tables Benchmark**: Create benchmarks comparing map operations with different key types (int64, string, struct) and measure Swiss Tables throughput at various load factors.

### Senior at FAANG Track

6. **Version-upgrade economic analysis.** Pick one service your team owns. Upgrade Go from its current version to 1.26. Measure the change in GC CPU, RSS, p99 latency, and build time. Write a 500-word memo to stakeholders that translates the measurements into operational cost savings. The deliverable is the memo, not the code change.

7. **Continuous profiling rollout proposal.** For your org, propose a continuous profiling solution. Compare Pyroscope, Parca, and a hosted equivalent. Cover integration cost, retention policy, on-call integration, and the diagnostic value over one year. The deliverable is a proposal your platform lead could approve.

8. **PGO adoption for the top hot service.** Build the profile-collection pipeline, set up the PGO build, measure the speedup, and document the refresh cadence. The deliverable is the running pipeline plus the documentation.

9. **\`encoding/json/v2\` migration playbook.** For one service, migrate from v1 to v2 behind the experiment flag. Document every breaking change you encountered, how you detected it, and how you fixed it. The playbook is the artifact the rest of the org will use when they migrate.

10. **Team code-review checklist.** Take the discipline rules from this chapter (goroutine leak detection, \`os.Root\` for path handling, \`unique.Make\` for interning, \`slices.Sort\` over \`sort.Slice\`, \`GOMEMLIMIT\` in every container) and write your team's code-review checklist. Wire the mechanical checks into CI. The deliverable is the checklist plus the CI config.

---
`;
