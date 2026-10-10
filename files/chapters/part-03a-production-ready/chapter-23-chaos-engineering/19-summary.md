## Summary

The full lifecycle of chaos engineering in Go spans from individual fault injectors to a production platform with safety controls.

1. **Fault Injection**: Wrap `http.Handler`, gRPC interceptors, and `*sql.DB` with thin middleware layers that inject latency, errors, and connection failures without modifying business logic
2. **Network Chaos**: Simulate partitions with custom dialers that block hosts and hang until the caller's own deadline fires, and model datagram loss on `net.PacketConn`, which is the only place loss is real, since TCP surfaces loss as latency or a reset and never as missing bytes
3. **Resource Exhaustion**: Force memory pressure with ballast allocations whose pages are actually touched, saturate CPU with per-core spin loops the compiler cannot delete, and exhaust file descriptors while holding a reserve so the cleanup path is not starved by the experiment
4. **Steady State Verification**: Define health as quantitative metrics (error rate, p99 latency, throughput), poll Prometheus before, during, and after each experiment, and fail closed on NaN and query errors so the abort condition cannot silently disarm itself
5. **Safety Controls**: Gate every experiment through a safety controller that enforces blast radius caps, cooldown periods, blocked hours, and emergency stop, and pair every injection with an automatic rollback triggered by context cancellation. The experiment runner refuses to inject at all without a steady-state hypothesis, a cleanup function, and a bounded duration, because an experiment missing any of those is an outage with a nicer name
6. **CI/CD Integration**: Use Go build tags to isolate chaos tests, run them on a nightly schedule in GitHub Actions, and collect container logs as artifacts on failure. Nightly chaos catches resilience regressions before the next outage does, not at merge time, which is what the deterministic tests in the PR suite are for
7. **Post-Mortem Culture**: Record incidents as typed structs with TTD/TTM/TTR timestamps and tracked action items, enabling programmatic analysis across many incidents to surface systemic patterns

### For the Senior-at-FAANG Track

Design experiments with hypotheses and success criteria. Lead GameDay exercises. Translate findings into resilience improvements.

### For the Staff and Principal Track

Establish the program. Drive cultural adoption. Make chaos testing part of production readiness. Measure impact (incidents prevented, MTTR improved).

---
