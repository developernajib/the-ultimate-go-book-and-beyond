## Learning Objectives

By the end of this chapter, you will be able to:
- Diagnose network performance problems using Go's built-in tooling and OS-level utilities
- Implement packet capture and analysis in Go using `gopacket`
- Profile and optimize HTTP client and server connection behavior
- Detect and fix connection leaks, timeout misconfiguration, and retry storms
- Build a production-grade network diagnostics framework
- Apply systematic latency optimization across all network layers

### Junior → FAANG: From Objectives to Debugging Reflexes

The objectives in this chapter are debugging reflexes, not just knowledge items. "Detect and fix connection leaks" is not a thing you know. It is a thing you do. The reflex is: see a rising file descriptor count or goroutine count that is not proportional to connection count, immediately reach for `ss -tan` to check socket state distribution, check `go_goroutines` against `websocket_active_connections * 2`, and look for `CLOSE_WAIT` accumulation that indicates unclosed response bodies.

Building these reflexes requires practice: deliberately introduce each common mistake in a test environment, observe the metrics that surface it, and run through the diagnostic steps. After doing this three times with connection leaks, you will recognize the pattern instantly in production.

### Senior @ FAANG: Objectives as SLO Input

Each objective corresponds to a platform metric that should be in a service's SLO. "Profile and optimize HTTP client and server connection behavior" maps to: connection pool utilization under target (70-80%), idle connection timeout above zero, no connection creation rate exceeding pool size. "Detect and fix retry storms" maps to: retry rate below threshold (5% of requests), exponential backoff with jitter enforced by platform SDK, circuit breaker tripping correctly on sustained error rate.

Making these metrics visible in the platform's default dashboard, with threshold alerts pre-configured, eliminates the need for each team to discover the objective independently during an incident. Platform-level defaults that expose each objective's health metric are the organizational multiplier on the individual skill described in these learning objectives.

---
