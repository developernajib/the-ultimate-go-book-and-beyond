## Section 5: GC-Friendly Data Structures

### 5.1 Off-Heap Storage

Allocating large data stores, caches, arenas, columnar buffers, outside the Go heap removes them from the GC's scan and sweep scope, eliminating the pause time contribution of large heaps while keeping the data accessible from Go code via unsafe pointers. The `mmap` syscall is the standard mechanism for off-heap allocation, and the resulting memory must be manually freed on shutdown since the GC will not reclaim it. The implementation below wraps off-heap allocation in a typed `Arena` struct with an explicit `Free` cleanup path, the pattern for keeping a multi-gigabyte cache out of the GC's scan scope.

```go
//go:build linux || darwin

package offheap

import (
	"fmt"
	"sync"
	"syscall"
	"unsafe"
)

// OffHeapArena allocates memory outside the Go heap using mmap.
// Memory returned here is NOT scanned by the GC, NOT counted in the heap
// profile, and NOT counted against GOMEMLIMIT. Use for large buffers
// (multiple MB and up) that contain no Go pointers.
//
// WARNING: this memory is managed manually. A missed Free is a leak that
// the GC cannot save you from, and it is invisible in pprof.
//
// This calls mmap for real. That matters: a version of this type that
// quietly called make([]byte, n) would allocate on the Go heap, where the
// memory is scanned, profiled, and counted, which is the exact opposite of
// every claim in this comment. If you adapt this code, keep the syscall.
// An "off-heap" arena backed by make() is just a slice with a scary name.
type OffHeapArena struct {
	mu    sync.Mutex
	slabs [][]byte
	total int64
}

// Alloc allocates n bytes of off-heap memory.
// The returned slice is NOT managed by the GC.
func (a *OffHeapArena) Alloc(n int) ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	slab, err := allocOffHeap(n)
	if err != nil {
		return nil, fmt.Errorf("offheap: alloc %d bytes: %w", n, err)
	}
	a.slabs = append(a.slabs, slab)
	a.total += int64(n)
	return slab, nil
}

// Free releases all off-heap memory. After Free, every slice previously
// returned by Alloc points at unmapped memory, and touching one is a
// segfault rather than a panic the runtime can report. Lifetime is the
// caller's problem now.
func (a *OffHeapArena) Free() error {
	a.mu.Lock()
	defer a.mu.Unlock()

	var firstErr error
	for _, slab := range a.slabs {
		if err := freeOffHeap(slab); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	a.slabs = nil
	a.total = 0
	return firstErr
}

// Total reports bytes currently mapped. Export this to your metrics: it is
// the only way this memory shows up on a dashboard, since the runtime does
// not know it exists.
func (a *OffHeapArena) Total() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.total
}

// allocOffHeap maps anonymous memory outside the Go heap.
// fd is -1 with MAP_ANON: no file, just pages from the kernel.
func allocOffHeap(n int) ([]byte, error) {
	return syscall.Mmap(-1, 0, n,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_ANON|syscall.MAP_PRIVATE)
}

func freeOffHeap(b []byte) error {
	return syscall.Munmap(b)
}

// NoCopyStringTable stores strings without Go pointers in hot path.
// Uses a single large []byte slab with offsets, avoiding per-string allocs.
type NoCopyStringTable struct {
	data    []byte
	offsets []int32 // Start offset of each string.
	lengths []int32 // Length of each string.
}

func NewNoCopyStringTable(capacity int) *NoCopyStringTable {
	return &NoCopyStringTable{
		data:    make([]byte, 0, capacity),
		offsets: make([]int32, 0, 1024),
		lengths: make([]int32, 0, 1024),
	}
}

// Add stores a string and returns its index.
func (t *NoCopyStringTable) Add(s string) int {
	offset := int32(len(t.data))
	t.data = append(t.data, s...)
	t.offsets = append(t.offsets, offset)
	t.lengths = append(t.lengths, int32(len(s)))
	return len(t.offsets) - 1
}

// Get retrieves a string by index WITHOUT allocation.
//
// The returned string aliases the table's backing array. Go strings are
// immutable by contract and this one is not, so the table must be treated
// as append-only after the first Get. Mutating t.data in place would
// change the contents of strings already handed out, which is a bug the
// type system cannot catch for you here.
func (t *NoCopyStringTable) Get(idx int) string {
	offset := t.offsets[idx]
	length := t.lengths[idx]
	// Zero-copy string from byte slice.
	return unsafe.String(unsafe.SliceData(t.data[offset:]), length)
}

// Size returns the number of stored strings.
func (t *NoCopyStringTable) Size() int {
	return len(t.offsets)
}

// FlatMap stores map[K][]int32 as one flat values array plus an index.
// A plain map[K][]int32 with N keys gives the GC N separate backing arrays
// to track. This gives it one, regardless of how many keys there are.
//
// Design note worth internalising, because the obvious version of this is
// subtly wrong. A tempting shortcut is to store only a start offset per
// key and derive each length from "the next key's offset." That works
// exactly until the first overwrite or delete, at which point the values
// array is no longer in key order, every derived length is garbage, and
// Get panics with a slice bounds error. Store the length explicitly. One
// extra int32 per key buys a structure whose invariants survive mutation.
type entry struct {
	offset int32
	length int32
}

type FlatMap[K comparable] struct {
	index  map[K]entry
	values []int32
	dead   int32 // Values stranded by overwrite/delete, reclaimed by Compact.
}

func NewFlatMap[K comparable](capacity int) *FlatMap[K] {
	return &FlatMap[K]{
		index:  make(map[K]entry, capacity),
		values: make([]int32, 0, capacity*4),
	}
}

func (m *FlatMap[K]) Set(key K, values []int32) {
	if old, ok := m.index[key]; ok {
		// Shrinking or same size: overwrite in place, no growth at all.
		if int(old.length) >= len(values) {
			copy(m.values[old.offset:], values)
			m.dead += old.length - int32(len(values))
			m.index[key] = entry{offset: old.offset, length: int32(len(values))}
			return
		}
		// Growing: the old run cannot be extended without shifting every
		// later run, so strand it and append. This trades memory for O(1)
		// writes, which is why Compact exists.
		m.dead += old.length
	}
	m.index[key] = entry{offset: int32(len(m.values)), length: int32(len(values))}
	m.values = append(m.values, values...)
}

// Get returns a view into the flat array with NO allocation.
//
// The three-index slice caps capacity at the run length, so a caller doing
// append(v, x) is forced to copy instead of silently scribbling over the
// next key's values. Without that cap this returns a footgun.
func (m *FlatMap[K]) Get(key K) ([]int32, bool) {
	e, ok := m.index[key]
	if !ok {
		return nil, false
	}
	end := e.offset + e.length
	return m.values[e.offset:end:end], true
}

func (m *FlatMap[K]) Delete(key K) {
	if e, ok := m.index[key]; ok {
		m.dead += e.length
		delete(m.index, key)
	}
}

// Compact reclaims stranded values. Call it when dead grows past some
// fraction of len(values), not on every write. It invalidates every slice
// previously returned by Get.
func (m *FlatMap[K]) Compact() {
	if m.dead == 0 {
		return
	}
	vals := make([]int32, 0, len(m.values)-int(m.dead))
	for k, e := range m.index {
		off := int32(len(vals))
		vals = append(vals, m.values[e.offset:e.offset+e.length]...)
		m.index[k] = entry{offset: off, length: e.length}
	}
	m.values = vals
	m.dead = 0
}
```

### 5.2 Reduce Pointer Density

Every pointer in a heap-allocated struct is a potential GC scan edge. A struct with 10 pointer fields requires the GC to follow 10 pointers during the mark phase, multiplying scan work proportionally to object count. Replacing pointer fields with integer indices into a flat slice, embedding value types instead of pointing to them, and using `[16]byte` arrays for fixed-size IDs instead of `string` all reduce pointer density and GC scan time. The before-and-after struct designs below show how to restructure a message type from high-pointer to low-pointer layout without losing functionality.

> **Senior track, built-in maps since Go 1.24**: the runtime switched from the classic chained-bucket `hmap`/`bmap` to **Swiss Tables**. Each group holds 8 slots plus a 64-bit control word. When probing a key, the runtime hashes it and splits the hash into `h1` (the upper 57 bits, which picks the group) and `h2` (the low 7 bits, stored as that slot's control byte). It then tests all 8 control bytes at once and only falls back to a full key comparison on a hit.
>
> Be careful with how that last step is described, because it is the detail interviewers use to separate people who read the source from people who read a summary. Go does **not** use vector SIMD instructions here. It uses **SWAR**, SIMD Within A Register: the 8 control bytes are one `uint64`, and a couple of ordinary arithmetic and bitwise tricks on that single word find all matching slots in parallel with no vector unit involved. That choice is what makes the same fast path work on every architecture Go supports, from amd64 to riscv64, with no per-CPU code.
>
> Practical consequences: lookups are faster and more cache-friendly, and rebuilding with Go 1.24+ is all you have to do. The memory effect is workload-dependent rather than a flat win, so measure your own service instead of budgeting for a number from someone else's fleet. Datadog published the most detailed public investigation of the RSS impact across a large Go deployment, and it is worth reading precisely because it shows the effect varies with map size distribution.

```go
package pointer_reduction

import (
	"sync"
)

// InternedStringMap stores string keys as integer IDs.
// When the GC scans a map[string]V, it must scan every key string.
// Using map[int32]V with a string→ID lookup removes string pointers from the hot map.
type InternedStringMap[V any] struct {
	intern  map[string]int32 // string → id (cold path)
	data    map[int32]V      // id → value (hot path, no string pointers)
	nextID  int32
	mu      sync.RWMutex
}

func NewInternedStringMap[V any]() *InternedStringMap[V] {
	return &InternedStringMap[V]{
		intern: make(map[string]int32),
		data:   make(map[int32]V),
	}
}

// Set stores a value for a string key.
func (m *InternedStringMap[V]) Set(key string, val V) {
	m.mu.Lock()
	defer m.mu.Unlock()

	id, ok := m.intern[key]
	if !ok {
		id = m.nextID
		m.nextID++
		m.intern[key] = id
	}
	m.data[id] = val
}

// Get retrieves a value by string key.
func (m *InternedStringMap[V]) Get(key string) (V, bool) {
	m.mu.RLock()
	id, ok := m.intern[key]
	m.mu.RUnlock()

	if !ok {
		var zero V
		return zero, false
	}

	m.mu.RLock()
	val, ok := m.data[id]
	m.mu.RUnlock()
	return val, ok
}

// PointerFreeQueue stores elements as values (not pointers).
// A []T queue with value types has no internal pointers for GC to scan.
// A []*T queue requires GC to scan every slot.
type PointerFreeQueue[T any] struct {
	data []T
	head int
	tail int
	size int
}

func NewPointerFreeQueue[T any](capacity int) *PointerFreeQueue[T] {
	return &PointerFreeQueue[T]{
		data: make([]T, capacity),
	}
}

func (q *PointerFreeQueue[T]) Enqueue(item T) bool {
	if q.size == len(q.data) {
		return false
	}
	q.data[q.tail] = item
	q.tail = (q.tail + 1) % len(q.data)
	q.size++
	return true
}

func (q *PointerFreeQueue[T]) Dequeue() (T, bool) {
	var zero T
	if q.size == 0 {
		return zero, false
	}
	item := q.data[q.head]
	q.data[q.head] = zero // Clear to allow GC of pointed-to objects.
	q.head = (q.head + 1) % len(q.data)
	q.size--
	return item, true
}

func (q *PointerFreeQueue[T]) Len() int { return q.size }
```

### 5.3 The pointer-density rule of thumb

GC scan cost is driven by the pointers the collector must follow, not by bytes of memory. A 64 MB slice of `int64` is nearly free to scan: the type has no pointers, so the collector's pointer bitmap for it is empty and it can skip the whole span. A 64 MB slice of `*Something` holds 8 million pointers (64 MB divided by 8 bytes per pointer), and every one of them is an edge the mark phase must follow, on every cycle, forever. Same bytes, wildly different GC cost. This asymmetry is the single most actionable insight in GC tuning.

Before reaching for a `GOGC` change, audit your hot data structures for pointer fields that could become value fields. Common wins: replace `[]*Foo` with `[]Foo` when lifetime allows, replace `map[string]*User` with `map[uint64]User` (key by numeric ID, store values inline), replace `string` fields with `[N]byte` when the length is bounded and known, and store `time.Time` inline rather than as a pointer since it is already a small value type.

You do not have to take this on faith, and you should not take a wall-clock benchmark's word for it either, since GC timings wobble badly on a loaded machine. There is a deterministic way to see it. The `/gc/scan/heap:bytes` metric in `runtime/metrics` reports exactly how many bytes of heap the collector considers scannable, and it does not care how busy your CPU is. Allocating one million elements each way and reading it after a forced GC (Go 1.27.1, linux/amd64):

| Allocation | Scannable heap added |
| --- | --- |
| `make([]Something, 1<<20)`, `Something{a, b int64}` | about 2.8 KB |
| `make([]*Something, 1<<20)` plus a million `&Something{}` | about 8.4 MB |

Both hold a million elements. The value slice occupies 16 MB of memory and adds essentially nothing the GC has to look at, because the type contains no pointers, so its span carries an empty pointer bitmap and the mark phase skips it wholesale. The pointer slice adds 8.4 MB of scannable heap, which is the eight million pointers (1,048,576 times 8 bytes) the collector must now follow on every cycle. That is a factor of three thousand in GC scan work, from a change that looks in the source like nothing more than removing an asterisk.

Reproduce it in your own service the same way: read `/gc/scan/heap:bytes` before and after, and confirm with `GODEBUG=gctrace=1` that mark time and GC CPU moved. What that buys in your p99 is workload-specific, so measure rather than trusting a tidy figure like "a percentage point or two" from any book, this one included. Stack enough of these and the GC stops being your bottleneck with no `GOGC` change at all.

### 5.4 Junior → FAANG: the Bigcache and Freecache lesson

Two popular caches in the Go ecosystem, `bigcache` and `freecache`, solve the same problem: a multi-gigabyte in-process cache that does not blow up GC scan time. Both work by storing all values in one or a few giant byte slices with integer offsets, so the GC sees O(1) pointers regardless of the number of cache entries. Read the README and source of either. You will learn three techniques at once: flat-slice storage to eliminate pointers, shard-level mutexes to reduce contention, and FIFO eviction to bound memory. These are the patterns that turn "I want a 10 GB cache in my Go service" from a GC disaster into a well-behaved system. An hour reading `bigcache`'s source teaches you more about GC-friendly design than any book chapter can.

### 5.5 Senior @ FAANG: when off-heap storage is worth the complexity

Off-heap storage via `mmap` is attractive in theory: zero GC scan cost, full control over lifetime, interoperable with memory-mapped files. In practice, it introduces an entire parallel memory model that your team must learn, debug, and maintain. Off-heap allocations will not appear in `pprof` heap profiles, will not be tracked by `runtime/metrics`, and will not honor `GOMEMLIMIT`, so an off-heap leak can OOM-kill a service with an apparently healthy Go heap. Cleanup is manual, and a missed `munmap` is silent. The staff-level judgment: reach for off-heap only when you can point at a profile showing GC scan dominates, when the data is genuinely large (multiple GB, not hundreds of MB), and when the lifetime is coarse-grained (whole cache, not individual entries). For everything else, flatten pointer density in the heap instead. When you do go off-heap, wrap it in a type with explicit `Close` semantics, test the cleanup path, and document the operational contract ("this process requires N GB of anonymous memory not counted against the Go heap"). Half the value of off-heap memory comes from the discipline the wrapper enforces.

---
