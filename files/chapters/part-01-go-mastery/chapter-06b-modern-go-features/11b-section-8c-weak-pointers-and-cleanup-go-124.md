## Section 8C: Go 1.24 Weak Pointers & Safe Cleanups (`weak.Pointer` & `runtime.AddCleanup`)

Go 1.24 introduced the `weak` package alongside `runtime.AddCleanup`, providing a native mechanism for holding references to objects without preventing the garbage collector from reclaiming them.

> **Production Context & Article Reference**:
> This pattern and its production memory dynamics are detailed by Renaldi Purwanto in [*Go 1.24 Added Weak Pointers. Most Developers Do Not Know When to Use Them*](https://medium.com/@renaldipurwanto/go-1-24-added-weak-pointers-most-developers-do-not-know-when-to-use-them).

---

### 8C.1 The Problem: The Eviction Policy Trap in Caches

A standard Go pointer is a *strong pointer*: as long as a pointer to an object exists anywhere in the reachable object graph, the GC will never free that memory. 

In high-throughput services, engineers frequently build in-memory caches to avoid recomputing or refetching expensive objects (such as parsed ASTs, decoded schema descriptors, or canonicalized token strings). Before Go 1.24, an in-memory cache using `sync.Map` had an intractable trade-off:

1. **Memory Leak**: The map holds strong pointers, preventing the GC from ever freeing cached objects, even if no other goroutine is actively using them.
2. **Artificial Eviction Heuristics**: To avoid unbounded memory growth, teams implement LRU (Least Recently Used) or time-based TTL eviction. However, choosing a TTL (e.g., 5 minutes) is a blunt heuristic: under sudden memory pressure, the cache still consumes RAM, while during idle periods, active objects may get evicted prematurely, causing latency spikes.

---

### 8C.2 The Solution: `weak.Pointer[T]`

A weak pointer references an object without adding an edge to the garbage collector's reachability graph. When the GC sweeps, if an object has only weak references remaining, it is immediately collected.

```go
package main

import (
	"fmt"
	"runtime"
	"weak"
)

type DocumentNode struct {
	ID   string
	Data []byte
}

func main() {
	// Allocate an expensive object
	node := &DocumentNode{
		ID:   "doc-4029",
		Data: make([]byte, 1024*1024), // 1MB
	}

	// Create a weak pointer targeting the node
	wp := weak.Make(node)

	// Dereferencing returns a strong pointer (*DocumentNode) if alive, or nil if collected
	if strong := wp.Value(); strong != nil {
		fmt.Printf("Object is alive: %s\n", strong.ID)
	}

	// Drop the only strong reference
	node = nil

	// Force a GC cycle
	runtime.GC()

	// Re-check weak pointer
	if strong := wp.Value(); strong == nil {
		fmt.Println("Object was collected by GC without manual cache eviction!")
	}
}
```

### Key Semantics:
- **Atomicity of `wp.Value()`**: Calling `wp.Value()` yields a strong pointer. As long as you hold this returned strong pointer in local scope, the object cannot be collected during your operation. Once that variable goes out of scope, the GC is free to reclaim it.
- **Type Safety**: `weak.Pointer[T]` is a generic type where `T` can be any type.

---

### 8C.3 The Production Pattern: Canonical In-Memory Deduplication Cache

The canonical production use case for weak pointers is **canonicalization (interning)**: ensuring that identical objects share memory while in active use, but vanish automatically when no longer needed.

```go
package cache

import (
	"sync"
	"weak"
)

// InternPool provides automatic deduplication without manual eviction
type InternPool[K comparable, V any] struct {
	mu    sync.RWMutex
	store map[K]weak.Pointer[V]
}

func NewInternPool[K comparable, V any]() *InternPool[K, V] {
	return &InternPool[K, V]{
		store: make(map[K]weak.Pointer[V]),
	}
}

// GetOrCompute retrieves the existing in-flight instance or initializes a new one.
func (p *InternPool[K, V]) GetOrCompute(key K, compute func() *V) *V {
	p.mu.RLock()
	if wp, ok := p.store[key]; ok {
		if val := wp.Value(); val != nil {
			p.mu.RUnlock()
			return val
		}
	}
	p.mu.RUnlock()

	p.mu.Lock()
	defer p.mu.Unlock()

	// Double-check under write lock
	if wp, ok := p.store[key]; ok {
		if val := wp.Value(); val != nil {
			return val
		}
	}

	newVal := compute()
	p.store[key] = weak.Make(newVal)
	return newVal
}
```

---

### 8C.4 Replacing `runtime.SetFinalizer` with `runtime.AddCleanup`

Prior to Go 1.24, running cleanup code when an object was reclaimed required `runtime.SetFinalizer`. Finalizers had notorious design flaws:
- They delayed memory reclamation by at least one full GC cycle.
- They caused "object resurrection" because the finalizer received a strong pointer back to the object.
- Cyclic references between objects with finalizers could never be collected, creating permanent memory leaks.

Go 1.24 introduced `runtime.AddCleanup`, which fixes every flaw:

```go
package resource

import (
	"os"
	"runtime"
)

type FileHandle struct {
	fd uintptr
}

func NewFileHandle(path string) (*FileHandle, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	h := &FileHandle{fd: file.Fd()}

	// AddCleanup does NOT take a reference to `h`.
	// It passes an independent value (`h.fd`) to the cleanup callback.
	// This makes object resurrection impossible!
	runtime.AddCleanup(h, func(fd uintptr) {
		// Native cleanup executed when `h` becomes unreachable
		_ = closeFd(fd)
	}, h.fd)

	return h, nil
}

func closeFd(fd uintptr) error {
	// Syscall close
	return nil
}
```

| Feature | `runtime.SetFinalizer` (Legacy) | `runtime.AddCleanup` (Go 1.24+) |
|---|---|---|
| **Resurrection Risk** | High (passes `*T` into callback) | **Zero** (passes separate closure arg) |
| **GC Cycles to Free** | 2 GC cycles | **1 GC cycle** |
| **Cycles Support** | Fails on cyclic graphs | **Collects cleanly** |
| **Order of Execution** | Unspecified | Guaranteed post-unreachability |
