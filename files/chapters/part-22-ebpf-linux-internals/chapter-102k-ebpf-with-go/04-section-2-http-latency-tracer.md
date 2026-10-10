## Section 2: HTTP Latency Tracer

Measuring HTTP latency at the kernel level with eBPF captures true wire time that is invisible to application-level instrumentation, it includes time spent in the kernel TCP stack before and after user-space code runs. The kprobe/kretprobe pair on `tcp_sendmsg` records the start time when a send begins and computes the duration when it completes, then increments the appropriate histogram bucket atomically using per-CPU arrays to avoid inter-CPU cache contention.

```c
// bpf/http_trace.c - Measure HTTP request latency using kprobes
//go:build ignore

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>

// Track in-flight requests: fd -> start_time
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 10240);
    __type(key, __u64);    // pid_tgid | fd
    __type(value, __u64);  // start timestamp (ns)
} in_flight SEC(".maps");

// Latency histogram buckets (microseconds)
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 20);
    __type(key, __u32);
    __type(value, __u64);
} latency_hist SEC(".maps");

// Per-CPU counters for efficiency
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} request_count SEC(".maps");

struct http_event {
    __u32 pid;
    __u64 duration_ns;
    __u32 status_code;
    char  path[128];
};

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 24);
} http_events SEC(".maps");

// Attach to tcp_sendmsg to catch response sends
SEC("kprobe/tcp_sendmsg")
int kprobe_tcp_sendmsg(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 now = bpf_ktime_get_ns();
    bpf_map_update_elem(&in_flight, &pid_tgid, &now, BPF_ANY);
    return 0;
}

SEC("kretprobe/tcp_sendmsg")
int kretprobe_tcp_sendmsg(struct pt_regs *ctx)
{
    __u64 pid_tgid = bpf_get_current_pid_tgid();
    __u64 *start = bpf_map_lookup_elem(&in_flight, &pid_tgid);
    if (!start)
        return 0;

    __u64 duration = bpf_ktime_get_ns() - *start;
    bpf_map_delete_elem(&in_flight, &pid_tgid);

    // Update histogram
    __u32 bucket = 0;
    __u64 us = duration / 1000;
    if (us < 100)        bucket = 0;
    else if (us < 500)   bucket = 1;
    else if (us < 1000)  bucket = 2;
    else if (us < 5000)  bucket = 3;
    else if (us < 10000) bucket = 4;
    else                 bucket = 5;

    __u64 *count = bpf_map_lookup_elem(&latency_hist, &bucket);
    if (count)
        __sync_fetch_and_add(count, 1);

    return 0;
}

char LICENSE[] SEC("license") = "GPL";
```

```go
package httptrace

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/rlimit"
)

// LatencyHistogram reads the eBPF latency histogram
type LatencyHistogram struct {
	objs        *HttpTraceObjects
	kprobe      link.Link
	kretprobe   link.Link
	logger      *slog.Logger
}

// Bucket labels for the histogram
var bucketLabels = []string{
	"<100µs", "100-500µs", "500µs-1ms", "1-5ms", "5-10ms", ">10ms",
}

func NewLatencyHistogram() (*LatencyHistogram, error) {
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, err
	}

	objs := &HttpTraceObjects{}
	if err := LoadHttpTraceObjects(objs, nil); err != nil {
		return nil, fmt.Errorf("load objects: %w", err)
	}

	kp, err := link.Kprobe("tcp_sendmsg", objs.KprobeTcpSendmsg, nil)
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("attach kprobe: %w", err)
	}

	krp, err := link.Kretprobe("tcp_sendmsg", objs.KretprobeTcpSendmsg, nil)
	if err != nil {
		kp.Close()
		objs.Close()
		return nil, fmt.Errorf("attach kretprobe: %w", err)
	}

	return &LatencyHistogram{
		objs:      objs,
		kprobe:    kp,
		kretprobe: krp,
		logger:    slog.Default(),
	}, nil
}

// ReadHistogram reads and prints the current latency distribution
func (h *LatencyHistogram) ReadHistogram() map[string]uint64 {
	result := make(map[string]uint64)

	for i := range len(bucketLabels) {
		var count uint64
		key := uint32(i)
		h.objs.LatencyHist.Lookup(&key, &count)
		result[bucketLabels[i]] = count
	}

	return result
}

// PrintHistogram outputs a text histogram
func (h *LatencyHistogram) PrintHistogram() {
	hist := h.ReadHistogram()
	fmt.Println("\nHTTP Latency Distribution:")
	fmt.Println("──────────────────────────")

	var total uint64
	for _, label := range bucketLabels {
		total += hist[label]
	}

	for _, label := range bucketLabels {
		count := hist[label]
		pct := 0.0
		if total > 0 {
			pct = float64(count) / float64(total) * 100
		}
		bar := ""
		for range int(pct / 2) {
			bar += "█"
		}
		fmt.Printf("  %-12s │ %s %.1f%% (%d)\n", label, bar, pct, count)
	}
	fmt.Printf("\n  Total: %d requests\n", total)
}

// RunReporter periodically prints histogram
func (h *LatencyHistogram) RunReporter(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.PrintHistogram()
		}
	}
}

func (h *LatencyHistogram) Close() {
	h.kretprobe.Close()
	h.kprobe.Close()
	h.objs.Close()
}
```

### Junior → FAANG: HTTP Latency Tracing from the Kernel

The key insight of kernel-level HTTP latency tracing is that it captures time the application cannot see. When your Go HTTP server reports p99 latency of 5ms but users experience 50ms, the missing 45ms is in the kernel TCP stack, in NIC driver queues, or in interrupt coalescing. Attaching a kprobe to `tcp_sendmsg` and a kretprobe to its return captures the time from when the application hands bytes to the kernel to when the kernel finishes processing them. This is fundamentally different from application-level timing, which only measures from `http.ResponseWriter.Write` to function return.

The kprobe/kretprobe pair pattern requires storing the entry timestamp in a map keyed by thread ID or task pointer, then reading it on return. The first gap juniors hit is that kretprobes can fire in a different CPU context than the kprobe if the kernel function sleeps and is rescheduled. Using `bpf_get_current_task()` as the map key (the task struct pointer) is more reliable than PID for long-running kernel functions. Practice tracing `tcp_sendmsg` on a local nginx instance and verifying that the histogram buckets match expected latency ranges before moving to production.

A first-job habit for latency tracers: always add a counter for events that overflow the histogram range. If your histogram tops out at 1 second but you occasionally see 5-second sends (during TCP retransmission storms), the overflow counter tells you those events exist even though the histogram does not represent them. Missing high-latency outliers is a common bug in production tracers that makes p99 look better than reality.

Interview framing: "How would you identify which microservice is adding latency to an RPC chain without modifying any service code?" Describe kprobe-based tracing on kernel TCP functions, correlating by connection 4-tuple (src IP, dst IP, src port, dst port), with events emitted to a ring buffer and consumed by a Go aggregator that joins by connection tuple to reconstruct per-hop latency. This shows kernel-level thinking that most candidates miss.

### Senior @ FAANG: Production HTTP Latency Tracing at Scale

Kernel-level HTTP latency tracing at FAANG scale requires solving the cardinality problem. In a production fleet with thousands of services and millions of connections, a naive per-connection latency map fills up and starts evicting entries, silently discarding data. The solution is pre-aggregation in the eBPF program: bucket by destination port (proxy for service identity), compute histogram buckets in the kernel using an LRU hash map keyed by port, and emit only the aggregated histogram to user space on a timer. This reduces the ring buffer event rate by orders of magnitude while preserving the statistical shape of the latency distribution.

The kprobe on `tcp_sendmsg` is an unstable probe: `tcp_sendmsg` is an internal kernel symbol whose signature can change across kernel versions. CO-RE handles struct field access, but if the kernel renames or removes the function, the probe fails to attach silently unless you check the attach error. Platform teams maintain a list of stable tracepoints (`sock:inet_sock_set_state`, `tcp:tcp_retransmit_skb`) that provide similar information with a stable ABI, and use kprobes only when the tracepoint coverage is insufficient. Documenting this decision in an ADR prevents future engineers from unknowingly adding kprobes to functions with unstable signatures.

Correlating kernel-level latency with application-level traces requires a join key that exists in both domains. For HTTP/1.1, the socket file descriptor is available in both the kernel (via `bpf_get_current_task()` and the task's file table) and in the Go application (via `net.TCPConn.File()`). For HTTP/2 and gRPC, the stream ID is only in user space, requiring a uprobe on the application's stream multiplexer to inject the stream ID into a shared map that the kernel tracer can read. Designing this join is L6-level systems work that requires understanding both the kernel data structures and the application's connection management logic.

The histogram data structure choice matters for production accuracy. A fixed linear histogram (buckets at 0-1ms, 1-2ms, etc.) has poor resolution for multi-modal distributions. A DDSketch or t-digest, implemented in the eBPF program using pre-computed bucket boundaries stored in an array map, gives accurate percentile estimates with bounded memory regardless of the latency distribution shape. FAANG observability teams have built custom eBPF histogram types for exactly this reason, and understanding the tradeoffs is a bar-raiser interview signal.

Rollout of a new latency tracer must be zero-impact on the traced workload. The overhead of a kprobe is approximately 200-500 nanoseconds per invocation on modern hardware. On a service doing 100k req/s with 10 kernel function calls per request, that is 100-500 microseconds of added CPU time per second, or 0.01-0.05% CPU overhead. Measuring and documenting this overhead as part of the deployment ADR, and setting an automated alert if overhead exceeds 0.1%, is the production discipline that FAANG requires before any tracing tool goes to fleet.

---
