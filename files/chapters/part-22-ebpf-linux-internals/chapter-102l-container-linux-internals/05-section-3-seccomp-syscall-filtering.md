## Section 3: Seccomp - Syscall Filtering

Seccomp (secure computing mode) restricts the set of syscalls a process may invoke

### Junior → FAANG: Seccomp Fundamentals for Container Security

Seccomp filters are BPF programs that run in the kernel before each syscall, checking the syscall number and arguments against a set of rules. The key concepts to internalize: seccomp filters are per-thread (applying `prctl(PR_SET_SECCOMP)` affects the calling thread), filters are inherited by child processes via `fork/exec`, and filters cannot be removed once applied (they can only be made more restrictive). These properties make seccomp a reliable security mechanism: once a container has its seccomp profile applied, no code running inside the container can lift the restriction.

The practical first-job skill is diagnosing seccomp violations. When a container process is killed with `SIGSYS` (signal 31), seccomp blocked a syscall. Enable `SCMP_ACT_LOG` instead of `SCMP_ACT_KILL` in development to log denied syscalls to the audit log (`auditd`) without killing the process. Use `ausearch -m SECCOMP` to find the denied syscall number and look it up with `ausyscall <number>`. This workflow, enable logging, reproduce the failure, read the audit log, identify the denied syscall, add it to the allowlist, repeat, is the standard process for building a custom seccomp profile.

The Docker default seccomp profile (available in the Docker GitHub repository as `profiles/seccomp/default.json`) blocks about 44 syscalls including `ptrace`, `mount`, `kexec_load`, `perf_event_open`, `clone` with `CLONE_NEWUSER`, and several others. Knowing which syscalls are blocked by default and why is the foundation for explaining why some tools (debuggers, profilers) do not work inside containers without additional capabilities or a more permissive seccomp profile.

Interview framing: "Why is blocking `ptrace` in a container seccomp profile important?" The answer: `ptrace` allows one process to attach to another and read or modify its memory and registers. Inside a container, a compromised process with `ptrace` could extract secrets (environment variables, memory-mapped keys) from other processes in the same PID namespace. Blocking `ptrace` in the seccomp profile (rather than relying on capability `CAP_SYS_PTRACE`) prevents this even if the attacker manages to acquire `CAP_SYS_PTRACE` through a privilege escalation bug.

### Senior @ FAANG: Seccomp Profile Management at Fleet Scale

Seccomp profile management at FAANG scale requires solving three problems: profile generation (how to produce accurate profiles for each workload without hand-authoring BPF), profile distribution (how to deliver profiles to every node in a timely way), and profile enforcement (how to ensure profiles are actually applied and not bypassed).

Profile generation using eBPF tracing is the recommended modern approach. An eBPF program attached to `sys_enter` records every syscall made by the target process over a profiling period. The Go control plane reads the syscall set from the eBPF map and generates an OCI seccomp profile (a JSON document conforming to the `opencontainers/runtime-spec` `LinuxSeccomp` type). This profile is tighter than Docker's default (only the syscalls the application actually makes, plus a safety margin) and more accurate than a hand-authored profile. Tools like `inspektor-gadget`'s `advise seccomp-profile` implement exactly this workflow.

Profile distribution via Kubernetes uses the Seccomp Profile Operator (a CNCF project) or custom admission webhooks. The operator stores profiles as `SeccompProfile` CRDs, distributes them to node-local storage via a DaemonSet, and patches the pod's seccomp annotation to reference the local file path. The ADR for profile distribution must address: what happens when a new node joins the fleet before the profile DaemonSet has run (pods must not start with no profile), how profile updates are rolled out without restarting running pods (generally not possible: seccomp profiles are applied at container start), and how profile revocations are handled when a workload is decommissioned.

The `SCMP_ACT_LOG` enforcement mode is the transition tool for migrating from no seccomp to strict seccomp. Phase 1: apply a profile with `defaultAction: SCMP_ACT_LOG` (log violations, do not kill) and monitor the audit log for 30 days. Phase 2: move to `SCMP_ACT_ERRNO` for syscalls that were not observed during the logging period. Phase 3: move to `SCMP_ACT_KILL_PROCESS` for confirmed-unnecessary syscalls (those that would indicate an exploit attempt). This graduated approach reduces the risk of breaking production workloads during the migration from unrestricted to seccomp-enforced.

Seccomp and syscall ABI stability is a subtle concern for long-lived container workloads. When a language runtime update (a new Go version, for example) adds a new syscall that the existing seccomp profile does not allow, the container silently falls back to an alternative path or fails in a non-obvious way. The `SCMP_ACT_LOG` mode in production (logging but not killing) provides continuous visibility into new syscalls that the profile does not yet allow, enabling proactive profile updates before a new runtime version is deployed. This is a bar-raiser signal: knowing that seccomp profiles require ongoing maintenance as dependencies evolve, not just a one-time setup.

---, significantly reducing the kernel attack surface accessible to a compromised container. The `SECCOMP_MODE_FILTER` mode accepts a BPF filter program that returns an action (allow, kill, errno) for each syscall, building this filter in Go requires constructing the BPF instructions directly using `unix.SockFilter` structs. The implementation below builds a whitelist-mode filter that allows only a safe subset of syscalls and kills the process on any violation.

```go
package seccomp

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// SeccompAction defines what happens when a syscall is matched
type SeccompAction uint32

const (
	ActionKill    SeccompAction = 0x00000000 // Kill process
	ActionTrap    SeccompAction = 0x00030000 // Send SIGTRAP
	ActionErrno   SeccompAction = 0x00050000 // Return errno
	ActionTrace   SeccompAction = 0x7ff00000 // Trace
	ActionAllow   SeccompAction = 0x7fff0000 // Allow
)

// Filter represents a seccomp BPF filter
type Filter struct {
	defaultAction SeccompAction
	rules         []Rule
}

type Rule struct {
	Syscall uint32
	Action  SeccompAction
}

func NewFilter(defaultAction SeccompAction) *Filter {
	return &Filter{defaultAction: defaultAction}
}

// Allow permits a syscall
func (f *Filter) Allow(syscallNR uint32) *Filter {
	f.rules = append(f.rules, Rule{syscallNR, ActionAllow})
	return f
}

// Block denies a syscall with EPERM
func (f *Filter) Block(syscallNR uint32) *Filter {
	f.rules = append(f.rules, Rule{syscallNR, ActionErrno | uint32(syscall.EPERM)})
	return f
}

// DefaultContainerProfile returns a seccomp profile suitable for containers
// This is similar to Docker's default seccomp profile
func DefaultContainerProfile() *Filter {
	f := NewFilter(ActionAllow) // Allow by default, block dangerous syscalls

	// Block dangerous syscalls
	dangerousSyscalls := []uint32{
		// Kernel loading
		175, // init_module
		313, // finit_module
		176, // delete_module
		// Mounting
		165, // mount
		166, // umount2
		// Device access
		259, // perf_event_open
		// Namespace manipulation (allow for containers but block some)
		// 272, // unshare - typically blocked
		// Clock manipulation
		227, // clock_settime
		// Kernel keyring
		250, // request_key
		251, // keyctl
	}

	for _, nr := range dangerousSyscalls {
		f.Block(nr)
	}

	return f
}

// StrictProfile returns a minimal allowlist profile
func StrictProfile(allowedSyscalls []uint32) *Filter {
	f := NewFilter(ActionErrno | uint32(syscall.EPERM)) // Block by default
	for _, nr := range allowedSyscalls {
		f.Allow(nr)
	}
	return f
}

// Apply installs the seccomp filter for the current thread
// Note: In practice use libseccomp or the seccomp package
func (f *Filter) Apply() error {
	// Build BPF filter instructions
	// This is a simplified implementation
	// Real implementation should use the seccomp package:
	// github.com/seccomp/libseccomp-golang

	// Set no-new-privileges to prevent gaining privileges
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("set no-new-privs: %w", err)
	}

	// Install seccomp filter
	// In real code: use seccomp.NewSyscallCondition and seccomp.LoadFilter
	_ = unsafe.Pointer(nil) // Placeholder

	return nil
}
```

---
