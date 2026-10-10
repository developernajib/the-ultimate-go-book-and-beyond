## 102G.4 Runtime Security

### seccomp Profile

A seccomp (secure computing mode) profile restricts which Linux system calls a container process may make, limiting the blast radius if an attacker achieves code execution inside the container. A Go HTTP server needs only a handful of syscalls. Network operations, file I/O, memory management. So a tight allowlist can block dozens of privilege-escalation vectors such as `ptrace`, `mount`, and `setuid`. Kubernetes supports loading custom seccomp profiles via the `securityContext.seccompProfile` field, or you can start with the `RuntimeDefault` profile which Kubernetes applies automatically on most modern container runtimes.

```json
// seccomp-profile.json - allow only syscalls needed by Go HTTP server
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64", "SCMP_ARCH_AARCH64"],
  "syscalls": [
    {
      "names": [
        "accept4", "bind", "clock_gettime", "clone", "close",
        "connect", "epoll_create1", "epoll_ctl", "epoll_pwait",
        "exit", "exit_group", "fstat", "futex", "getcwd",
        "getdents64", "geteuid", "getpid", "getrandom",
        "getsockname", "getsockopt", "ioctl", "kill",
        "listen", "madvise", "mmap", "mprotect", "munmap",
        "nanosleep", "openat", "pipe2", "poll", "pread64",
        "read", "readlinkat", "recvfrom", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "sched_getaffinity",
        "sched_yield", "sendto", "set_robust_list", "setitimer",
        "setsockopt", "sigaltstack", "socket", "tgkill",
        "uname", "write", "writev"
      ],
      "action": "SCMP_ACT_ALLOW"
    }
  ]
}
```

```yaml
# Apply seccomp in Kubernetes pod spec
spec:
  securityContext:
    seccompProfile:
      type: Localhost
      localhostProfile: profiles/my-app-seccomp.json
    # Or use the runtime default (blocks ~300 risky syscalls)
    # seccompProfile:
    #   type: RuntimeDefault
  containers:
    - name: app
      securityContext:
        allowPrivilegeEscalation: false
        runAsNonRoot: true
        runAsUser: 65534
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
          # Only add what you actually need:
          # add: [NET_BIND_SERVICE]  # only if binding port < 1024
      volumeMounts:
        # If app needs to write, mount specific writable tmpfs dirs
        - name: tmp
          mountPath: /tmp
        - name: cache
          mountPath: /app/cache
  volumes:
    - name: tmp
      emptyDir: {}
    - name: cache
      emptyDir:
        medium: Memory
        sizeLimit: 100Mi
```

### Falco Runtime Security Rules

Falco is a Cloud Native Computing Foundation runtime security project that uses eBPF or kernel module probes to observe system calls and container events, then matches them against a rules engine to emit alerts. Unlike static analysis tools, Falco catches behavioral anomalies at runtime. A compromised container attempting to open a reverse shell, write to `/etc`, or make an unexpected outbound connection. None of which a vulnerability scanner or admission controller would catch after deployment. Rules are written in a Sysdig condition syntax that combines kernel-level fields (file descriptors, process names, user IDs) with container metadata fields, making it straightforward to scope rules tightly to a specific image or namespace.

```yaml
# falco-rules.yaml - detect suspicious container behavior
- rule: Unexpected Outbound Network Connection
  desc: Detect container making unexpected outbound connections
  condition: >
    outbound and
    container and
    container.image.repository = "myorg/shopapp-api" and
    not (fd.sport in (80, 443, 5432, 6379, 9092))
  output: >
    Unexpected outbound connection from container
    (user=%user.name container=%container.name
     connection=%fd.name image=%container.image.repository)
  priority: WARNING
  tags: [network, container]

- rule: Write to Sensitive Directory
  desc: Detect writes to /etc, /usr, /bin in container
  condition: >
    open_write and
    container and
    (fd.name startswith /etc/ or
     fd.name startswith /usr/ or
     fd.name startswith /bin/)
  output: >
    Write to sensitive directory
    (user=%user.name file=%fd.name container=%container.name)
  priority: ERROR

- rule: Shell Spawned in Container
  desc: Detect shell execution in container (possible breach)
  condition: >
    spawned_process and container and
    proc.name in (bash, sh, zsh, fish)
  output: >
    Shell spawned in container
    (user=%user.name shell=%proc.name container=%container.name
     cmdline=%proc.cmdline)
  priority: CRITICAL
```

---

### Junior → FAANG: Seccomp and Falco as Complementary Controls

A common interview question: "what is the difference between seccomp and Falco?" The answer: seccomp is preventive (it blocks syscalls from executing), Falco is detective (it observes syscalls and alerts on suspicious patterns). You need both. Seccomp reduces the syscall surface before an exploit succeeds. Falco detects exploit attempts and post-compromise behavior that seccomp did not block.

The prerequisite gap is understanding why the `RuntimeDefault` seccomp profile is a better first step than a custom allowlist. Writing a custom allowlist requires knowing every syscall your application makes, including indirect syscalls from the Go runtime and from third-party libraries. Get it wrong and your application crashes with `EPERM` in production. `RuntimeDefault` blocks the most dangerous syscalls (ptrace, mount, setuid) while allowing everything a typical application needs. Start there, then tighten.

Worked example for interviews: a compromised container attempts to spawn a reverse shell using `bash`. With a distroless image, there is no `bash` binary. With a `readOnlyRootFilesystem`, an attacker cannot write a shell script. With the shell-spawned Falco rule, even if a shell somehow executes, it triggers a CRITICAL alert. Layered controls each reduce a different attack vector.

First-job habit: add `allowPrivilegeEscalation: false` and `readOnlyRootFilesystem: true` to every pod spec you write or review. These two fields together eliminate most privilege escalation and persistence techniques. They are fast to add and have almost no application impact for stateless services.

### Senior @ FAANG: Runtime Security as a Detection and Response Platform

At the L6/L7 level, Falco is not just a tool you configure once. It is a component of your detection and response platform, and its operational health is as important as the security controls it enforces.

The governance question for Falco is alert fatigue management. A rule set that generates 10,000 alerts per day is indistinguishable from no alerting at all because the signal is buried in noise. A staff engineer owning the runtime security platform must establish a process for: measuring alert volume per rule, suppressing noisy rules that have a high false positive rate, escalating rules with zero alerts (which may indicate the rule is not working), and reviewing the rule set quarterly against current threat intelligence.

The Falco rule for "Shell Spawned in Container" is a good example of a rule that will fire frequently in most organizations and almost never indicates a breach. Build containers, debug containers, CI containers, and operator tooling all spawn shells legitimately. The rule needs namespace or label scoping to be useful in production. A staff engineer reviewing this rule set should immediately ask: "what are the exclusions for legitimate shell usage, and how do we ensure those exclusions do not create blind spots?"

The ADR for Falco deployment in a large Kubernetes cluster needs to address: eBPF vs kernel module (eBPF is preferred for modern kernels because it does not require a kernel module build), alert routing (Falco events go to a security SIEM, not just a log file), response automation (a Falco event above a severity threshold triggers automatic pod isolation via a network policy change), and the false positive review process.

At the seccomp level, the platform pattern is maintaining a library of seccomp profiles for common application types (Go HTTP server, Java service, Python worker) that teams reference by name rather than writing custom profiles. The platform team generates and validates these profiles using `strace` and profile generation tools, audits them against each Go runtime version update (because the Go runtime's syscall usage changes between versions), and distributes them through a ConfigMap or DaemonSet that mounts them on every node. This is the operational work that makes seccomp viable at scale rather than a security exercise that one team uses and others avoid because it is too difficult to configure correctly.
