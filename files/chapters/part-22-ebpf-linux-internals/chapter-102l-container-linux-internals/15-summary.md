## Summary

Containers are Linux primitives composed together - not a single kernel feature:

- **Namespaces** (7 types): PID, NET, MNT, UTS, IPC, USER, CGROUP. Each wraps a different OS resource into an isolated view. Created with `clone(2)` flags or `unshare(2)`. The combination of all 7 produces the illusion of a separate machine.

- **cgroups v2**: Unified hierarchy at `/sys/fs/cgroup/`. Enforces CPU (`cpu.max`), memory (`memory.max`, `memory.oom.group`), block I/O (`io.max`), and PID count (`pids.max`) limits. Always clean up cgroup directories after container exit to prevent resource leaks.

- **Overlay filesystem**: Presents a merged view of read-only lower layers (image) and a writable upper layer (container changes). Copy-on-write: files are only copied to upper when first written. Whiteout files handle deletions. The image is never modified.

- **seccomp**: BPF-based syscall filter applied before exec. Default-deny with allowlist is the secure model. Docker's default profile blocks ~44 dangerous syscalls. Apply custom profiles for specialized containers that need fewer syscalls than the default.

- **Capabilities**: Fine-grained privilege decomposition. Drop `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_SYS_PTRACE`, `CAP_SYS_MODULE` for all production containers. Use `PR_CAP_AMBIENT_CLEAR_ALL` to drop inherited capabilities across exec.

- **OCI specification**: Standardizes image format (manifests, config, layers), runtime configuration (`config.json`), and distribution API. Any OCI runtime (runc, crun, gVisor, Kata) can execute any OCI image - portability without vendor lock-in.

- **Container debugging**: `/proc/<host-pid>/ns/` reveals namespace memberships. `/sys/fs/cgroup/<path>/memory.stat` reveals memory breakdown. `nsenter -t <pid>` executes commands inside container namespaces without modifying the container. ptrace provides syscall-level tracing.

- **Building a runtime in Go**: ~200 lines demonstrates that containers are just `clone()` + `exec()` + mount setup. Understanding the primitives is what separates engineers who debug containers from those who only operate them.

### Junior → FAANG: From Summary to Operational Competence

The summary's final line is the most important: "Understanding the primitives is what separates engineers who debug containers from those who only operate them." This chapter's goal is not just to use containers but to be able to diagnose any container failure by understanding which primitive is involved. Build a personal reference card: namespace failures look like "process cannot see X" (use `ip netns`, `nsenter`). Cgroup failures look like OOM kills or CPU throttling (use `memory.stat`, `cpu.stat`). Capability failures look like "Operation not permitted" on specific operations (use `capsh`, `strace -e trace=prctl`). Seccomp failures look like `SIGSYS` or `EPERM` on specific syscalls (use audit log).

The operational competence test: take any production container incident description and, without looking anything up, identify which layer is most likely responsible, which files to read to confirm, and what the fix would be. If you can do this for OOM kills (cgroup, `memory.stat`, increase limit or fix leak), CPU throttling (cgroup, `cpu.stat`, increase limit or reduce request-to-limit ratio), syscall denial (seccomp or capability, audit log or `capsh`, update profile or add capability), and network failures (namespace or CNI, `ip netns`, `nsenter`, `iptables`), you have reached operational competence in container internals.

### Senior @ FAANG: Summary as Platform Design Foundation

This chapter's primitives are the design vocabulary for container platform architecture. At the senior level, every platform design decision maps to one or more of these primitives. Container security posture: which capabilities are permitted, which seccomp profile is applied, which namespaces are shared or isolated. Container resource governance: which cgroup controllers are enabled, what the default request-to-limit ratio is, how PSI metrics drive autoscaling. Container networking: which CNI plugin manages veth pairs, how network policies are enforced (iptables vs eBPF), how service load balancing routes traffic through the network namespace stack.

The summary also defines the scope of what a platform team owns versus what application teams own. The platform team owns the namespace and cgroup configuration (applied via the container runtime and Kubernetes), the security profile management (seccomp, capabilities, AppArmor), the CNI plugin and network namespace lifecycle, and the container debugging tooling. Application teams own the process running inside the container, the filesystem content, the resource requests and limits (within platform-defined guardrails), and the application-level networking (which ports to expose, which services to connect to). This boundary is the organizational contract that enables hundreds of teams to run containers safely on a shared platform.

---

| [◀ Chapter 102K: eBPF with Go](../chapter-102k-ebpf-with-go/00-introduction.md) | [Chapter 102L: Container & Linux Internals](00-introduction.md) | [Chapter 102M: Building an OS in Go](../chapter-102m-building-an-os-in-go/00-introduction.md) ▶ |
| :--- | :---: | ---: |
