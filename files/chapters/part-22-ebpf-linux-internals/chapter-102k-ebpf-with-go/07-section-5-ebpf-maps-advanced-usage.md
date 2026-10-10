## Section 5: eBPF Maps - Advanced Usage

eBPF maps are the primary data structures shared between kernel-side eBPF programs and userspace Go code, supporting hash maps, arrays, ring buffers, per-CPU variants, and LRU caches. Selecting the right map type has a significant impact on performance: per-CPU maps avoid atomic increments for counters, LRU hash maps automatically evict stale entries for connection tracking without a dedicated cleanup goroutine, and ring buffers deliver variable-length events with lower overhead than the older perf array interface.

```go
package ebpfmaps

import (
	"fmt"
	"unsafe"

	"github.com/cilium/ebpf"
)

// LRUHashMap demonstrates LRU map for connection tracking
type ConnectionTracker struct {
	connMap *ebpf.Map
}

type ConnectionKey struct {
	SrcIP   uint32
	DstIP   uint32
	SrcPort uint16
	DstPort uint16
}

type ConnectionValue struct {
	Packets  uint64
	Bytes    uint64
	LastSeen uint64 // nanoseconds
}

func NewConnectionTracker(maxEntries uint32) (*ConnectionTracker, error) {
	m, err := ebpf.NewMap(&ebpf.MapSpec{
		Type:       ebpf.LRUHash,
		KeySize:    uint32(unsafe.Sizeof(ConnectionKey{})),
		ValueSize:  uint32(unsafe.Sizeof(ConnectionValue{})),
		MaxEntries: maxEntries,
	})
	if err != nil {
		return nil, err
	}
	return &ConnectionTracker{connMap: m}, nil
}

func (ct *ConnectionTracker) Update(key ConnectionKey, packets, bytes uint64, ts uint64) error {
	var existing ConnectionValue
	if err := ct.connMap.Lookup(&key, &existing); err == nil {
		// Update existing entry
		existing.Packets += packets
		existing.Bytes += bytes
		existing.LastSeen = ts
		return ct.connMap.Put(&key, &existing)
	}
	// New entry
	return ct.connMap.Put(&key, &ConnectionValue{
		Packets: packets, Bytes: bytes, LastSeen: ts,
	})
}

func (ct *ConnectionTracker) Close() { ct.connMap.Close() }

// StackTraceMap for flame graph generation
type StackTracer struct {
	stackMap *ebpf.Map
	countMap *ebpf.Map
}

func NewStackTracer() (*StackTracer, error) {
	// Stack trace map: 8192 entries, 127 frames each
	stackMap, err := ebpf.NewMap(&ebpf.MapSpec{
		Type:       ebpf.StackTrace,
		KeySize:    4,
		ValueSize:  127 * 8, // 127 uint64 addresses
		MaxEntries: 8192,
	})
	if err != nil {
		return nil, err
	}

	countMap, err := ebpf.NewMap(&ebpf.MapSpec{
		Type:       ebpf.Hash,
		KeySize:    4, // stack ID
		ValueSize:  8, // count
		MaxEntries: 8192,
	})
	if err != nil {
		stackMap.Close()
		return nil, err
	}

	return &StackTracer{stackMap: stackMap, countMap: countMap}, nil
}

// ReadStacks returns stack traces with their occurrence counts
func (st *StackTracer) ReadStacks() map[uint32][]uint64 {
	result := make(map[uint32][]uint64)

	var key uint32
	var count uint64
	iter := st.countMap.Iterate()
	for iter.Next(&key, &count) {
		// Look up the actual stack frames
		var frames [127]uint64
		if err := st.stackMap.Lookup(&key, &frames); err == nil {
			// Trim zero frames
			end := 0
			for i := len(frames) - 1; i >= 0; i-- {
				if frames[i] != 0 {
					end = i + 1
					break
				}
			}
			result[key] = frames[:end]
		}
	}
	return result
}

func (st *StackTracer) Close() {
	st.countMap.Close()
	st.stackMap.Close()
}

// BTF-based map pinning for persistence across program restarts
func PinnedMap(pinPath string, spec *ebpf.MapSpec) (*ebpf.Map, error) {
	// Try to load existing pinned map
	m, err := ebpf.LoadPinnedMap(pinPath, nil)
	if err == nil {
		fmt.Printf("loaded pinned map from %s\n", pinPath)
		return m, nil
	}

	// Create new map and pin it
	m, err = ebpf.NewMap(spec)
	if err != nil {
		return nil, fmt.Errorf("create map: %w", err)
	}

	if err := m.Pin(pinPath); err != nil {
		m.Close()
		return nil, fmt.Errorf("pin map: %w", err)
	}

	fmt.Printf("created and pinned map at %s\n", pinPath)
	return m, nil
}
```

### Junior → FAANG: Understanding eBPF Map Types and When to Use Each

The map type decision is the first architectural choice in any eBPF program, and choosing the wrong type causes correctness bugs under load that are hard to diagnose. The decision tree: if you are counting events per CPU with no need to read intermediate totals frequently, use `BPF_MAP_TYPE_PERCPU_ARRAY` or `BPF_MAP_TYPE_PERCPU_HASH`. If you are tracking active connections or sessions that appear and disappear, use `BPF_MAP_TYPE_LRU_HASH`. If you are streaming variable-length events to user space, use `BPF_MAP_TYPE_RINGBUF` (kernel 5.8+) or `BPF_MAP_TYPE_PERF_EVENT_ARRAY` for older kernels. If you are storing configuration or policy that the eBPF program reads but user space writes, use `BPF_MAP_TYPE_ARRAY` for fixed keys or `BPF_MAP_TYPE_HASH` for dynamic keys.

The per-CPU aggregation pattern is the most important map usage pattern to master. A `BPF_MAP_TYPE_PERCPU_HASH` stores a separate copy of each value for every CPU. The eBPF program reads and writes its per-CPU slot without any atomic operation, which is significantly faster than a global counter with spinlock. The Go consumer reads the map with `Map.Lookup`, which returns a slice of values (one per CPU), and sums them. The common mistake is not summing across CPUs and reading only the value for CPU 0, which gives wildly incorrect counts on multi-core systems.

First-job habit: when using `BPF_MAP_TYPE_LRU_HASH` for connection tracking, always instrument the eviction rate. When the map evicts an active entry, the next access for that connection fails to find its state, causing a correctness gap. Add a separate global counter that the eBPF program increments when `bpf_map_lookup_elem` returns NULL for a key that should exist (you can detect this by checking a secondary flag), and alert when the eviction rate exceeds a threshold. This converts a silent correctness bug into a visible operational signal.

Interview framing: "What is the difference between `BPF_MAP_TYPE_HASH` and `BPF_MAP_TYPE_LRU_HASH`?" The answer must include: LRU_HASH automatically evicts the least recently used entry when the map is full, avoiding `ENOSPC` errors but potentially discarding active entries. This makes it correct for connection tracking (where old inactive entries should naturally be displaced) but wrong for configuration storage (where no entry should ever be silently lost).

### Senior @ FAANG: Map Design for Production eBPF Systems

Map schema design is an API design problem with the same considerations as database schema design: correctness, performance, versioning, and observability. At the senior level, map schemas are treated as versioned contracts. When the key or value struct changes, the Go consumer must be updated atomically with the eBPF program. The mechanism is the same as a gRPC proto update: add a version field to the value struct, handle both old and new formats in the Go consumer during the transition window, and enforce the schema with generated code from `bpf2go`.

Map pinning strategy is a production design decision with availability implications. Pinned maps (`/sys/fs/bpf/<name>`) persist after the loading process exits, allowing a new version of the loader to inherit the existing map contents rather than starting from zero. This is critical for connection tracking maps: if you reinitialize the map on every deployment, all active connection state is lost, causing TCP flows to drop. Platform teams implement map pinning for stateful maps and document the pin path conventions in the platform's operational runbook.

Map memory accounting matters at scale. Each map entry consumes kernel memory proportional to `key_size + value_size + overhead`. A 1-million-entry LRU hash with 16-byte keys and 64-byte values consumes roughly 80 MB of kernel memory per node. Across a 10,000-node fleet, that is 800 GB of kernel memory for a single map. Platform teams model the memory footprint of eBPF maps alongside application memory in capacity planning, and set `max_entries` conservatively with an alert when fill rate exceeds 80%.

The ring buffer flow control design is critical for high-throughput event pipelines. When the Go consumer is slow (due to downstream backpressure from the metrics pipeline or storage system), the ring buffer fills and subsequent `bpf_ringbuf_reserve` calls return NULL. The eBPF program must handle this gracefully by incrementing a drop counter and not blocking. The Go consumer must expose the drop counter as a metric, with an alert that fires when the drop rate exceeds a threshold. This alert is the signal to either scale up the consumer or reduce the event emission rate in the eBPF program by adjusting the sampling rate stored in a control map.

Batch map operations (using `Map.BatchLookup` and `Map.BatchUpdate` in `cilium/ebpf`) are essential for performance when the Go consumer needs to read or write many entries. Reading a 100k-entry map one entry at a time requires 100k `bpf()` syscalls. Reading it with a batch size of 1000 requires 100 syscalls. At FAANG polling intervals of 1 second, the difference is visible in CPU profiles of the control plane. Platform teams standardize on batch operations for all map reads and writes above 1000 entries.

---
