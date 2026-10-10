## Learning Objectives

By the end of this chapter, you will:
- Understand the eBPF architecture: maps, programs, verifier, and JIT compiler
- Write eBPF programs using C and load them from Go via `cilium/ebpf`
- Implement kprobes and tracepoints for system call tracing
- Build XDP programs for high-performance packet filtering
- Use ring buffers and perf event arrays for kernel-to-userspace communication
- Implement CO-RE (Compile Once, Run Everywhere) with BTF
- Build production observability tools: HTTP latency tracer, process tracker, network monitor

### Junior → FAANG: Bridging Learning Objectives to Interview Readiness

Learning objectives in eBPF chapters are not just a checklist: they map directly to interview question categories. When a candidate says they understand the eBPF verifier, interviewers probe whether they can explain what happens when a program accesses a map value that might be NULL. The correct answer is that the verifier requires a NULL check before the dereference, and without it the program is rejected at load time, not at runtime. This distinction, compile-time-analog safety via the verifier rather than runtime panics, is the core eBPF safety story.

Building the tracing programs listed in the objectives is necessary but not sufficient. The first-job habit to develop is writing a user-space test harness for each eBPF program. Using `cilium/ebpf` in a Go test file, you can load the program, trigger the event it monitors (using a child process or a synthetic syscall), and assert that the expected map entries or ring buffer events appear. This is the difference between "I wrote a tracer" and "I wrote a tracer with tests," which is what interviewers at FAANG mean when they ask about production readiness.

The network filtering objectives (XDP) require understanding the return code semantics: `XDP_PASS`, `XDP_DROP`, `XDP_TX`, and `XDP_REDIRECT`. A common interview question is: "What is the difference between dropping a packet in XDP versus in iptables?" The answer is that XDP operates before the kernel network stack allocates an `sk_buff`, so XDP drop costs roughly 10x fewer CPU cycles than iptables drop for the same packet, making it suitable for high-rate DDoS mitigation at line rate.

### Senior @ FAANG: Translating Objectives into Platform Maturity Criteria

At the senior level, learning objectives become the criteria for evaluating whether an eBPF platform is ready for broad adoption. An organization's eBPF platform is mature when every objective listed here can be demonstrated by a product team engineer who has never written a line of BPF C. That requires a layer of Go APIs, documentation, and guardrails that abstract the raw `cilium/ebpf` primitives behind domain-specific interfaces.

The CO-RE and LSM objectives are the highest-stakes items for a platform team. CO-RE readiness means the CI pipeline can prove that a program loads on all supported kernel versions before any code reaches production. LSM readiness means there is a staged rollout process with automatic rollback, because an LSM program that incorrectly denies a syscall can silently break production workloads in ways that look like application bugs. Defining these criteria explicitly in an ADR, and getting sign-off from the kernel and security teams, is the governance work that separates an eBPF prototype from an eBPF platform.

Platform thinking applied to the observability objectives means designing a schema registry for the events that eBPF programs emit. When a tracing program emits a struct over a ring buffer, that struct's layout is a contract. If the Go consumer expects field offsets that changed in a new version of the eBPF program, the consumer will silently misinterpret data. The solution is versioned protobuf or FlatBuffers schemas with automated compatibility checks in CI, the same discipline applied to gRPC APIs. This is L6 work: it is not required for a prototype, but it is required before a platform carries production traffic from multiple teams.

Bar-raiser signals on learning objectives: a senior candidate can articulate which objectives require kernel privileges and which can be achieved from unprivileged user space, can describe the tradeoffs between kprobes (unstable ABI, rich access) and tracepoints (stable ABI, fixed argument set), and can explain why CO-RE is an objective rather than just a nice-to-have. Candidates who treat CO-RE as optional reveal that they have not operated eBPF across a heterogeneous fleet.

---
