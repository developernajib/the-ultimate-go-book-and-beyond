## Section 1: Linux Namespaces

Linux namespaces are the kernel mechanism that gives each container its own isolated view of system resources

### Junior → FAANG: Namespace Fundamentals and First-Job Diagnostics

The seven namespace types (PID, NET, MNT, UTS, IPC, USER, CGROUP) each isolate a different set of kernel resources. The one that surprises juniors most is the PID namespace: the first process in a new PID namespace gets PID 1. If that process exits, the kernel delivers SIGKILL to every other process in the namespace, just like init dying on a system. This is why Docker's "PID 1 problem" exists: if your container entrypoint is a shell script that execs your application, the shell is PID 1. If the application exits, the shell exits, which is fine. But if the application is a zombie process or does not handle SIGTERM correctly, the shell's cleanup behavior determines whether the container shuts down gracefully. The production fix is to use `tini` or Go's `signal.NotifyContext` in the entrypoint process.

The `setns(2)` syscall is the mechanism for entering an existing namespace, which is what `nsenter` and `kubectl exec` use. In Go, entering a namespace requires `syscall.Setns(fd, nstype)` where `fd` is a file descriptor from `/proc/<pid>/ns/<type>`. The important constraint is that `setns` must be called before `fork/exec`, and in a Go program this means it must happen in a `runtime.LockOSThread()` section or in a C preamble (using cgo's `__attribute__((constructor))` trick) because Go's runtime can move goroutines between OS threads. This is a common source of confusing bugs when writing container tooling in Go.

First-job habit: when debugging a container networking issue, always first confirm the network namespace is set up correctly. Run `ip netns list` to see named network namespaces, and `ip link show` inside the namespace (via `nsenter` or `ip netns exec`) to see the network interfaces. If the veth pair is missing or down, the container cannot communicate regardless of any iptables rules. Checking the namespace state before investigating iptables is the disciplined diagnostic order.

### Senior @ FAANG: Namespace Security and Platform Architecture

Namespace security at FAANG requires understanding the attack surface that each namespace type adds. The USER namespace is the most dangerous: it allows unprivileged processes to create namespaces with root inside, which has been the root cause of multiple kernel privilege escalation CVEs (CVE-2022-0492, CVE-2023-32233). FAANG security teams audit kernel CVEs weekly and have a documented policy for whether user namespaces are enabled fleet-wide, restricted by cgroup (Kubernetes 1.30+ supports `hostUsers: false` for pod-level user namespace), or disabled entirely.

The interaction between PID namespaces and the init process has reliability implications for container platforms. Kubernetes relies on the container's PID 1 to reap zombie processes. If PID 1 does not call `waitpid` for all children, zombie processes accumulate and eventually exhaust the PID space in the namespace, causing new process creation to fail. The Kubernetes `shareProcessNamespace: true` pod spec option shares the PID namespace between containers in a pod, allowing the pause container's init process to reap zombies from all containers. Knowing when to recommend this option is the production knowledge that separates platform engineers from users.

Mount namespace operations are a source of security incidents when misconfigured. A container with `CAP_SYS_ADMIN` can call `mount()` inside its mount namespace, but if the container has `MNT` namespace sharing with the host (`--pid=host` in Docker implicitly enables host PID namespace, which in combination with `/proc` mounts creates escape vectors), a malicious process can mount sensitive host filesystems. The platform team's responsibility is to document which mount namespace configurations are approved for which workload types and to enforce this via admission controllers.

Network namespace design at scale requires understanding how the CNI plugin creates and cleans up namespaces. A common production bug is network namespace leak: when a pod is deleted, if the kubelet fails between namespace deletion and CNI plugin cleanup, the veth pair and iptables rules from the deleted pod persist on the host. Over time, these accumulate and exhaust the system's IP address pool or iptables rule limit. Platform teams instrument the number of network namespaces per node (via `ip netns list | wc -l`) and alert when it deviates significantly from the expected number of running pods, enabling early detection of namespace leaks before they cause production failures.

---, a separate PID tree, filesystem root, network stack, IPC objects, and hostname, without the overhead of a full virtual machine. The `syscall.CLONE_NEW*` flags passed to `clone(2)` or `unshare(2)` select which namespaces the child process should be placed into, and Go can invoke these directly via the `syscall.SysProcAttr` on `exec.Cmd`. `RunInNamespace` ORs together the selected `CLONE_NEW*` flags and assigns them to `exec.Cmd.SysProcAttr.Cloneflags`, causing the kernel's `clone(2)` syscall to create the child in brand-new namespace instances. This is precisely the mechanism runc and containerd use to isolate containers, and understanding it at the Go syscall level is essential for writing custom container runtimes or debugging namespace-related permission errors.

```go
package namespaces

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// NamespaceFlags maps namespace types to clone flags
var NamespaceFlags = map[string]uintptr{
	"pid":  syscall.CLONE_NEWPID,
	"net":  syscall.CLONE_NEWNET,
	"mnt":  syscall.CLONE_NEWNS,
	"uts":  syscall.CLONE_NEWUTS,
	"ipc":  syscall.CLONE_NEWIPC,
	"user": syscall.CLONE_NEWUSER,
	"cgroup": 0x2000000, // CLONE_NEWCGROUP
}

// RunInNamespace runs a command in new namespaces
func RunInNamespace(command string, args []string, namespaces []string) error {
	var cloneFlags uintptr
	for _, ns := range namespaces {
		flag, ok := NamespaceFlags[ns]
		if !ok {
			return fmt.Errorf("unknown namespace: %s", ns)
		}
		cloneFlags |= flag
	}

	cmd := exec.Command(command, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: cloneFlags,
		// Map root inside container to current user outside
		UidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getuid(), Size: 1},
		},
		GidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getgid(), Size: 1},
		},
	}

	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

// InspectNamespace shows namespace information for a process
func InspectNamespace(pid int) (map[string]string, error) {
	nsTypes := []string{"pid", "net", "mnt", "uts", "ipc", "user"}
	result := make(map[string]string)

	for _, ns := range nsTypes {
		path := fmt.Sprintf("/proc/%d/ns/%s", pid, ns)
		target, err := os.Readlink(path)
		if err != nil {
			return nil, fmt.Errorf("readlink %s: %w", path, err)
		}
		result[ns] = target
	}

	return result, nil
}

// EnterNamespace enters the namespace of an existing process
// This is how `nsenter` works
func EnterNamespace(targetPID int, nsType string) error {
	nsPath := fmt.Sprintf("/proc/%d/ns/%s", targetPID, nsType)

	nsFile, err := os.Open(nsPath)
	if err != nil {
		return fmt.Errorf("open namespace: %w", err)
	}
	defer nsFile.Close()

	// setns(2) - join an existing namespace
	// Note: in Go, use unix.Setns from golang.org/x/sys/unix
	// unix.Setns(int(nsFile.Fd()), 0)
	_ = nsFile // Simplified for illustration
	return nil
}
```

---
