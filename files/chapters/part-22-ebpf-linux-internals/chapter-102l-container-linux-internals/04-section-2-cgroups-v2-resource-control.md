## Section 2: cgroups v2 Resource Control

cgroups v2 presents a unified hierarchy under `/sys/fs/cgroup`

### Junior → FAANG: cgroups v2 as a Production Debugging Tool

The most important immediate skill from this section is reading cgroup state files to diagnose resource-related container issues. When a container is OOM-killed, read `/sys/fs/cgroup/<pod-cgroup>/memory.events` (which contains a `oom_kill` counter) and `/sys/fs/cgroup/<pod-cgroup>/memory.stat` (which breaks down memory usage by category: anon, file, shmem, kernel). The `file` category often surprises engineers: it is the page cache for files the container has read or written, and it counts against the memory limit even though it is reclaimable. Containers that read large files can hit their memory limit from page cache, not from application data structures, and the fix is to either increase the limit or add `memory.pressure` monitoring and clear the cache proactively.

CPU throttling is the silent killer of latency-sensitive services. A container that is CPU-throttled 30% of the time has 30% of its time-slices withheld by the kernel's CFS bandwidth controller, which directly adds tail latency. Read `/sys/fs/cgroup/<pod-cgroup>/cpu.stat` and look at the `throttled_usec` field. If `throttled_usec / (throttled_usec + usage_usec)` exceeds 5-10%, the container's CPU limit is too low for its workload. First-job habit: add `cpu.stat:throttled_usec` as a dashboard metric for all production services and set an alert at 5% throttling ratio.

In interviews, cgroup v2 questions take the form: "A containerized service is reporting slow response times but the CPU utilization metric (from the application's perspective) looks normal. What would you investigate?" The answer mentions CPU throttling: the application's internal CPU metric measures time spent doing work, not time waiting for the kernel to schedule it. CFS throttling is invisible to the application but visible in `cpu.stat`. This answer demonstrates kernel-level thinking that distinguishes platform engineers from application engineers.

### Senior @ FAANG: cgroups v2 Platform Design and Capacity Engineering

cgroups v2's unified hierarchy enables a new category of resource governance that v1's per-controller hierarchies made difficult. With v2, the memory controller and CPU controller are co-located in the same cgroup directory, enabling consistent resource accounting across controllers. Platform teams use this to implement resource quotas at the namespace level (a Kubernetes namespace maps to a parent cgroup, with all pods in the namespace as children), enabling per-team resource governance without requiring admission webhooks for every pod.

The `memory.pressure`, `cpu.pressure`, and `io.pressure` files (from the PSI subsystem, Linux 4.20+) provide a standardized measure of resource contention that is more actionable than raw utilization. PSI measures the fraction of time that tasks are stalled waiting for a resource: a PSI memory value of 10% means 10% of runnable time is spent waiting for memory. Platform teams expose PSI metrics from all pods and use them for both alerting (page a human when PSI exceeds threshold) and auto-scaling signals (trigger horizontal pod autoscaler based on PSI rather than CPU utilization, which is a better predictor of user-visible latency degradation).

The `cpu.max` file syntax (`$MAX $PERIOD`) encodes the CFS bandwidth controller's quota. Setting `cpu.max` to `200000 100000` (200ms quota per 100ms period) allows the container to use up to 2 CPUs worth of CPU time per period, but in a bursty pattern. The key insight is that CFS quota is replenished every period boundary, so a container that uses all its quota in the first 10ms of a 100ms period is throttled for the remaining 90ms, even if other CPUs are idle. This is the source of CPU throttling at low utilization and is the reason FAANG platform teams use CPU limits conservatively: setting limits 3x above the average utilization rather than 1.1x, accepting lower packing efficiency in exchange for lower tail latency.

I/O resource control with `io.max` requires understanding the device major:minor number format and the correct parameter names (`rbps`, `wbps`, `riops`, `wiops`). At FAANG, I/O limits are applied to prevent noisy neighbor I/O from one pod degrading latency for collocated pods. The challenge is that I/O limits apply to the block device, not the filesystem, so a pod that writes to a tmpfs (RAM-backed filesystem) is not subject to I/O limits. Platform teams document which storage paths are subject to I/O throttling and which are not, and this documentation is part of the service's capacity planning process.

The cgroup v1 to v2 migration is a platform engineering project at organizations running older kernel versions. cgroups v2 requires kernel 4.5+ for the unified hierarchy and 5.0+ for all controllers including the memory controller. Kubernetes support for cgroups v2 is stable since 1.25. The migration requires coordinating with the kernel team on the kernel version upgrade, with the kubelet team on the `cgroupDriver: systemd` setting, and with all service teams to verify that their resource limits are still correctly applied in the v2 hierarchy. This coordination project, executed across a large fleet without a maintenance window, is the kind of L6-level platform work that spans quarters.

--- where every resource controller, CPU, memory, I/O, is configured by writing to files in a cgroup directory. Creating a cgroup means making a directory, writing a PID to `cgroup.procs`, then writing resource limits to files like `cpu.max` or `memory.max`. The Go implementation below provides a typed wrapper that computes the correct file paths and performs the necessary string formatting, making it straightforward to apply container resource limits programmatically without shelling out to `cgroupctl`.

```go
package cgroups

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const cgroupRoot = "/sys/fs/cgroup"

// CgroupConfig defines resource limits for a container
type CgroupConfig struct {
	Name string

	// CPU limits
	CPUQuotaUS  int64  // Quota in microseconds per period
	CPUPeriodUS int64  // Period in microseconds (default 100000 = 100ms)
	CPUWeight   uint64 // Relative weight (default 100)

	// Memory limits
	MemoryMaxBytes  int64 // Hard limit
	MemorySoftBytes int64 // Soft limit (swap pressure)
	OOMKillDisable  bool

	// IO limits (per device)
	IOMaxBytesPerSec int64  // Bytes per second
	IODevice         string // "major:minor" e.g. "8:0"

	// Process limits
	PIDsMax int64
}

// Cgroup manages a cgroup v2 hierarchy
type Cgroup struct {
	path string
	name string
}

// Create creates a new cgroup
func Create(name string) (*Cgroup, error) {
	path := filepath.Join(cgroupRoot, name)
	if err := os.MkdirAll(path, 0755); err != nil {
		return nil, fmt.Errorf("create cgroup %s: %w", name, err)
	}
	return &Cgroup{path: path, name: name}, nil
}

// Apply sets resource limits from config
func (c *Cgroup) Apply(cfg CgroupConfig) error {
	// CPU quota: "quota period" or "max period"
	if cfg.CPUQuotaUS > 0 {
		period := cfg.CPUPeriodUS
		if period == 0 {
			period = 100000
		}
		if err := c.write("cpu.max",
			fmt.Sprintf("%d %d", cfg.CPUQuotaUS, period)); err != nil {
			return fmt.Errorf("set cpu.max: %w", err)
		}
	}

	// CPU weight
	if cfg.CPUWeight > 0 {
		if err := c.write("cpu.weight", strconv.FormatUint(cfg.CPUWeight, 10)); err != nil {
			return fmt.Errorf("set cpu.weight: %w", err)
		}
	}

	// Memory hard limit
	if cfg.MemoryMaxBytes > 0 {
		if err := c.write("memory.max",
			strconv.FormatInt(cfg.MemoryMaxBytes, 10)); err != nil {
			return fmt.Errorf("set memory.max: %w", err)
		}
	}

	// Memory soft limit
	if cfg.MemorySoftBytes > 0 {
		if err := c.write("memory.low",
			strconv.FormatInt(cfg.MemorySoftBytes, 10)); err != nil {
			return fmt.Errorf("set memory.low: %w", err)
		}
	}

	// IO rate limit
	if cfg.IODevice != "" && cfg.IOMaxBytesPerSec > 0 {
		// Format: "major:minor rbps=N wbps=N"
		ioMax := fmt.Sprintf("%s rbps=%d wbps=%d",
			cfg.IODevice, cfg.IOMaxBytesPerSec, cfg.IOMaxBytesPerSec)
		if err := c.write("io.max", ioMax); err != nil {
			return fmt.Errorf("set io.max: %w", err)
		}
	}

	// PID limit
	if cfg.PIDsMax > 0 {
		if err := c.write("pids.max",
			strconv.FormatInt(cfg.PIDsMax, 10)); err != nil {
			return fmt.Errorf("set pids.max: %w", err)
		}
	}

	return nil
}

// AddPID adds a process to this cgroup
func (c *Cgroup) AddPID(pid int) error {
	return c.write("cgroup.procs", strconv.Itoa(pid))
}

// AddCurrentProcess adds the current process to this cgroup
func (c *Cgroup) AddCurrentProcess() error {
	return c.AddPID(os.Getpid())
}

// Stats returns current resource usage
func (c *Cgroup) Stats() (*CgroupStats, error) {
	stats := &CgroupStats{}

	// Read memory usage
	memCurrent, err := c.readInt("memory.current")
	if err == nil {
		stats.MemoryCurrentBytes = memCurrent
	}

	// Read CPU stats
	cpuStatData, err := c.readFile("cpu.stat")
	if err == nil {
		stats.CPUStat = parseCPUStat(cpuStatData)
	}

	// Read PIDs
	pids, err := c.readInt("pids.current")
	if err == nil {
		stats.CurrentPIDs = int(pids)
	}

	return stats, nil
}

// Delete removes the cgroup (must have no processes)
func (c *Cgroup) Delete() error {
	return os.Remove(c.path)
}

type CgroupStats struct {
	MemoryCurrentBytes int64
	MemoryMaxBytes     int64
	CPUStat            map[string]int64
	CurrentPIDs        int
}

func (c *Cgroup) write(file, content string) error {
	path := filepath.Join(c.path, file)
	return os.WriteFile(path, []byte(content+"\n"), 0644)
}

func (c *Cgroup) readFile(file string) (string, error) {
	path := filepath.Join(c.path, file)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

func (c *Cgroup) readInt(file string) (int64, error) {
	data, err := c.readFile(file)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(data, 10, 64)
}

func parseCPUStat(data string) map[string]int64 {
	result := make(map[string]int64)
	for _, line := range strings.Split(data, "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 {
			if v, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
				result[parts[0]] = v
			}
		}
	}
	return result
}
```

---
