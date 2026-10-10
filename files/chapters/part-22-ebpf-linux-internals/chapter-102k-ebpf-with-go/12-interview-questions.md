## Interview Questions

**Q: What is eBPF and why is it revolutionary for observability?**

A: eBPF (Extended Berkeley Packet Filter) allows running sandboxed programs inside the Linux kernel without modifying kernel source or loading kernel modules. It's revolutionary because: (1) **zero instrumentation** - observe any kernel function without modifying application code, (2) **low overhead** - JIT-compiled to native code, much faster than ptrace/strace, (3) **safe** - verifier ensures no infinite loops, no OOB access, no crashes, (4) **portable** - CO-RE allows running the same program across kernel versions, (5) **production-safe** - can be attached/detached at runtime with no service restart.

**Q: What's the difference between kprobes and tracepoints?**

A: **Kprobes** attach to any kernel function by name - flexible but fragile across kernel versions (function names can change or be inlined). **Tracepoints** are stable hooks explicitly added by kernel developers at important points (syscall entry/exit, scheduler events, network events) - they're stable across versions but limited to what the kernel exposes. For production use, prefer tracepoints where available. Use kprobes for custom instrumentation.

**Q: How does XDP achieve line-rate packet processing?**

A: XDP runs eBPF programs at the earliest possible point in the network stack - directly in the NIC driver before Linux allocates a socket buffer (`sk_buff`). This means zero packet copies, no memory allocation overhead, and no lock contention. Combined with NAPI polling and batch processing, XDP can process millions of packets per second per CPU core. It can forward (XDP_TX), redirect (XDP_REDIRECT), pass to kernel (XDP_PASS), or drop (XDP_DROP) with minimal CPU overhead.

### Junior → FAANG: Interview Question Strategy for eBPF

The interview questions in this chapter represent the standard screening set for infrastructure, platform, and systems engineering roles at FAANG. The pattern across all questions is the same: the interviewer wants to see that you understand the "why" behind each mechanism, not just the "what." When answering the XDP question, do not just list the return codes. Explain that XDP's performance advantage comes from running before `sk_buff` allocation, which means the kernel's memory allocator is never invoked for dropped packets, eliminating the most expensive per-packet operation in the normal network stack.

The CO-RE question is a common filter for senior roles. Candidates who answer "you compile separately for each kernel" are immediately identified as having no fleet-scale eBPF experience. The correct answer walks through: BTF (type information embedded in the kernel), CO-RE relocations (field offset fixups applied at load time), `BPF_CORE_READ` as the safe accessor, and `bpf_core_field_exists` for version-conditional logic. If you can then mention `bpftool gen min_core_btf` for reducing BTF distribution overhead, you have demonstrated platform-level thinking.

Prepare a two-minute story about a real eBPF program you wrote, deployed, and operated. The story should include: what problem it solved, what attachment point you used and why, how you handled the kernel version compatibility issue, what went wrong in testing or production and how you debugged it, and what you would do differently. This story is the most valuable interview preparation you can do because it answers multiple questions simultaneously and demonstrates depth that generic answers cannot.

### Senior @ FAANG: Bar-Raiser Interview Signals in eBPF Discussions

Bar-raiser interviewers for eBPF-heavy roles at FAANG are looking for candidates who can distinguish between using eBPF and operating eBPF at scale. The distinction surfaces in questions like: "How would you deploy a new eBPF program to a 100,000-node fleet?" A user of eBPF answers "ship the binary and load it." An operator of eBPF answers: staged rollout starting with canary nodes, kernel version compatibility check before loading, link-based atomic program replacement (no gap in coverage during update), automated rollback if error rate spikes, and observability of the eBPF layer itself (drop counters, load failures, verifier rejections tracked as metrics).

The question "What are the security implications of allowing arbitrary teams to deploy eBPF programs?" is a bar-raiser question that has no single correct answer. A strong response covers: the capability required (`CAP_BPF` or `CAP_SYS_ADMIN`), the risk of a buggy LSM program causing fleet-wide denial, the need for a privileged loader daemon with a narrow API, the verifier as a safety boundary (but not a security boundary against authorized users), and the audit logging requirement for all eBPF program loads. Candidates who treat the verifier as the complete security answer reveal they have not thought about the governance problem.

System design interviews may present a scenario like: "Design an eBPF-based observability platform that lets product teams instrument their services without kernel expertise." Strong L6+ responses cover: a Go SDK that generates eBPF programs from a high-level DSL, a central registry of approved program templates, a CI pipeline that verifies each template on the kernel version matrix, a privileged loader daemon with a gRPC API for program lifecycle management, a schema registry for event types, and a self-service dashboard for teams to view their eBPF-generated metrics. This response demonstrates L6-level platform thinking: building infrastructure that multiplies the productivity of other teams.

---

---
