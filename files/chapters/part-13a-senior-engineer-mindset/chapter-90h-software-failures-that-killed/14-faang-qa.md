## FAANG Interview Q&A: Software Failures That Killed

These questions probe whether you can extract engineering principles from catastrophic failures in safety-critical systems and apply them to the production Go systems you actually build.

### 1. The Therac-25 killed multiple patients through a race condition. What is the analogous failure mode in a modern Go service, and how do you prevent it?

The Therac-25 failure was a race between operator input and safety interlocks in shared mutable state. In Go, the analogous failure is shared mutable state accessed by multiple goroutines without synchronization, where the race is undetectable until a specific timing produces a harmful output. Prevention: run `-race` in CI on every commit, use channels or `sync.Mutex` at every access point, and prefer immutable structures for safety-critical state. Mention that Go's race detector is a runtime, not compile-time, tool and does not catch races that the test suite does not exercise.

### 2. Boeing 737 MAX MCAS used a single angle-of-attack sensor to trigger a flight-control action. What is the design principle being violated?

The principle is N-modular redundancy for any safety-critical input. A staff-level answer describes how you would design a redundant-sensor voter: at least three independent sensors, a quorum requirement (2 of 3 agree within a configured tolerance), and an explicit refusal-to-act state when the quorum cannot be reached. Translate to Go systems: any production decision based on a single data source that cannot tolerate a single-source bug is an MCAS pattern in disguise.

### 3. The Patriot missile failure was caused by floating-point rounding accumulating over time. How do you defend against this in a Go service?

Floating-point drift accumulates in any system that uses `float64` for values that should be exact (money, time offsets, counters). Defenses: use `int64` nanoseconds rather than `float64` seconds for timing, use integer cents rather than floating-point dollars for money, reset accumulators on a bounded interval rather than letting them run indefinitely, and write property-based tests that verify invariants over long runs.

### 4. Design a deployment pipeline for a Go service where a bad deployment could cause human harm (medical device firmware, autonomous vehicle control).

A Staff-level answer covers: dual-implementation diverse redundancy, formal verification or model checking of the safety-critical path, fuzz testing integrated into CI, a staged deployment that is slower and more gated than a normal web service, and a reversible rollback that does not depend on the deployed system functioning. Reference NASA's Power of 10 rules and the Space Shuttle process as the existence proof that software at this reliability level is achievable but expensive.

### 5. The Ariane 5 rocket was destroyed by an unhandled integer-overflow exception in reused code. What is the lesson for Go engineers reusing code across contexts?

Code that is correct in one context is not guaranteed to be correct in another. The Ariane 5 failure happened because software from Ariane 4 was reused in a physics envelope it was not designed for. In Go, the analogous pattern is copying a utility package from one service to another without re-validating the assumptions (timeouts, error classes, resource limits). Mitigation: treat every reuse as a fresh integration, add explicit bounds checks at context boundaries, and use Go's type system to encode invariants that must hold in every context.

### Junior → FAANG: Translating Catastrophic Failures into Interview Readiness

The five questions above cover both system design and behavioral interview formats. Questions 1-3 are technical: race condition defense, redundant sensor design, and floating-point drift mitigation. For each, the expected answer names the failure mode, explains why it is dangerous, and describes the specific Go mechanism that prevents it. The answers above are complete at the L4 level. To elevate to L5, add a concrete example from your own work: "I applied the `sync.Mutex` interlock pattern to our rate limiter after recognizing that the read-modify-write cycle on the token bucket was the same race as the Therac-25's flag decrement." Personal application of the principle is the signal that distinguishes L5 from L4 answers. Question 4 is a full system design question appropriate for Staff-level loops. Practice delivering the complete answer in under 10 minutes, covering all five elements: diverse redundancy, formal verification, fuzz testing, staged deployment, and reversible rollback.

### Senior @ FAANG: Bar-Raiser Framing for Safety-Critical System Design

At the bar-raiser level, every question above has an organizational dimension beyond the technical pattern. Question 1 (race condition detection): the bar-raiser follow-up is "how do you ensure the race detector runs on every commit across a fleet of 200 services maintained by 40 teams?" The answer requires a CI platform that enforces race detection by default, not team discipline. Question 2 (N-modular redundancy): the bar-raiser follow-up is "how do you identify which services in your org currently have the single-sensor pattern and need to be upgraded?" The answer requires a design review process that asks the question "what single data sources drive irreversible automated actions?" for every service. Question 4 (deployment pipeline for harmful-consequence software): the bar-raiser follow-up is "how do you build an organization capable of deploying safety-critical software reliably?" The answer is not a technical pattern: it is a hiring profile (engineers with safety systems background), a review process (independent safety review board), a testing culture (formal verification as a first-class investment), and a culture that treats schedule pressure as insufficient justification for skipping safety gates. The bar-raiser is evaluating whether you think at the organizational level, not just the technical level.

---
