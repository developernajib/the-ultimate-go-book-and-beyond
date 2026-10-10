## Exercises

1. **Process Tracer**: Build a tool using kprobes that logs every process execution with timestamp, PID, parent PID, and full command line.

2. **Network Monitor**: Use XDP to build a DDoS detection tool that blocks source IPs sending more than 10,000 packets/second.

3. **Latency Profiler**: Attach kretprobes to `vfs_read` and `vfs_write` and build a latency histogram per file path, identifying slow I/O.

4. **Container Syscall Monitor**: Build a tool that monitors all syscalls for processes in a specific cgroup and alerts on dangerous syscalls (ptrace, mount, clone with CLONE_NEWNS).

5. **Flame Graph Generator**: Use stack trace maps to capture CPU profiles and generate a flamegraph-compatible output that shows hot code paths.

### Junior → FAANG: Structuring Your eBPF Exercise Practice

The five exercises in this chapter represent a progression from event emission (process tracer) to stateful aggregation (latency tracker, flame graph generator) to enforcement (XDP firewall, LSM). Work through them in order because each exercise introduces a new eBPF primitive that the next exercise depends on. Do not consider an exercise complete until you have a Go test that loads the program, triggers the traced event using a controlled subprocess, and asserts the expected map or ring buffer output.

For the process tracer exercise, add a CO-RE requirement: read the `task_struct::comm` field using `BPF_CORE_READ` and verify the program loads on at least two different kernel versions in a VM. This turns a basic kprobe exercise into a real CO-RE practice session. For the XDP firewall exercise, use `prog.Test()` (from `cilium/ebpf`) to write unit tests for the packet filtering logic without requiring a real network interface: pass a raw Ethernet frame byte slice and assert the return code is `XDP_DROP` for blocked IPs and `XDP_PASS` for allowed ones.

Interview value of these exercises comes from the debugging stories they generate. When you hit a verifier rejection on the process tracer (almost guaranteed on the first attempt), read the verifier log, understand the rejected instruction, fix it, and document what you learned. In an interview, "I wrote a process tracer with eBPF and hit a verifier rejection when I tried to read the argv pointer. The verifier rejected it because argv is a pointer-to-pointer in user space and requires two `bpf_probe_read_user` calls. Here is how I fixed it" is worth far more than any memorized answer.

### Senior @ FAANG: Extending Exercises into Platform Primitives

The exercises as written are individual tools. At the senior level, the question is how to generalize each tool into a platform primitive that other teams can use without eBPF expertise. The process tracer becomes a process audit service with a Kubernetes CRD for defining audit scope, a gRPC API for querying audit logs, and a retention policy engine. The XDP firewall becomes an IP blocklist service with a real-time feed from threat intelligence and a control plane that manages the eBPF map updates across the fleet. The flame graph generator becomes an always-on CPU profiling service with per-service sampling rate control and integration with the organization's profiling UI.

Each generalization requires solving the same set of platform problems: capability management (who can configure the service), schema versioning (how the eBPF event format evolves without breaking consumers), kernel compatibility (how the service handles nodes with different kernel versions), and operational runbooks (how on-call engineers debug the service when it misbehaves). Building one of these generalizations end-to-end, from a single-tool exercise to a multi-tenant platform service, is the kind of project that demonstrates L6-level engineering thinking and makes a strong promotion case.

---

---
