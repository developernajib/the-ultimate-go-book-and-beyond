## Section 6: Minimal Container Runtime

A minimal container runtime ties together all the preceding primitives

### Junior → FAANG: Building a Runtime to Understand Production Containers

Building a minimal container runtime in Go is the fastest way to internalize what production runtimes like runc do. The implementation forces you to order the operations correctly: namespaces must be created before cgroups are applied to the new PID, the overlay mount must happen before `pivot_root`, capabilities must be dropped after the overlay mount but before `execve`. Getting this order wrong causes confusing errors (mount failing because the PID namespace is not yet set up, or capabilities dropping before the mount that needs them).

The `CLONE_NEWUSER` trick deserves special attention. By creating a user namespace first and mapping the host UID to UID 0 inside, the process can perform operations that require root inside the namespace (like creating other namespaces) without having `CAP_SYS_ADMIN` on the host. This is the basis for rootless containers (Podman, rootless Docker) and is a common interview topic. The limitation is that user namespace creation requires `kernel.unprivileged_userns_clone=1` (or equivalent), which many FAANG environments disable for security reasons, making rootless containers infeasible on those systems.

The `pivot_root` sequence is the hardest part of the runtime to get right. The correct order is: bind-mount the new root onto itself (to make it a mount point), create a `put_old` directory inside the new root, call `pivot_root(new_root, put_old)`, change directory to `/`, unmount `put_old` lazily with `MNT_DETACH`, and remove the `put_old` directory. Skipping any step causes the pivot to fail or leaves the old root accessible from inside the container. Practice this sequence until it is mechanical.

Interview framing: "Walk me through the sequence of syscalls a minimal container runtime makes." The expected answer covers `clone()` with namespace flags, `cgroup.procs` write for resource limits, `mount()` for the overlay filesystem, `chdir()` and `pivot_root()` for the filesystem root, `prctl(PR_SET_SECCOMP)` for syscall filtering, `capset()` for capability drops, and `execve()` for the container process. Candidates who can list this sequence in order demonstrate that they understand containers at the implementation level, not just the conceptual level.

### Senior @ FAANG: Container Runtime Selection and Custom Runtime Development

At the senior level, the minimal container runtime exercise is the basis for evaluating whether a production runtime is appropriate for a specific workload. runc (the OCI reference runtime) implements exactly the sequence in this section, plus OCI lifecycle hooks, rootfs preparation, and state management. Understanding the sequence means you can read the runc source code to understand a specific behavior, diagnose a runc bug by tracing its syscalls, or evaluate an alternative runtime's implementation choices.

gVisor's `runsc` runtime replaces the direct syscall path with a user-space kernel (the Sentry) that intercepts all guest syscalls and implements them using a minimal set of host syscalls. The security benefit is that guest workloads never directly call the host kernel, so kernel exploits in the guest cannot escape to the host. The performance cost is approximately 10-20% overhead for syscall-heavy workloads and near-zero overhead for compute-heavy workloads. The ADR for gVisor adoption must specify which workload categories justify the performance cost (untrusted multi-tenant workloads, customer-code execution, CI runners) and which do not (internal services, database workloads).

Kata Containers runs each container in a lightweight VM using a paired hypervisor and minimal guest kernel. The isolation is stronger than gVisor (the guest kernel is fully separate, so kernel exploits are contained to the VM), and the performance overhead is lower for I/O-heavy workloads (the guest kernel's I/O path is more optimized than gVisor's synthetic drivers). The tradeoff is higher startup latency (300-500ms vs. 100ms for runc) and more complex hardware requirements (KVM support on the node). FAANG batch processing systems that run customer code (CI, ML training on customer data) typically use Kata for this tradeoff.

Custom runtime development on top of this chapter's primitives is appropriate for specialized use cases: a runtime that enforces a specific security policy (different from runc's default), a runtime that integrates with a custom resource controller, or a runtime for a non-Linux kernel environment. When building a custom runtime, the OCI runtime spec (`config.json`) is the contract: if your runtime consumes a valid `config.json` and produces the correct lifecycle behavior (create, start, state, kill, delete), it is OCI-compliant and can be used with any OCI-compatible orchestrator. This compliance requirement is the design constraint that drives the runtime's API design.

---, namespaces, cgroups, overlay filesystem, capabilities, and seccomp, into a single orchestration layer that launches an isolated process. Understanding this sequence demystifies what Docker, containerd, and runc actually do: create namespaces, set up the filesystem root, apply resource limits, drop privileges, and exec the container entrypoint. The implementation below assembles these steps in the correct order and demonstrates the `CLONE_NEWUSER` user namespace trick that allows unprivileged users to create containers.

```go
package runtime

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/yourorg/cgroups"
	"github.com/yourorg/overlay"
)

// ContainerConfig defines how to run a container
type ContainerConfig struct {
	ID       string
	Image    string // Path to image rootfs
	Command  []string
	Env      []string
	Hostname string
	Memory   int64  // Bytes
	CPUQuota int64  // Microseconds per period
	PIDs     int64
	RootDir  string // Base directory for container data
}

// Container represents a running container
type Container struct {
	config  ContainerConfig
	cgroup  *cgroups.Cgroup
	overlay *overlay.OverlayMount
	cmd     *exec.Cmd
	logger  *slog.Logger
}

// NewContainer creates a new container
func NewContainer(cfg ContainerConfig) *Container {
	return &Container{
		config: cfg,
		logger: slog.Default(),
	}
}

// Start launches the container
func (c *Container) Start() error {
	c.logger.Info("starting container", "id", c.config.ID, "command", c.config.Command)

	// 1. Set up overlay filesystem
	if err := c.setupFilesystem(); err != nil {
		return fmt.Errorf("setup filesystem: %w", err)
	}

	// 2. Set up cgroup
	if err := c.setupCgroup(); err != nil {
		c.cleanup()
		return fmt.Errorf("setup cgroup: %w", err)
	}

	// 3. Launch process in new namespaces
	if err := c.launch(); err != nil {
		c.cleanup()
		return fmt.Errorf("launch: %w", err)
	}

	return nil
}

func (c *Container) setupFilesystem() error {
	rootDir := filepath.Join(c.config.RootDir, c.config.ID)

	c.overlay = &overlay.OverlayMount{
		LowerDir:  c.config.Image,
		UpperDir:  filepath.Join(rootDir, "upper"),
		WorkDir:   filepath.Join(rootDir, "work"),
		MergedDir: filepath.Join(rootDir, "merged"),
	}

	return c.overlay.Mount()
}

func (c *Container) setupCgroup() error {
	var err error
	c.cgroup, err = cgroups.Create("containers/" + c.config.ID)
	if err != nil {
		return err
	}

	return c.cgroup.Apply(cgroups.CgroupConfig{
		Name:            c.config.ID,
		MemoryMaxBytes:  c.config.Memory,
		CPUQuotaUS:      c.config.CPUQuota,
		CPUPeriodUS:     100000,
		PIDsMax:         c.config.PIDs,
	})
}

func (c *Container) launch() error {
	mergedDir := filepath.Join(c.config.RootDir, c.config.ID, "merged")

	// The container init process re-execs itself with /proc/self/exe
	// to set up namespaces. Here we use a simplified approach.
	c.cmd = exec.Command("/proc/self/exe", append([]string{"init"}, c.config.Command...)...)
	c.cmd.Env = append(c.config.Env,
		"CONTAINER_ID="+c.config.ID,
		"CONTAINER_ROOT="+mergedDir,
	)

	c.cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWUTS |
			syscall.CLONE_NEWPID |
			syscall.CLONE_NEWNS |
			syscall.CLONE_NEWIPC,
		// User namespace mapping
		UidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getuid(), Size: 1},
		},
		GidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getgid(), Size: 1},
		},
	}

	c.cmd.Stdin = os.Stdin
	c.cmd.Stdout = os.Stdout
	c.cmd.Stderr = os.Stderr

	if err := c.cmd.Start(); err != nil {
		return err
	}

	// Add container process to cgroup
	if err := c.cgroup.AddPID(c.cmd.Process.Pid); err != nil {
		c.cmd.Process.Kill()
		return fmt.Errorf("add to cgroup: %w", err)
	}

	return nil
}

// Wait waits for the container process to exit
func (c *Container) Wait() error {
	if c.cmd == nil {
		return nil
	}
	return c.cmd.Wait()
}

// Stop kills the container
func (c *Container) Stop() error {
	if c.cmd != nil && c.cmd.Process != nil {
		c.cmd.Process.Signal(syscall.SIGTERM)
	}
	return nil
}

func (c *Container) cleanup() {
	if c.overlay != nil {
		c.overlay.Unmount()
	}
	if c.cgroup != nil {
		c.cgroup.Delete()
	}
}

// ContainerInit is called by the re-exec inside the container namespace
// It sets up the container environment before exec'ing the user command
func ContainerInit(command []string) error {
	root := os.Getenv("CONTAINER_ROOT")
	if root == "" {
		return fmt.Errorf("CONTAINER_ROOT not set")
	}

	// Change root filesystem to container's merged dir
	if err := syscall.Chroot(root); err != nil {
		return fmt.Errorf("chroot: %w", err)
	}

	if err := os.Chdir("/"); err != nil {
		return fmt.Errorf("chdir: %w", err)
	}

	// Mount /proc
	if err := os.MkdirAll("/proc", 0755); err != nil {
		return fmt.Errorf("mkdir /proc: %w", err)
	}
	if err := syscall.Mount("proc", "/proc", "proc", 0, ""); err != nil {
		return fmt.Errorf("mount proc: %w", err)
	}

	// Mount /sys
	if err := os.MkdirAll("/sys", 0755); err != nil {
		return fmt.Errorf("mkdir /sys: %w", err)
	}
	if err := syscall.Mount("sysfs", "/sys", "sysfs", 0, ""); err != nil {
		return fmt.Errorf("mount sys: %w", err)
	}

	// Mount /dev/pts
	if err := os.MkdirAll("/dev/pts", 0755); err != nil {
		return fmt.Errorf("mkdir /dev/pts: %w", err)
	}

	// Exec the user command
	cmd := command[0]
	if err := syscall.Exec(cmd, command, os.Environ()); err != nil {
		return fmt.Errorf("exec %s: %w", cmd, err)
	}

	return nil
}
```

---
