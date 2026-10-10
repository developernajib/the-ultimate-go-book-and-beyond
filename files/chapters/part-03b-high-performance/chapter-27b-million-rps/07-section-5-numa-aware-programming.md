## Section 5: NUMA-Aware Programming

### 5.1 NUMA Topology Discovery

On multi-socket servers, NUMA (Non-Uniform Memory Access) means memory attached to another socket costs more to reach, because the access crosses the CPU interconnect. How much more is a property of your specific hardware, and `numactl --hardware` prints the vendor's own distance matrix for it, so there is no reason to rely on a remembered ratio. Discovering the topology at startup (reading `/sys/devices/system/node/` on Linux) lets an application pin worker pools to nodes and allocate buffers from local memory.

> **Senior track**: Go does not expose NUMA pinning in its runtime. The M:P:G scheduler treats all OS threads uniformly and the memory allocator (mcache/mcentral/mheap) is not NUMA-aware. The practical pattern for a NUMA-aware Go service is one of: (1) run one Go process per NUMA node, launched under `numactl --cpunodebind=N --membind=N`, and load-balance across them with `SO_REUSEPORT`, or (2) restrict the whole process to one node via cpuset/cgroups and use a second process for the second socket. (3) use `unix.SchedSetaffinity` on the calling OS thread (after `runtime.LockOSThread`) for worker goroutines that own long-lived buffers. The code below parses topology so you can script approach (1) or (3) from inside Go. It does not make the allocator NUMA-aware.

```go
package numa

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Topology represents the NUMA topology of the machine.
type Topology struct {
	Nodes     []Node
	NumNodes  int
	NumCPUs   int
}

// Node represents a NUMA node with its CPUs and memory.
type Node struct {
	ID       int
	CPUs     []int
	MemTotal uint64 // bytes
	MemFree  uint64 // bytes
}

// DiscoverTopology reads NUMA topology from /sys.
func DiscoverTopology() (*Topology, error) {
	entries, err := os.ReadDir("/sys/devices/system/node")
	if err != nil {
		return nil, fmt.Errorf("read numa nodes: %w", err)
	}

	var topo Topology
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "node") {
			continue
		}
		nodeID, err := strconv.Atoi(e.Name()[4:])
		if err != nil {
			continue
		}

		node := Node{ID: nodeID}

		// Read CPU list for this node.
		cpuListPath := fmt.Sprintf("/sys/devices/system/node/node%d/cpulist", nodeID)
		cpuList, err := os.ReadFile(cpuListPath)
		if err == nil {
			node.CPUs = parseCPUList(strings.TrimSpace(string(cpuList)))
		}

		// Read memory info.
		memInfoPath := fmt.Sprintf("/sys/devices/system/node/node%d/meminfo", nodeID)
		memInfo, err := os.ReadFile(memInfoPath)
		if err == nil {
			node.MemTotal, node.MemFree = parseMemInfo(string(memInfo))
		}

		topo.Nodes = append(topo.Nodes, node)
		topo.NumCPUs += len(node.CPUs)
	}
	topo.NumNodes = len(topo.Nodes)
	return &topo, nil
}

// parseCPUList parses "0-3,8-11" into [0,1,2,3,8,9,10,11].
func parseCPUList(s string) []int {
	var cpus []int
	for _, part := range strings.Split(s, ",") {
		if dash := strings.Index(part, "-"); dash >= 0 {
			start, _ := strconv.Atoi(part[:dash])
			end, _ := strconv.Atoi(part[dash+1:])
			for i := start; i <= end; i++ {
				cpus = append(cpus, i)
			}
		} else {
			n, _ := strconv.Atoi(part)
			cpus = append(cpus, n)
		}
	}
	return cpus
}

func parseMemInfo(s string) (total, free uint64) {
	for _, line := range strings.Split(s, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		val, _ := strconv.ParseUint(fields[3], 10, 64)
		val *= 1024 // kB → bytes
		if strings.Contains(fields[2], "MemTotal") {
			total = val
		} else if strings.Contains(fields[2], "MemFree") {
			free = val
		}
	}
	return
}
```

### 5.2 NUMA-Aware Memory Allocator

A NUMA-aware allocator pre-allocates an arena per NUMA node and serves allocations from the arena local to the calling thread, keeping memory traffic off the interconnect.

Be honest about what Go can and cannot do here, because this is where NUMA articles start describing code that does not exist. Go's allocator has no concept of NUMA nodes, and there is no supported way to tell `make([]byte, n)` which node to use. The arena below relies on Linux's **first-touch** policy: a page is physically allocated on the node of the CPU that first writes to it. That gives you node-local memory only if the goroutine doing the touching is actually running on that node, which requires `runtime.LockOSThread` plus `sched_setaffinity`, and which the code makes explicit rather than assuming.

The alternative, and the one most production systems actually use, is to keep NUMA out of the process entirely: run one process per node under `numactl --cpunodebind=N --membind=N` and let the kernel enforce the binding. That is less clever and far more reliable.

```go
package numa

import (
	"log"
	"os"
	"reflect"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Arena is a bump allocator over one slab of bytes.
//
// It becomes NUMA-local only if NewArena is called from a thread already
// pinned to the target node. The type cannot verify that, so the nodeID
// field is documentation of intent, not a guarantee. Do not read this
// type as "memory on node N" just because you passed N.
type Arena struct {
	nodeID int // Intended node. Enforced by the CALLER, not by this type.
	slab   []byte
	offset int
	mu     sync.Mutex
}

// NewArena allocates an arena intended for the given NUMA node.
//
// CONTRACT: the calling goroutine must already be locked to an OS thread
// whose CPU affinity is restricted to nodeID's CPUs. Otherwise first-touch
// places these pages on whatever node the caller happens to be running on,
// and you get a struct labelled "node 1" backed by node 0 memory, which is
// worse than no NUMA awareness at all because it is confidently wrong.
//
//	runtime.LockOSThread()
//	unix.SchedSetaffinity(0, &cpuSetForNode)
//	arena, err := NewArena(nodeID, size)
//
// size should be a multiple of the hugepage size (2MB) for best results.
func NewArena(nodeID, size int) (*Arena, error) {
	slab := make([]byte, size)

	// Touch one byte per page to force physical allocation NOW, on this
	// thread's node, under Linux's first-touch policy. Without this the
	// pages are virtual only, and each page would be faulted in later on
	// whichever node happened to touch it first, which is exactly the
	// scattering this arena exists to prevent.
	//
	// Use the real page size rather than assuming 4096: this code also
	// runs on arm64 systems configured with 16KB or 64KB pages, where a
	// hardcoded 4096 does 4x to 16x more work than necessary.
	pageSize := os.Getpagesize()
	for i := 0; i < len(slab); i += pageSize {
		slab[i] = 0
	}

	return &Arena{nodeID: nodeID, slab: slab}, nil
}

// Alloc allocates n bytes from the arena. Returns nil if no space is left.
// Safe for concurrent use: the mutex below guards offset.
func (a *Arena) Alloc(n int) []byte {
	// Align to 8 bytes so that values placed here meet the alignment
	// requirements of any 64-bit type.
	aligned := (n + 7) &^ 7

	a.mu.Lock()
	defer a.mu.Unlock()

	if a.offset+aligned > len(a.slab) {
		return nil
	}

	// Three-index slice: cap the returned slice at exactly n bytes.
	// Without the third index, cap would run to the end of the slab, and
	// a caller doing append(buf, ...) would silently overwrite the NEXT
	// allocation instead of copying. That is a memory-corruption bug that
	// only appears under load, and it is the single most common defect in
	// hand-written arena code.
	end := a.offset + n
	buf := a.slab[a.offset:end:end]
	a.offset += aligned
	return buf
}

// AllocT allocates a T from the arena.
//
// DANGER, read before using. The slab is a []byte, so as far as the
// garbage collector is concerned it contains no pointers and is never
// scanned for them. If T contains ANY pointer (a string, a slice, a map,
// an interface, or a *U), then a pointer stored into an arena-allocated T
// is invisible to the collector. The object it points to can be freed
// while your T still references it, and you get a use-after-free: memory
// corruption, not a panic, surfacing far from the cause.
//
// So this is safe ONLY for pointer-free T. Enforce it at construction
// with a check the compiler cannot do for you, and prefer to keep arenas
// for byte buffers where this question never arises.
func AllocT[T any](a *Arena) *T {
	var zero T
	if hasPointers(reflect.TypeOf(zero)) {
		panic("numa: AllocT requires a pointer-free type, " +
			"otherwise the GC cannot see pointers stored in the arena")
	}
	size := int(unsafe.Sizeof(zero))
	buf := a.Alloc(size)
	if buf == nil {
		return nil
	}
	return (*T)(unsafe.Pointer(unsafe.SliceData(buf)))
}

// hasPointers reports whether t contains any pointer the GC would need to
// track. Call it once at setup, never on a hot path.
func hasPointers(t reflect.Type) bool {
	if t == nil {
		return true // Unknown, assume the unsafe answer.
	}
	switch t.Kind() {
	case reflect.Bool,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32,
		reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64,
		reflect.Complex64, reflect.Complex128:
		return false
	case reflect.Array:
		return hasPointers(t.Elem())
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			if hasPointers(t.Field(i).Type) {
				return true
			}
		}
		return false
	default:
		// Pointer, String, Slice, Map, Chan, Func, Interface, UnsafePointer.
		return true
	}
}

// Reset resets the arena, reclaiming all memory.
// Invalidates all previously allocated pointers.
func (a *Arena) Reset() {
	a.mu.Lock()
	a.offset = 0
	a.mu.Unlock()
}

// NUMAWorkerPool runs workers pinned to specific NUMA nodes.
type NUMAWorkerPool struct {
	nodes   []NUMAWorker
	current int
}

// NUMAWorker is a worker pinned to a NUMA node.
type NUMAWorker struct {
	nodeID int
	cpus   []int // CPUs belonging to nodeID, from the topology.
	arena  *Arena
	queue  chan func(*Arena)
}

func NewNUMAWorkerPool(topo *Topology, arenaSize int) (*NUMAWorkerPool, error) {
	pool := &NUMAWorkerPool{}
	for _, node := range topo.Nodes {
		arena, err := NewArena(node.ID, arenaSize)
		if err != nil {
			return nil, err
		}
		w := NUMAWorker{
			nodeID: node.ID,
			arena:  arena,
			cpus:   node.CPUs,
			queue:  make(chan func(*Arena), 1024),
		}
		go w.run()
		pool.nodes = append(pool.nodes, w)
	}
	return pool, nil
}

// run pins this worker to its node's CPUs, then serves tasks.
//
// Both steps are mandatory and neither is optional decoration. LockOSThread
// ties this goroutine to one M so the affinity we set cannot be undone by
// the goroutine migrating to another thread. SchedSetaffinity then confines
// that thread to this node's CPUs. Skip either and the "NUMA worker" is
// just a worker with a nodeID field, running wherever the kernel likes,
// touching whatever memory it likes.
//
// A "TODO: pin this later" in this function is not an incomplete
// optimization. It invalidates the entire premise of the type.
func (w *NUMAWorker) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	var set unix.CPUSet
	set.Zero()
	for _, cpu := range w.cpus {
		set.Set(cpu)
	}
	// Pid 0 means the calling thread, which is why LockOSThread must come
	// first.
	if err := unix.SchedSetaffinity(0, &set); err != nil {
		// Do not silently continue as though pinning succeeded. In a
		// container without CAP_SYS_NICE this fails, and a caller that
		// believes it has node-local memory when it does not will draw
		// wrong conclusions from every benchmark that follows.
		log.Printf("numa: pinning worker to node %d failed: %v "+
			"(falling back to unpinned, NUMA locality NOT guaranteed)",
			w.nodeID, err)
	}

	for task := range w.queue {
		task(w.arena)
		// Arena is reset between batches, not per-task.
	}
}

// Submit submits a task to a NUMA node's worker (round-robin).
func (p *NUMAWorkerPool) Submit(task func(*Arena)) bool {
	idx := p.current % len(p.nodes)
	p.current++
	select {
	case p.nodes[idx].queue <- task:
		return true
	default:
		return false
	}
}
```

### 5.3 When NUMA matters and when it does not

Start with the check that makes the rest of this section unnecessary for most readers:

```bash
numactl --hardware   # or: lscpu | grep -i numa
```

If it reports a single node, NUMA tuning has **exactly zero** effect on your service and every hour spent on it is wasted. There is no remote memory to avoid. Delete it from the optimization plan and move on. Small and mid-size cloud instances are frequently single-node, and some providers do not expose multi-socket topology to tenants at all, so this check disqualifies a large fraction of deployments in about two seconds.

If it reports multiple nodes, the ceiling is real but narrower than folklore suggests. The `node distances` matrix that `numactl --hardware` prints is the honest local answer: it gives the relative cost of reaching each node from each other node, where 10 conventionally means local. That table is measured for your hardware, which is worth more than any ratio quoted in a book, including this one. Remote access is meaningfully slower than local, and it is not a different universe of slow.

Even on multi-socket hardware, most Go services are CPU-bound in user code (JSON, TLS, crypto, business logic) rather than memory-bandwidth-bound, and for those NUMA work is close to noise. The workloads where it genuinely pays are the memory-bound ones: large in-memory caches and KV stores, in-process analytical engines, and packet processing where the NIC DMAs into memory that a consumer must then touch.

The way to know which camp you are in is to measure, not to guess. `perf stat -e cache-misses,LLC-load-misses` tells you whether you are missing cache at all, and if LLC misses are not a significant share of your cycles, memory locality is not your problem and NUMA pinning cannot help you.

Even when the topology is multi-socket, most Go services are CPU-bound on user code (JSON parse, TLS, crypto) rather than memory-bound, and NUMA tuning moves the needle by 5 percent or less. The workloads where NUMA tuning matters are the ones where memory bandwidth is the bottleneck: large in-memory caches (Redis-like KV stores, analytical in-process engines), packet processing where the NIC DMAs into memory that the consumer goroutine must then touch, and anything with large working sets that exceed L3 cache. If your service is not in one of those buckets, prefer simple horizontal scaling on smaller single-socket nodes over NUMA-pinned processes on large dual-socket boxes. The operational simplicity is worth more than the marginal throughput.

### 5.4 Junior → FAANG: the systems knowledge worth learning here

Even if you never write NUMA-aware code, the concepts compound. Understand the memory hierarchy (registers, L1, L2, L3, DRAM, NUMA-remote DRAM, NVMe, remote network), memorize the rough latency numbers, and internalize cache line semantics (64 bytes on x86-64, false sharing when two hot variables from different goroutines land in the same line). Read the output of `lscpu`, `numactl --hardware`, `cat /proc/cpuinfo`, and `lstopo`. Know how to spot a cache-miss-bound workload using `perf stat -e cache-references,cache-misses,LLC-load-misses`. This systems fluency shows up in every senior-plus systems interview at FAANG, and even when you work at higher abstraction layers you will make better decisions about batch sizes, struct layout, and data locality.

### 5.5 Senior @ FAANG: the hidden cost of one-process-per-NUMA-node

The clean architectural pattern is "one process per NUMA node, SO_REUSEPORT binds them, numactl pins them." It works, and production systems at Cloudflare, Meta, and AWS use it. But it doubles operational surface: two process IDs to monitor, two log streams to join, two crash reports to triage, two sets of goroutine pools to size, two pprof endpoints to remember, graceful-shutdown that must coordinate across both. As a staff engineer, weigh this against the alternative of just running two smaller single-socket VMs. On public cloud the economics usually favor small single-socket VMs. On bare metal where hardware is already sunk cost, dual-process is often cheaper. Document the decision, include the operational-cost side, and revisit it yearly. What was right at purchase time often stops being right after hardware refresh.

---
