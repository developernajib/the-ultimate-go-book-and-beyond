## Section 7: Security - Syscall Filter with LSM

eBPF LSM (Linux Security Module) hooks allow enforcing security policy at the kernel level without modifying the application or using seccomp profiles defined in JSON. Unlike seccomp, LSM hooks receive full struct context, the task, credentials, and file path, enabling fine-grained policies such as blocking a specific syscall only for processes in a particular cgroup or with a specific UID. The program below maintains a hash map of blocked syscall numbers and returns `EPERM` for any process that attempts a listed syscall, demonstrating how to build a lightweight sandbox in eBPF.

```c
// bpf/security.c - Block specific syscalls for containerized processes
//go:build ignore

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

// Blocked syscalls for sandboxed processes
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 256);
    __type(key, __u32);    // syscall number
    __type(value, __u8);   // 1 = blocked
} blocked_syscalls SEC(".maps");

// Target process group IDs to restrict
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 1024);
    __type(key, __u32);    // process group ID
    __type(value, __u8);   // 1 = monitored
} monitored_pids SEC(".maps");

struct violation_event {
    __u32 pid;
    __u32 syscall_nr;
    char  comm[16];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 20);
} violations SEC(".maps");

// LSM hook: called before every syscall
SEC("lsm/bpf")
int lsm_bpf_check(int cmd, union bpf_attr *attr, unsigned int size)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;

    // Check if this process is monitored
    __u8 *monitored = bpf_map_lookup_elem(&monitored_pids, &pid);
    if (!monitored)
        return 0; // Allow

    // BPF operation is allowed (we're doing the monitoring here)
    return 0;
}

SEC("tracepoint/raw_syscalls/sys_enter")
int trace_syscall(struct trace_event_raw_sys_enter *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u32 syscall_nr = ctx->id;

    // Check if monitored
    __u8 *monitored = bpf_map_lookup_elem(&monitored_pids, &pid);
    if (!monitored)
        return 0;

    // Check if blocked
    __u8 *blocked = bpf_map_lookup_elem(&blocked_syscalls, &syscall_nr);
    if (!blocked)
        return 0;

    // Log violation
    struct violation_event *event = bpf_ringbuf_reserve(&violations, sizeof(*event), 0);
    if (!event)
        return 0;

    event->pid = pid;
    event->syscall_nr = syscall_nr;
    bpf_get_current_comm(&event->comm, sizeof(event->comm));
    bpf_ringbuf_submit(event, 0);

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

```go
package security

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
	"golang.org/x/sys/unix"
)

// DangerousSyscalls lists syscalls to monitor in containers
var DangerousSyscalls = []uint32{
	59,  // execve
	322, // execveat
	167, // swapon
	166, // umount2
	39,  // getpid (often used for fingerprinting)
	56,  // clone
	57,  // fork
}

type ViolationEvent struct {
	PID       uint32
	SyscallNR uint32
	Comm      [16]byte
}

func (v ViolationEvent) CommStr() string {
	return unix.ByteSliceToString(v.Comm[:])
}

// SyscallMonitor tracks syscall violations
type SyscallMonitor struct {
	objs    *SecurityObjects
	tp      link.Link
	reader  *ringbuf.Reader
	logger  *slog.Logger
}

func NewSyscallMonitor() (*SyscallMonitor, error) {
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, err
	}

	objs := &SecurityObjects{}
	if err := LoadSecurityObjects(objs, nil); err != nil {
		return nil, fmt.Errorf("load: %w", err)
	}

	// Block dangerous syscalls
	for _, nr := range DangerousSyscalls {
		val := uint8(1)
		objs.BlockedSyscalls.Put(&nr, &val)
	}

	tp, err := link.Tracepoint("raw_syscalls", "sys_enter", objs.TraceSyscall, nil)
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("tracepoint: %w", err)
	}

	rd, err := ringbuf.NewReader(objs.Violations)
	if err != nil {
		tp.Close()
		objs.Close()
		return nil, err
	}

	return &SyscallMonitor{
		objs:   objs,
		tp:     tp,
		reader: rd,
		logger: slog.Default(),
	}, nil
}

// MonitorPID adds a PID to the monitored set
func (m *SyscallMonitor) MonitorPID(pid uint32) error {
	val := uint8(1)
	return m.objs.MonitoredPids.Put(&pid, &val)
}

func (m *SyscallMonitor) Run(ctx context.Context, handler func(ViolationEvent)) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		record, err := m.reader.Read()
		if err != nil {
			if err == ringbuf.ErrClosed {
				return nil
			}
			continue
		}

		var event ViolationEvent
		binary.Read(bytes.NewReader(record.RawSample), binary.LittleEndian, &event)
		handler(event)
	}
}

func (m *SyscallMonitor) Close() {
	m.reader.Close()
	m.tp.Close()
	m.objs.Close()
}
```

### Junior → FAANG: eBPF LSM as a Kernel-Level Security Primitive

eBPF LSM hooks are the most powerful and most dangerous eBPF program type for a junior to learn. The power comes from running security policy in the kernel, before user space can interfere, with access to the full task and credential context. The danger comes from the fact that returning a non-zero value from an LSM hook denies the operation, and a bug in the policy logic can deny legitimate operations and silently break production workloads. The first habit to build: always start with a logging-only LSM program that returns 0 (allow) and logs what it would have denied, before switching to enforcement mode.

The `lsm/bprm_check_security` hook (before process execution) and `lsm/file_open` hook (before file open) are good starting points because their scope is clear and their consequences are understandable. An LSM hook on `bprm_check_security` can prevent container breakout via binary execution (e.g., deny `ptrace` binary execution from a container context). The key prerequisite gap is understanding the LSM hook taxonomy: hooks exist for file operations, network operations, IPC, and process lifecycle events. The Linux kernel documentation lists all available LSM hooks and their arguments.

In contrast to seccomp BPF (which runs in user-space context with access only to syscall arguments), eBPF LSM runs in kernel context with access to kernel structs via CO-RE. This allows policies like "deny `open` of files in `/etc/shadow` from any process whose cgroup path contains a specific container name," which is impossible to express in a seccomp filter. Practice this by writing an LSM program that reads the cgroup path of the current task using `bpf_get_current_cgroup_id` and denies `file_open` for a specific path prefix only for that cgroup.

Interview framing: "What is the advantage of eBPF LSM over seccomp for container security?" The answer: eBPF LSM has access to kernel struct context (file paths, credentials, cgroup identity) and can implement policies that are conditional on runtime state stored in eBPF maps, while seccomp is limited to syscall number and argument filtering with no kernel context. eBPF LSM also runs after argument type safety, whereas seccomp runs on raw syscall numbers.

### Senior @ FAANG: eBPF LSM in Production: Risk, Governance, and Enforcement Architecture

eBPF LSM in production is a security-critical, availability-critical system. The ADR for deploying eBPF LSM enforcement must address five concerns: blast radius of a bug, rollback speed, observability during enforcement, interaction with existing security systems (AppArmor, SELinux), and the governance process for policy changes. The blast radius of a buggy LSM hook that denies a widely-called operation (such as `file_open` on the TLS certificate file) is fleet-wide outage. No other eBPF program type has this failure mode, and it requires a correspondingly rigorous deployment process.

Rollback speed for LSM programs is constrained by the fact that an eBPF LSM link must be explicitly detached to stop enforcement. If the link-owning process crashes, the LSM program continues to run unless the link was created without `BPF_F_ALLOW_OVERRIDE`. Platform teams design the LSM loader to use a watchdog: a secondary process that monitors the loader's health and detaches the LSM link if the loader fails to heartbeat within a configurable window. This transforms a loader crash from a silent enforcement gap into a controlled rollback.

The graduated enforcement model is the correct deployment pattern for eBPF LSM. Phase 1: audit mode, the LSM hook returns 0 but logs every operation it would have denied, along with the process identity and the rule that matched. Phase 2: enforcement for canary cgroups only (a specific test workload), monitoring denial rates and error rates in the application. Phase 3: enforcement for all cgroups in a single region. Phase 4: global rollout. Each phase requires a sign-off from the security team and the on-call team, documented in the deployment issue tracker. Skipping phases because "the policy is simple" is how production outages happen.

Interaction with existing Linux security modules requires careful design. If the system already runs AppArmor or SELinux, the eBPF LSM hook runs in addition to the existing LSM, not instead of it. The security decision is the logical AND of all LSM decisions: if AppArmor allows but the eBPF LSM denies, the operation is denied. This means eBPF LSM can only add restrictions, not relax them. Documenting this interaction model and verifying it in integration tests prevents the confusion that arises when an operation is denied but the eBPF LSM log shows no denial (because the denial came from AppArmor).

Policy-as-code governance for eBPF LSM requires the same rigor as IAM policy changes. All LSM policy changes go through code review by the security team, have an automated compliance check against the organization's security baseline (no program may inadvertently deny operations that are in the allowed set for all containers), and are tagged with the Jira ticket that motivated the change. Policy rollbacks must be executable in under 60 seconds without a full redeployment, which requires the loader daemon to support hot-reload of policy from the control map.

Bar-raiser signals for LSM at the senior level: understanding that eBPF LSM requires `CONFIG_BPF_LSM=y` and that `lsm=bpf` must be in the kernel command line (or the kernel config must list bpf in `CONFIG_LSM`), and that not all production kernels have this enabled. Knowing that the `sleepable` LSM programs (using `SEC("lsm.s/...")`) can call a larger set of helpers including `bpf_copy_from_user` but have stricter verifier rules. And articulating the tradeoff between eBPF LSM (flexible, updatable at runtime, no kernel recompile) and kernel-compiled LSMs like AppArmor (mature, audited, broader hook coverage, but requires kernel upgrade to update policy). These signals reveal whether the candidate has navigated real LSM deployment decisions.

---
