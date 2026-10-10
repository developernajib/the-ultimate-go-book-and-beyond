## Container Internals Architecture

A Linux container is not a first-class kernel object, it is a composition of three independent kernel primitives stacked together.

### Junior → FAANG: Understanding the Three-Layer Container Model

The three-layer model (namespaces, cgroups, security restrictions) is the conceptual framework for every container-related interview question and production debugging session. When a container is consuming too much memory, that is a cgroup layer issue: read `memory.current` and `memory.stat` under the cgroup path. When a container cannot see another container's processes, that is a namespace layer property: the PID namespace creates a separate PID tree. When a container is denied a syscall, that is a security layer issue: seccomp, capabilities, or an LSM policy is blocking the call.

Mapping symptoms to layers is the first-job diagnostic discipline. When a Kubernetes pod OOMKills, the event comes from the cgroup layer (the OOM killer acting on the cgroup's memory limit) and is visible in `dmesg` as "oom-kill event" and in `kubectl describe pod` as the "OOMKilled" reason. When a pod cannot bind to a port below 1024, that is a capability layer issue: the container needs `CAP_NET_BIND_SERVICE`. When a pod fails to `ptrace` another process (for a debugger use case), that is both a capability (`CAP_SYS_PTRACE`) and a seccomp issue (ptrace is blocked by default). Knowing which layer to look at first saves hours of debugging.

In interviews, the architecture question is usually framed as: "Walk me through what happens when you run `docker run ubuntu bash`." The complete answer covers: Docker daemon calls containerd, containerd calls runc via the OCI runtime interface, runc calls `clone()` with the namespace flags, sets up the cgroup hierarchy, applies the seccomp profile and capability drops, calls `pivot_root()` to switch the root filesystem to the image's overlay mount, and calls `execve()` to start bash. This level of detail demonstrates genuine understanding rather than surface knowledge.

### Senior @ FAANG: Container Architecture as a Security and Reliability Model

At the senior level, the container architecture is analyzed for its failure modes and attack surfaces, not just its capabilities. The namespace layer fails when a user namespace configuration allows privilege escalation: a process inside a user namespace can be UID 0 inside but map to an unprivileged UID outside, and bugs in the kernel's user namespace implementation have repeatedly allowed privilege escalation to the host. The FAANG response is to disable user namespaces fleet-wide except for workloads that specifically require them, enforced via a kernel parameter (`kernel.unprivileged_userns_clone=0` on Debian-based systems).

The cgroup layer fails in two ways: resource exhaustion (a container hits its memory limit and is OOM-killed) and resource starvation (a container's CPU shares are insufficient to make progress against higher-priority workloads). Both failure modes are observable but often confused with application bugs. Platform teams provide a cgroup observability dashboard that shows memory usage relative to limit, CPU throttling percentage (from `cpu.stat:throttled_usec`), and IO wait time, enabling engineers to distinguish "application is slow because of a code bug" from "application is slow because the cgroup is CPU-throttled 40% of the time."

The security layer architecture at FAANG uses defense in depth: capabilities are dropped to the minimum required set (determined by running the workload and tracing capability checks with `strace -e trace=prctl,capget,capset`), seccomp uses a custom profile generated from the traced syscall set plus a safety margin, and AppArmor or SELinux profiles are applied for MAC. The key ADR decision is the default-deny vs. default-allow posture: a default-deny seccomp profile blocks all syscalls not explicitly allowed and adds new syscalls only with security review. This is more secure but requires more maintenance overhead than Docker's default profile. FAANG security teams consistently choose default-deny for production workloads.

Staff-level architectural concern: the interaction between the three layers when a new workload type is introduced. When the platform adds support for a new language runtime or framework, it often requires a new capability or a new syscall not in the existing seccomp profile. The process for updating the security profile must be defined in advance: who reviews the change, how is it tested for regression (ensuring the new capability does not break existing workloads), how is the profile versioned, and how are running containers migrated to the new profile without a restart (which is generally not possible, requiring a rolling restart). Having this process defined and documented before the first exception request is the platform engineering work that prevents security policy from becoming a bottleneck.

--- Namespaces isolate the view of global resources: each container gets its own PID tree, network stack, mount table, UTS hostname, IPC objects, and optionally a mapped user ID range. Cgroups v2 enforce hard resource limits on that process group, capping CPU bandwidth, memory, and I/O throughput through a unified hierarchy under `/sys/fs/cgroup`. Security layers, seccomp, Linux capabilities, and mandatory access control policies, then restrict which syscalls and kernel interfaces the contained process is permitted to invoke, reducing the attack surface to only what the application legitimately needs.

```
┌──────────────────────────────────────────────────────────────────┐
│                   Container Building Blocks                      │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                    Container                             │    │
│  │  Process (PID namespace)                                 │    │
│  │  Filesystem (MNT namespace) ← OverlayFS                  │    │
│  │  Network (NET namespace)    ← veth pair                  │    │
│  │  Hostname (UTS namespace)                                │    │
│  │  IPC (IPC namespace)                                     │    │
│  │  User mapping (USER namespace)                           │    │
│  └──────────────────────────────────────────────────────────┘    │
│                           │                                      │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                  Resource Control                         │   │
│  │  cgroups v2: /sys/fs/cgroup/mycontainer/                  │   │
│  │    cpu.max = "100000 100000"  (100% of one CPU)           │   │
│  │    memory.max = 512M                                      │   │
│  │    io.max = "8:0 rbps=10485760"                           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                Security Layers                            │   │
│  │  seccomp: allow only safe syscalls                        │   │
│  │  capabilities: drop CAP_NET_RAW, CAP_SYS_ADMIN etc.       │   │
│  │  AppArmor/SELinux: MAC policy                             │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---
