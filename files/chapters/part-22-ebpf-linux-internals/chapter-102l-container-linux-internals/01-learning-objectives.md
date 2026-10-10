## Learning Objectives

By the end of this chapter, you will:
- Understand Linux namespaces and how they provide isolation
- Use cgroups v2 to enforce resource limits from Go
- Implement seccomp profiles to restrict syscalls
- Drop Linux capabilities for least-privilege containers
- Build a minimal container runtime in Go from scratch
- Understand overlay filesystems and OCI image layout
- Implement network namespaces with veth pairs

### Junior → FAANG: Mapping Learning Objectives to Diagnostic Skills

Each learning objective in this chapter is a specific diagnostic capability. Understanding namespaces means you can read `/proc/<pid>/ns/` to identify which namespaces a container uses, and use `nsenter -t <pid> -a` to run a command inside those namespaces from the host without modifying the container. Understanding cgroups v2 means you can read `memory.stat`, `cpu.stat`, and `io.stat` from the cgroup hierarchy to diagnose resource contention. These are the commands you will run in your first year when a container is misbehaving in production and your manager asks "why is the container using more memory than the limit?"

The seccomp objective is the security-relevant one that interviewers test specifically. Know that seccomp filters are applied to the process via `prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ...)` and that they use BPF bytecode to match syscalls and return one of `SCMP_ACT_ALLOW`, `SCMP_ACT_KILL`, `SCMP_ACT_ERRNO`, or `SCMP_ACT_LOG`. Know that Docker applies a default seccomp profile that blocks about 44 dangerous syscalls including `ptrace`, `mount`, and `perf_event_open`. Know how to use `strace` to identify syscalls a process makes when diagnosing why a container with a custom seccomp profile fails.

The network namespace and veth pair objective is directly relevant to Kubernetes networking interviews. Every Kubernetes pod has its own network namespace. The CNI plugin creates a veth pair, places one end in the pod namespace and the other in the host namespace, and adds routing rules so the pod can communicate. Knowing how to create this setup manually with `ip netns add`, `ip link add veth0 type veth peer name veth1`, and `ip link set veth1 netns <ns>` is the hands-on knowledge that supports Kubernetes networking explanations.

### Senior @ FAANG: Translating Objectives into Container Platform Design

The learning objectives define the knowledge required to build and operate a container platform. At the senior level, each objective is also a design decision point. Namespace implementation choice: which namespace types to enable by default, and which require explicit opt-in (user namespaces, in particular, add attack surface and have historically had kernel CVEs). Cgroup v2 design: whether to use systemd as the cgroup manager (Kubernetes now defaults to this via the `cgroupDriver: systemd` kubelet setting) or to manage cgroups directly. Seccomp design: whether to use a single default profile fleet-wide, per-workload profiles defined via Kubernetes annotations, or a dynamic profile generated from an eBPF-recorded syscall trace.

The overlay filesystem objective connects to supply chain security decisions. Overlay filesystems expose the layer architecture of container images, which is the basis for image scanning: each layer is a tar archive that can be independently scanned for CVEs. The ADR for image scanning at FAANG specifies whether scanning happens at build time, at push time, or at deploy time (or all three), which scanner is authoritative, and what happens when a running container's base image is found to have a new critical CVE (patch and redeploy, or accept the risk with a compensating control). This is L6-level security platform thinking that requires understanding the OCI image specification at the layer level.

---
