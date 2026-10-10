# Chapter 21: Graceful Shutdown & Signal Handling

*A service that can't shut down gracefully will leave requests hanging and data corrupted.*

Every deployment, every rolling restart, every autoscaler scale-in event sends a termination signal to your running service. What happens in the next thirty seconds determines whether your users experience an uninterrupted transition or a wave of 502 errors, lost database writes, and half-processed background jobs. Graceful shutdown is not an advanced feature to bolt on after launch. It is a fundamental correctness property that must be designed in from the beginning, because retrofitting it into a service that ignores signals is often harder than rebuilding the service from scratch.

The shutdown sequence has a precise ordering that cannot be violated: stop the load balancer from routing new traffic first, drain in-flight requests second, flush buffers and commit pending work third, close downstream connections fourth, and exit cleanly fifth. Skip a step or reverse the order and you introduce data races, resource leaks, or stuck goroutines that prevent the process from exiting. Kubernetes adds another layer of complexity: the `preStop` hook, the `terminationGracePeriodSeconds` budget, and the asynchronous nature of endpoint deregistration mean a naively implemented server can receive new connections for several seconds after it has already begun shutdown. Go's `context.WithTimeout`, `sync.WaitGroup`, and `http.Server.Shutdown` provide exactly the primitives needed to implement this sequence correctly, but the composition requires care.

The consequences of getting this wrong at scale are severe. A misconfigured shutdown sequence in a high-traffic payment service can cause thousands of in-flight transactions to be retried simultaneously, overwhelming downstream systems and creating a thundering herd that outlasts the original deployment by minutes. Mature deployment platforms treat a validated shutdown procedure as a production-readiness gate before a service is allowed to serve traffic, and some container platforms enforce a minimum graceful period and roll back deployments whose services exit before draining. Building correct shutdown behavior is an act of respect for every request already in flight when the signal arrives.

**What you'll learn in this chapter:**

- How to intercept `SIGINT`, `SIGTERM`, and `SIGHUP` using `signal.NotifyContext` and build a clean shutdown trigger
- How to call `http.Server.Shutdown` correctly and understand what it drains versus what it abandons
- How to coordinate shutdown across multiple components (HTTP server, gRPC server, message consumer, background workers) with guaranteed ordering
- How to use `context` and `sync.WaitGroup` to wait for all in-flight goroutines to finish before closing shared resources
- How to integrate with Kubernetes `preStop` hooks and tune `terminationGracePeriodSeconds` to match your service's actual drain time
- How to implement per-resource cleanup (database connection pool, Redis client, open files) with deferred close functions that run in the right order
- How to enforce a shutdown deadline so a misbehaving downstream call cannot prevent the process from ever exiting
- How to write integration tests that send real signals to a running server and assert all in-flight requests complete before the process exits

**Why this matters at scale:**

Payment and other correctness-critical platforms commonly gate production traffic on a validated graceful shutdown procedure, and deployment tooling that monitors rollouts can auto-roll-back services that exit before completing request drain. Google's SRE practice specifies connection draining as an item in a service's production readiness review. A missing shutdown drain is a classic cause of a cascade of 504 errors during an otherwise routine deployment, and it is often a tiny fix that takes far longer to diagnose than to apply.

**Prerequisites:** Chapters 1, 20. Understanding of Go's `context` package, goroutines, and HTTP server lifecycle.

> **For readers new to production Go:** graceful shutdown is not optional. Every production service needs it. Do not launch without it.
>
> **For readers already senior at a FAANG-equivalent:** the practical payoff here is making graceful shutdown a default, not a bolt-on. Build it into the service template so every new service has it correctly from day one.

**Chapter navigation by career stage.**

- **Junior or mid-level:** signal handling, http.Server.Shutdown, context-based cancellation. Core material.
- **Senior:** Kubernetes integration, per-resource cleanup ordering, shutdown deadline enforcement.
- **Staff or Principal:** the architectural question is "does every service in our catalog shut down correctly, and is there a template that makes this easy?". Drive the template and discipline.

**Staff and Principal lens: graceful shutdown is table-stakes infrastructure.** Every Go service should shut down correctly. The staff-level investment is the shared library and template that makes this automatic. Without it, every team reinvents shutdown and some get it wrong.

**Go version note.** `signal.NotifyContext` (Go 1.16+) is the modern pattern. `http.Server.Shutdown` is the correct API. `context.WithCancelCause` (Go 1.20) helps diagnose shutdown causes. OpenTelemetry shutdown APIs flush pending telemetry.

---
