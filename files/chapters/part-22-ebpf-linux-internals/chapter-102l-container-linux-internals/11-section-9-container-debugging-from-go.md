## Section 9: Container Debugging from Go

When a container behaves unexpectedly in production - consuming unexpected resources, making unexpected network calls, crashing silently - you need tooling that can inspect and interact with running containers at the kernel level.

### Junior → FAANG: Kernel-Level Container Debugging as a First-Job Superpower

The ability to debug a misbehaving container from the host without modifying the container image or restarting it is a high-value skill that most application engineers lack. The foundation is reading `/proc/<pid>/` for the container's init process (identified from `docker inspect <container> | jq '.[].State.Pid'` or from the cgroup tree). From there: `/proc/<pid>/fd/` shows open file descriptors (useful for detecting file descriptor leaks), `/proc/<pid>/net/tcp` shows established TCP connections (useful for detecting unexpected network connections), `/proc/<pid>/maps` shows memory mappings (useful for detecting unexpectedly loaded libraries), and `/proc/<pid>/status` shows capability sets and namespace memberships.

The `nsenter` command is the host-level equivalent of `kubectl exec`: it enters the container's namespaces and runs a command, but uses the host's tools (which may include tools not in the container image). `nsenter -t <pid> --net ip route show` runs `ip` in the container's network namespace using the host's `ip` binary. This is especially useful when the container image is distroless (contains no shell or tools): you can still inspect the container's networking, mount table, and process state from the host.

The first-job debugging workflow for a container with high memory usage: (1) find the container PID on the host, (2) read `/sys/fs/cgroup/<pod-cgroup>/memory.stat` and look at `anon`, `file`, and `shmem` categories, (3) if `anon` is high, the application has a memory leak in heap-allocated data, (4) if `file` is high, the application is reading large files and the page cache is filling the limit, (5) use `nsenter -t <pid> --net --pid smaps_rollup` (by reading `/proc/<pid>/smaps_rollup`) to see the memory breakdown by mapping type without entering the container.

### Senior @ FAANG: Container Debugging Infrastructure and Incident Response

At the senior level, debugging tools are not run manually on production hosts: they are embedded in automated incident response tooling. When a container OOMKills, the incident response runbook specifies: (1) the automated tool reads `memory.stat` and `smaps_rollup` for the container in the 30 seconds before the kill (from a ring buffer of snapshots captured by a background collector), (2) the tool attaches a memory profiling eBPF program to the container's PID namespace for the next 60 seconds if it restarts, and (3) the profiling data is automatically attached to the incident ticket. This tooling reduces mean time to diagnosis from hours (waiting for an engineer to manually attach) to minutes (automated data collection).

Building the container state snapshot collector requires the same primitives as this section's Go code: reading from `/proc`, `/sys/fs/cgroup`, and network namespaces. The collector runs as a DaemonSet with `hostPID: true` and `hostNetwork: true`, reads the state of all running containers on the node every 10 seconds, stores the snapshots in a ring buffer (keeping the last 10 snapshots per container), and makes them available via a node-local gRPC API. When an incident occurs, the incident tooling queries this API to get the pre-incident state.

`ptrace`-based debugging (used by `strace`, `gdb`, and Go's debugger `dlv`) requires `CAP_SYS_PTRACE` and the `ptrace` syscall to be allowed in the seccomp profile. Production containers should have both disabled. The correct architecture for production debugging without `ptrace` is to use eBPF uprobes (which do not require ptrace and can be attached from outside the container's namespace by the privileged eBPF daemon) to instrument specific functions in the running binary. This provides function-level tracing without the security risks of ptrace, and without modifying the container or requiring a restart. Bar-raiser signal: knowing that eBPF uprobes are the production-safe alternative to ptrace-based debugging, and being able to explain why.

The `kubectl debug` command (Kubernetes 1.18+) implements the ephemeral container pattern: it injects a temporary debug container into a running pod's namespace, sharing the pod's PID and network namespace but with its own filesystem containing debugging tools. This is the Kubernetes-native version of `nsenter` and is the recommended approach for interactive debugging in environments where host access is restricted. Platform teams provide a standard debug container image that includes `strace`, `tcpdump`, `curl`, `jq`, and the organization's internal tooling, and document which situations call for ephemeral containers versus host-level `nsenter` versus eBPF-based tracing.

---

```go
package containerdebug

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// ContainerDebugger provides helpers for inspecting container internals.
type ContainerDebugger struct {
	ContainerPID int // host PID of the container's init process
}

// NewContainerDebugger finds the host PID of a container's init process.
// For Docker: docker inspect --format '{{.State.Pid}}' <container-id>
// For containerd: runc state <container-id> | jq .pid
func NewContainerDebugger(containerPID int) *ContainerDebugger {
	return &ContainerDebugger{ContainerPID: containerPID}
}

// ListNamespaces returns the namespaces a container process is in.
// Each namespace is a symlink in /proc/<pid>/ns/.
func (d *ContainerDebugger) ListNamespaces() (map[string]string, error) {
	nsDir := fmt.Sprintf("/proc/%d/ns", d.ContainerPID)
	entries, err := os.ReadDir(nsDir)
	if err != nil {
		return nil, fmt.Errorf("read namespace dir: %w", err)
	}

	namespaces := make(map[string]string, len(entries))
	for _, entry := range entries {
		path := filepath.Join(nsDir, entry.Name())
		target, err := os.Readlink(path)
		if err != nil {
			continue
		}
		namespaces[entry.Name()] = target
	}
	return namespaces, nil
}

// ReadCgroupMemory returns the current memory usage and limit from cgroups v2.
func (d *ContainerDebugger) ReadCgroupMemory() (current, limit int64, err error) {
	// Find the container's cgroup from /proc/<pid>/cgroup
	cgroupData, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", d.ContainerPID))
	if err != nil {
		return 0, 0, fmt.Errorf("read cgroup: %w", err)
	}

	var cgroupPath string
	for _, line := range strings.Split(string(cgroupData), "\n") {
		parts := strings.SplitN(line, ":", 3)
		if len(parts) == 3 && parts[0] == "0" {
			cgroupPath = parts[2]
			break
		}
	}

	base := filepath.Join("/sys/fs/cgroup", cgroupPath)

	currentBytes, err := os.ReadFile(filepath.Join(base, "memory.current"))
	if err != nil {
		return 0, 0, fmt.Errorf("memory.current: %w", err)
	}
	current, _ = strconv.ParseInt(strings.TrimSpace(string(currentBytes)), 10, 64)

	limitBytes, err := os.ReadFile(filepath.Join(base, "memory.max"))
	if err != nil {
		return 0, 0, fmt.Errorf("memory.max: %w", err)
	}
	limitStr := strings.TrimSpace(string(limitBytes))
	if limitStr == "max" {
		limit = -1 // unlimited
	} else {
		limit, _ = strconv.ParseInt(limitStr, 10, 64)
	}

	return current, limit, nil
}

// ExecInNamespace runs a command inside the container's namespaces using nsenter.
// This is the Go equivalent of: nsenter -t <PID> -n -m -- ip addr
func (d *ContainerDebugger) ExecInNamespace(namespaceFlags []string, command string, args ...string) (string, error) {
	nsenterArgs := []string{
		fmt.Sprintf("-t%d", d.ContainerPID),
	}
	nsenterArgs = append(nsenterArgs, namespaceFlags...)
	nsenterArgs = append(nsenterArgs, "--", command)
	nsenterArgs = append(nsenterArgs, args...)

	out, err := exec.Command("nsenter", nsenterArgs...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("nsenter %v: %w\n%s", nsenterArgs, err, out)
	}
	return string(out), nil
}

// ListNetworkInterfaces lists network interfaces inside the container's network namespace.
func (d *ContainerDebugger) ListNetworkInterfaces() (string, error) {
	// -n: enter network namespace only
	return d.ExecInNamespace([]string{"-n"}, "ip", "addr", "show")
}

// ListMounts lists mounts inside the container's mount namespace.
func (d *ContainerDebugger) ListMounts() (string, error) {
	return d.ExecInNamespace([]string{"-m"}, "cat", "/proc/mounts")
}

// InspectProcess reads /proc/<pid>/ for process state without requiring root.
func InspectProcess(hostPID int) (*ProcessInfo, error) {
	base := fmt.Sprintf("/proc/%d", hostPID)

	cmdline, err := os.ReadFile(filepath.Join(base, "cmdline"))
	if err != nil {
		return nil, fmt.Errorf("read cmdline: %w", err)
	}
	// cmdline fields are NUL-separated
	args := strings.Split(strings.TrimRight(string(cmdline), "\x00"), "\x00")

	status, err := os.ReadFile(filepath.Join(base, "status"))
	if err != nil {
		return nil, fmt.Errorf("read status: %w", err)
	}

	info := &ProcessInfo{
		PID:     hostPID,
		Cmdline: args,
	}

	for _, line := range strings.Split(string(status), "\n") {
		parts := strings.SplitN(line, ":\t", 2)
		if len(parts) != 2 {
			continue
		}
		switch parts[0] {
		case "Name":
			info.Name = strings.TrimSpace(parts[1])
		case "State":
			info.State = strings.TrimSpace(parts[1])
		case "VmRSS":
			info.RSSKB, _ = strconv.ParseInt(strings.Fields(parts[1])[0], 10, 64)
		case "Threads":
			info.Threads, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
		}
	}

	return info, nil
}

type ProcessInfo struct {
	PID     int
	Name    string
	State   string
	Cmdline []string
	RSSKB   int64
	Threads int
}

func (p *ProcessInfo) String() string {
	return fmt.Sprintf("PID=%d Name=%s State=%s RSS=%dKB Threads=%d\nCmd: %s",
		p.PID, p.Name, p.State, p.RSSKB, p.Threads, strings.Join(p.Cmdline, " "))
}
```

### 9.1 Strace Equivalent in Go with ptrace

A simplified ptrace-based syscall logger (educational - production strace is more complex):

```go
package strace

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// TraceProcess starts a child process and logs every syscall it makes.
// This is the core mechanism behind strace and seccomp profiling tools.
func TraceProcess(prog string, args []string) error {
	cmd := exec.Command(prog, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// PTRACE_TRACEME: child asks to be traced by its parent.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Ptrace: true,
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start traced process: %w", err)
	}

	pid := cmd.Process.Pid

	// Wait for the initial SIGTRAP from ptrace.
	var ws syscall.WaitStatus
	if _, err := syscall.Wait4(pid, &ws, 0, nil); err != nil {
		return fmt.Errorf("first wait: %w", err)
	}

	var regs syscall.PtraceRegs
	for {
		// PTRACE_SYSCALL: let the process run until the next syscall entry or exit.
		if err := syscall.PtraceSyscall(pid, 0); err != nil {
			return fmt.Errorf("ptrace syscall: %w", err)
		}

		if _, err := syscall.Wait4(pid, &ws, 0, nil); err != nil {
			return fmt.Errorf("wait: %w", err)
		}

		if ws.Exited() {
			fmt.Printf("[process exited with status %d]\n", ws.ExitStatus())
			return nil
		}

		if err := syscall.PtraceGetRegs(pid, &regs); err != nil {
			continue
		}

		// On amd64, regs.Orig_rax contains the syscall number.
		fmt.Printf("syscall %d (orig_rax=%d)\n", regs.Orig_rax, regs.Orig_rax)
	}
}
```

---
