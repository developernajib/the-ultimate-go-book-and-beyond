# Chapter 102K: eBPF with Go - Kernel Observability, Network Filtering, and Tracing

> *"eBPF is to the Linux kernel what JavaScript is to the browser: a safe, sandboxed execution environment that lets you extend the platform's behavior without touching its source code. For systems engineers, it is the most significant kernel capability to emerge in a decade."*

For most of Linux's history, observing the kernel's internal behavior required either kernel module development - complex, risky, and version-dependent - or instrumenting userspace with imprecise proxies like syscall counts and CPU flamegraphs. eBPF changed this entirely. An eBPF program is a small, bytecode-compiled program that the kernel's verifier checks for safety before loading it into a JIT-compiled execution context. Once loaded, it runs at kernel speed - attached to kprobes, tracepoints, network hooks, or scheduler events - with read access to kernel data structures and the ability to emit data to userspace through high-performance ring buffers and BPF maps. The result is sub-microsecond observability with zero application code changes and negligible performance overhead.

The `cilium/ebpf` library brings first-class eBPF support to Go. You write your eBPF program in C, compile it with `clang` to BPF bytecode, and then use `cilium/ebpf`'s generated bindings to load the program, attach it to kernel hooks, and interact with its maps from Go. CO-RE (Compile Once, Run Everywhere) and BTF (BPF Type Format) solve the portability problem that plagued earlier BPF tooling: a single compiled program runs correctly across kernel versions without recompilation, because BTF metadata allows field offsets to be resolved at load time. This means you can ship an eBPF-based observability agent as a single binary and deploy it across a heterogeneous fleet.

XDP (eXpress Data Path) represents eBPF's most extreme capability: packet processing at the network driver level, before the kernel's network stack ever sees the frame. An XDP program can inspect, modify, redirect, or drop packets at line rate - millions of packets per second on commodity hardware - making it practical for DDoS mitigation, load balancing, and custom protocol parsing without the overhead of raw sockets or kernel bypass frameworks. Cilium, the Kubernetes CNI that powers networking at Datadog, Adobe, and Palantir, is built almost entirely on eBPF and XDP. This chapter gives you the foundation to understand and extend systems like it.

**What you'll learn in this chapter:**

- The eBPF architecture: verifier safety model, JIT compiler, BPF maps, program types, and the kernel attachment model
- Writing eBPF programs in C and loading them from Go using `cilium/ebpf` with auto-generated type-safe bindings
- Attaching kprobes and tracepoints to trace system calls, kernel functions, and scheduler events with nanosecond precision
- Building XDP programs for high-performance packet filtering, rate limiting, and protocol-aware traffic steering
- Using ring buffers and perf event arrays for efficient kernel-to-userspace data streaming under high event rates
- Implementing CO-RE with BTF to write portable eBPF programs that run across Linux kernel versions without recompilation
- Building production-grade observability tools: HTTP latency tracer, process lifecycle tracker, per-connection network monitor
- Implementing eBPF-based security policies: syscall allow-listing, network egress enforcement, and runtime anomaly detection

**Why this matters at scale:**

Cilium uses eBPF to replace iptables in Kubernetes clusters at Google, Datadog, and Adobe - delivering dramatically better connection throughput and eliminating O(n²) iptables rule complexity. Meta's Katran L4 load balancer, handling hundreds of millions of requests per second across their data centers, is an XDP program loaded into commodity servers. Cloudflare's DDoS mitigation pipeline uses XDP to drop attack traffic at the NIC before it enters the kernel stack, protecting against terabit-scale volumetric attacks. Datadog's eBPF-based network performance monitoring product traces every TCP connection across a customer's entire fleet with less than 1% CPU overhead.

**Prerequisites:** Solid understanding of Linux system administration concepts (syscalls, processes, file descriptors), familiarity with C syntax for reading eBPF program examples, and Go proficiency at the level of previous chapters. Root or `CAP_BPF` access is required to run eBPF programs.

### Junior → FAANG: Getting Grounded in eBPF with Go

The first prerequisite gap to close is understanding the lifecycle of an eBPF program before writing a single line. An eBPF program is compiled to BPF bytecode, loaded into the kernel via the `bpf()` syscall, verified by the in-kernel verifier, JIT-compiled to native instructions, and then attached to a hook point. The `cilium/ebpf` Go library automates most of this, but understanding each step helps when something goes wrong. Juniors who skip this mental model hit verifier errors or attachment failures and have no idea where to look.

The second gap is tooling literacy. Before writing production eBPF code, get comfortable with `bpftool prog list` (see loaded programs), `bpftool map dump` (inspect map contents), and `bpftool perf list` (see active attachments). These are the equivalent of `ps`, `lsof`, and `netstat` for the eBPF subsystem. A first-job habit: always run `bpftool prog list` before and after loading your program to confirm it appears and is JIT-compiled, not interpreted.

A good entry exercise is loading the minimal skeleton from `bpf2go`: write a tracepoint program that counts `write` syscalls per PID using a `BPF_MAP_TYPE_HASH`, then read and print the map from Go every second. This covers the full Go-side workflow: embed the `.o` file with `//go:generate`, use the generated `Load` function, call `Map.Lookup`, and handle the cleanup with `defer prog.Close()`. The common mistake is forgetting to `pin` maps across program restarts, which causes map contents to vanish when the Go process exits.

In interviews, the introduction to eBPF with Go surfaces as: "How would you add low-overhead tracing to a production service without recompiling it?" The correct answer mentions uprobes or USDT probes attached from a Go controller process using `cilium/ebpf`, with data flowing through a ring buffer to avoid per-event syscall overhead. Being able to sketch this architecture on a whiteboard, with the kernel/user boundary labeled, is the entry-level signal FAANG interviewers look for.

### Senior @ FAANG: eBPF Platform Architecture and Operational Readiness

At the senior level, the introduction of eBPF into a production system is an architectural decision that requires an ADR covering four concerns: kernel version floor, capability management, program lifecycle ownership, and rollback strategy. The kernel version floor determines which BPF program types and helpers are available. At FAANG, where fleets span multiple kernel generations, the floor must be negotiated with the kernel team and encoded as a hard constraint in CI so that programs using helpers unavailable on older kernels are caught before deployment.

Capability management is a security-critical design decision. eBPF programs require `CAP_BPF` (kernel 5.8+) or `CAP_SYS_ADMIN` on older kernels. Running the eBPF loader process with `CAP_SYS_ADMIN` is a significant privilege escalation risk. The correct architecture separates the privileged loader daemon (a small, auditable binary with minimal attack surface) from the unprivileged controller that decides what to load. The loader daemon exposes a local Unix socket or gRPC interface that the controller uses to request program loads, keeping the privileged code surface minimal.

Program lifecycle ownership becomes contentious at scale. When a Go service owns its eBPF programs directly (loading on startup, cleaning up on shutdown), the programs disappear during rolling restarts, creating observability gaps. The alternative is a node-level eBPF daemon (similar to how Cilium's `cilium-agent` works) that owns program lifetimes independently of application processes. Deciding which model fits your organization's deployment topology is an L6-level architectural choice with long-tail consequences for how teams onboard.

CO-RE is the non-negotiable technical requirement for any multi-kernel deployment. Senior engineers ensure that the CI pipeline builds eBPF programs with `clang -target bpf -g` (to embed BTF), runs `bpftool gen min_core_btf` to produce the minimal BTF needed for each target kernel, and validates program load on a matrix of kernel versions in a VM-based test environment. The investment in this pipeline pays back every time a kernel upgrade happens without requiring an eBPF program rebuild.

Bar-raiser interview signals at the senior level for eBPF introduction topics: articulating the difference between per-CPU and global maps and when each is correct for a given workload. Explaining why ring buffers (`BPF_MAP_TYPE_RINGBUF`) are preferred over perf event arrays for new programs (better performance, simpler flow control, in-kernel reservation). And describing how to implement a safe rollout of a new eBPF program using a feature flag that controls whether the program attaches to its hook point, allowing fast disable without a process restart. These signals separate engineers who have used eBPF from engineers who have operated it at scale.

---
