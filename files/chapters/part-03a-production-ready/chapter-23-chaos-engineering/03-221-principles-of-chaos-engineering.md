## 23.1 Principles of Chaos Engineering

Chaos engineering is built on a set of foundational principles that distinguish it from traditional testing. While unit tests and integration tests verify that code works correctly under expected conditions, chaos engineering asks a fundamentally different question: can your system survive when things go wrong in ways you did not anticipate? The principles below form the foundation that every chaos practitioner should internalize before designing their first experiment.

### The Principles of Chaos Engineering

The discipline has a canonical statement, published at `principlesofchaos.org`, and it is worth quoting rather than paraphrasing:

> Chaos Engineering is the discipline of experimenting on a system in order to build confidence in the system's capability to withstand turbulent conditions in production.

Note what that definition does not say. It does not say "breaking things". Chaos engineering is experimentation, and the output is *confidence*, which means an experiment that finds nothing is still a success: it bought you evidence you did not have before.

The five advanced principles, verbatim from the same source:

1. **Build a Hypothesis around Steady State Behavior**
2. **Vary Real-world Events** (server crashes, network failures, and so on)
3. **Run Experiments in Production**
4. **Automate Experiments to Run Continuously**
5. **Minimize Blast Radius**

The canonical experiment is a four-step loop, and step 2 is the one most teams skip:

1. Establish a **steady state**: a measurable output that indicates normal system behavior.
2. Hypothesize that the steady state **continues in both a control group and an experimental group**.
3. Introduce variables reflecting real-world events: server crashes, network failures, drive failures.
4. Try to **disprove** the hypothesis by finding a difference in steady state between the two groups.

The control group is what makes this an experiment rather than an anecdote. Without one you cannot tell an effect you caused from a deploy someone else shipped, a traffic shift, or a bad afternoon at a cloud provider. And note step 4's framing: you are trying to *disprove* your hypothesis, not confirm it. An experiment designed to succeed teaches nothing.

### Why Chaos Engineering?

Traditional testing validates behavior against a known set of inputs, it cannot expose the gaps that emerge when a real dependency misbehaves in an unanticipated way. Chaos engineering deliberately injects those real-world failure modes (network partitions, disk exhaustion, dependency latency spikes) and observes whether the system degrades gracefully or collapses entirely. The contrast below captures this difference in scope.

```
Traditional Testing: "Does the code work?"
Chaos Engineering: "Does the system survive failure?"
```

Chaos engineering reveals:
- Hidden dependencies
- Cascading failures
- Recovery time issues
- Alert gaps
- Runbook accuracy

### Staff Lens: Start Small, Build Trust

Do not start with production chaos. Start with staging. Prove the framework. Demonstrate findings. Build trust with leadership. Then graduate to controlled production chaos. Organizations that start with production chaos without preparation cause incidents and lose trust.

---
