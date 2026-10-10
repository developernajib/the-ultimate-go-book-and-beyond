## Section 4: Tracepoint - Tracking File Opens

Tracepoints are stable kernel instrumentation hooks with fixed argument types, making them preferable to kprobes when a stable ABI is required across kernel versions. Attaching to the `syscalls/sys_enter_openat` tracepoint fires for every file open syscall and captures the filename and the process context, useful for auditing which files a service touches at runtime, detecting unexpected file access patterns, or diagnosing `EMFILE` (too many open files) errors by correlating them with the calling process.

```c
// bpf/openat_trace.c - Trace file open syscalls
//go:build ignore

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

struct open_event {
    __u32 pid;
    __u32 uid;
    char  comm[16];
    char  filename[256];
    int   ret;
    __u64 duration_ns;
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} open_events SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 8192);
    __type(key, __u32);
    __type(value, __u64);
} open_start SEC(".maps");

// Use tracepoints (more stable than kprobes across kernel versions)
SEC("tracepoint/syscalls/sys_enter_openat")
int tp_openat_enter(struct trace_event_raw_sys_enter *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 ts = bpf_ktime_get_ns();
    bpf_map_update_elem(&open_start, &pid, &ts, BPF_ANY);
    return 0;
}

SEC("tracepoint/syscalls/sys_exit_openat")
int tp_openat_exit(struct trace_event_raw_sys_exit *ctx)
{
    __u32 pid = bpf_get_current_pid_tgid() >> 32;
    __u64 *start = bpf_map_lookup_elem(&open_start, &pid);
    if (!start)
        return 0;

    __u64 duration = bpf_ktime_get_ns() - *start;
    bpf_map_delete_elem(&open_start, &pid);

    struct open_event *event = bpf_ringbuf_reserve(&open_events, sizeof(*event), 0);
    if (!event)
        return 0;

    event->pid = pid;
    event->uid = bpf_get_current_uid_gid() & 0xFFFFFFFF;
    event->ret = (int)ctx->ret;
    event->duration_ns = duration;
    bpf_get_current_comm(&event->comm, sizeof(event->comm));

    // Read filename from syscall arg
    bpf_probe_read_user_str(event->filename, sizeof(event->filename),
                             (void *)ctx->args[1]);

    bpf_ringbuf_submit(event, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

```go
package openattrace

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"strings"

	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
	"golang.org/x/sys/unix"
)

type OpenEvent struct {
	PID        uint32
	UID        uint32
	Comm       [16]byte
	Filename   [256]byte
	Ret        int32
	DurationNS uint64
}

func (e OpenEvent) CommStr() string    { return unix.ByteSliceToString(e.Comm[:]) }
func (e OpenEvent) FilenameStr() string { return unix.ByteSliceToString(e.Filename[:]) }

// OpenTracer traces file open syscalls
type OpenTracer struct {
	objs     *OpenatTraceObjects
	tpEnter  link.Link
	tpExit   link.Link
	reader   *ringbuf.Reader
	logger   *slog.Logger
	filter   func(OpenEvent) bool
}

func NewOpenTracer(filter func(OpenEvent) bool) (*OpenTracer, error) {
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, err
	}

	objs := &OpenatTraceObjects{}
	if err := LoadOpenatTraceObjects(objs, nil); err != nil {
		return nil, fmt.Errorf("load: %w", err)
	}

	enter, err := link.Tracepoint("syscalls", "sys_enter_openat", objs.TpOpenatEnter, nil)
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("tracepoint enter: %w", err)
	}

	exit, err := link.Tracepoint("syscalls", "sys_exit_openat", objs.TpOpenatExit, nil)
	if err != nil {
		enter.Close()
		objs.Close()
		return nil, fmt.Errorf("tracepoint exit: %w", err)
	}

	rd, err := ringbuf.NewReader(objs.OpenEvents)
	if err != nil {
		exit.Close()
		enter.Close()
		objs.Close()
		return nil, err
	}

	return &OpenTracer{
		objs:    objs,
		tpEnter: enter,
		tpExit:  exit,
		reader:  rd,
		logger:  slog.Default(),
		filter:  filter,
	}, nil
}

func (t *OpenTracer) Run(ctx context.Context, handler func(OpenEvent)) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		record, err := t.reader.Read()
		if err != nil {
			if err == ringbuf.ErrClosed {
				return nil
			}
			continue
		}

		var event OpenEvent
		if err := binary.Read(bytes.NewReader(record.RawSample),
			binary.LittleEndian, &event); err != nil {
			continue
		}

		if t.filter != nil && !t.filter(event) {
			continue
		}

		handler(event)
	}
}

func (t *OpenTracer) Close() {
	t.reader.Close()
	t.tpExit.Close()
	t.tpEnter.Close()
	t.objs.Close()
}

// Example: Track which files a process accesses
func TrackProcessFiles(ctx context.Context, targetComm string) {
	logger := slog.Default()

	tracer, err := NewOpenTracer(func(e OpenEvent) bool {
		return strings.HasPrefix(e.CommStr(), targetComm)
	})
	if err != nil {
		logger.Error("create tracer", "error", err)
		return
	}
	defer tracer.Close()

	fileAccess := make(map[string]int)

	tracer.Run(ctx, func(event OpenEvent) {
		filename := event.FilenameStr()
		fileAccess[filename]++
		if event.Ret < 0 {
			logger.Info("failed open",
				"comm", event.CommStr(),
				"file", filename,
				"errno", -event.Ret,
				"duration_us", event.DurationNS/1000)
		}
	})

	fmt.Printf("\nFile access summary for '%s':\n", targetComm)
	for file, count := range fileAccess {
		fmt.Printf("  %-50s: %d\n", file, count)
	}
}
```

### Junior → FAANG: Tracepoints as the Stable Foundation for eBPF Observability

The distinction between tracepoints and kprobes is fundamental and frequently tested in interviews. Tracepoints are declared in the kernel source with `TRACE_EVENT` macros and have a stable, documented argument list that the kernel maintainers commit to preserving across versions. Kprobes attach to any kernel symbol but depend on internal function signatures that can change without notice. The rule of thumb: always prefer a tracepoint if one covers your use case, and fall back to a kprobe only when no tracepoint exists.

The `syscalls/sys_enter_openat` tracepoint is an ideal first tracepoint program because the argument struct is simple (pathname string, flags integer), the event rate is easily controllable in a test environment, and the use case (file access auditing) is immediately understandable to non-eBPF engineers. Practice reading the filename from the `filename` pointer argument using `bpf_probe_read_user_str`, which safely dereferences a user-space pointer into a stack buffer. The common mistake is using `bpf_probe_read_kernel_str` instead, which fails silently for user-space pointers.

A first-job habit for tracepoint programs: always capture and emit the task's cgroup path alongside the PID and filename. In containerized environments, PIDs are not stable identifiers across container restarts, but the cgroup path encodes the pod name and namespace. Use `bpf_get_current_cgroup_id()` or walk the cgroup hierarchy from `bpf_get_current_task()` to get the container identity. This makes the tracer useful in Kubernetes environments where operators think in terms of pods, not raw PIDs.

Interview framing: "How would you audit all file opens by a specific containerized service without modifying the container image?" Describe attaching to `syscalls/sys_enter_openat`, filtering by cgroup ID (obtained by reading the service's cgroup from `/proc`), and emitting events to a ring buffer consumed by a Go aggregator that writes to a security audit log. This shows understanding of both the tracepoint mechanism and the container identity model.

### Senior @ FAANG: Tracepoint-Based Security Auditing at Platform Scale

File access auditing via tracepoints is the basis for runtime security products like Falco and Tetragon. At FAANG scale, the challenge is not writing the tracepoint program but designing the event pipeline that carries its output to security analysts without overwhelming the network or storage infrastructure. A single busy host can generate millions of `openat` events per second from a large container fleet. The eBPF program must pre-filter aggressively: pass only events matching a configurable allowlist of cgroup IDs or directories, and only emit events for paths matching a set of sensitive prefixes (credential files, key material, configuration directories).

The configurable filtering requires a map-based policy: a `BPF_MAP_TYPE_LRU_HASH` keyed by cgroup ID with a value indicating whether to trace that cgroup, and a `BPF_MAP_TYPE_HASH` of sensitive path prefixes. The control plane (a Go daemon) populates these maps from a policy source (Kubernetes CRDs, a policy file, or a remote API), enabling per-pod trace policy without reloading the eBPF program. This is the standard pattern for policy-driven eBPF programs and is the architectural basis for Cilium's network policy and Tetragon's security policy.

TOCTOU (time-of-check/time-of-use) in file auditing is a subtle correctness issue. The `openat` tracepoint fires when the syscall is entered, before the kernel resolves the filename to an inode. A file can be renamed or deleted between the tracepoint firing and the kernel completing the syscall. For security auditing, this means the filename in the event is the name the process attempted to open, not necessarily the file that was actually opened. The correct approach for high-assurance auditing is to combine the `sys_enter_openat` event with the `sys_exit_openat` event (which carries the returned file descriptor) and correlate by PID and timestamp to build a complete picture.

Cgroup ID stability across container restarts is a production concern. When a pod is deleted and recreated, the cgroup ID changes. The Go control plane must watch Kubernetes pod events and update the filter map when pods are restarted. Using the Kubernetes informer pattern (from `k8s.io/client-go/informers`) to maintain a live mapping from pod name to cgroup ID, and updating the eBPF filter map on pod creation and deletion events, is the production-grade approach.

Bar-raiser signals: understanding that `bpf_probe_read_user_str` is required for user-space pointers and cannot be replaced with direct dereference. Knowing that the `SEC("tp/syscalls/sys_enter_openat")` section name in the C program must match the tracepoint's subsystem and name exactly. And being able to describe the event pipeline from ring buffer to security SIEM with schema versioning and backpressure handling. These signals distinguish candidates who have built and operated tracepoint-based auditing systems from those who have only read about them.

---
