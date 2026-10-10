## Deep Dive: GPU Memory Pool (PagedAttention)

This component implements the core idea behind PagedAttention at the Go orchestration layer. GPU VRAM is divided into fixed-size pages, and each inference request is assigned pages on demand rather than reserving a large contiguous block upfront. When a request finishes or gets preempted, its pages return to the free pool immediately. The pool also supports a preemption strategy: when memory runs out, the lowest-priority request is evicted to make room for higher-priority work.

```go
package gpu

import (
	"fmt"
	"sync"
)

type GPUMemoryPool struct {
	pageSize    int
	totalPages  int
	freePages   []int
	allocations map[string][]int
	mu          sync.Mutex
}

// NewGPUMemoryPool sizes pages using the KV cache formula:
// pageSize tokens x layers x 2 (K and V) x kvHeads x headDim x 2 bytes (fp16)
func NewGPUMemoryPool(vramBytes int64, pageSize, layers, kvHeads, headDim int) *GPUMemoryPool {
	bytesPerPage := int64(pageSize) * int64(layers) * 2 * int64(kvHeads) * int64(headDim) * 2
	total := int(vramBytes / bytesPerPage)

	free := make([]int, total)
	for i := range free {
		free[i] = i
	}

	return &GPUMemoryPool{
		pageSize:    pageSize,
		totalPages:  total,
		freePages:   free,
		allocations: make(map[string][]int),
	}
}

func (p *GPUMemoryPool) AllocatePages(reqID string, n int) ([]int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.freePages) < n {
		return nil, fmt.Errorf("insufficient VRAM: need %d pages, have %d", n, len(p.freePages))
	}

	// Copy the page IDs so the caller's slice never aliases the free list
	alloc := make([]int, n)
	copy(alloc, p.freePages[:n])
	p.freePages = p.freePages[n:]

	p.allocations[reqID] = append(p.allocations[reqID], alloc...)
	return alloc, nil
}

// GrowAllocation adds one page as the sequence generates more tokens
func (p *GPUMemoryPool) GrowAllocation(reqID string) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.freePages) == 0 {
		return -1, fmt.Errorf("VRAM exhausted")
	}

	page := p.freePages[0]
	p.freePages = p.freePages[1:]
	p.allocations[reqID] = append(p.allocations[reqID], page)
	return page, nil
}

func (p *GPUMemoryPool) FreeAllocation(reqID string) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if pages, ok := p.allocations[reqID]; ok {
		p.freePages = append(p.freePages, pages...)
		delete(p.allocations, reqID)
	}
}

func (p *GPUMemoryPool) Utilization() float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return float64(p.totalPages-len(p.freePages)) / float64(p.totalPages) * 100
}

// PreemptLowestPriority evicts the request with the smallest priority
// value (0 = normal outranks nothing, higher numbers win) and returns
// its pages to the free pool
func (p *GPUMemoryPool) PreemptLowestPriority(priorities map[string]int) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	lowest, lowestID := 999, ""
	for id := range p.allocations {
		if pri, ok := priorities[id]; ok && pri < lowest {
			lowest = pri
			lowestID = id
		}
	}
	if lowestID == "" {
		return "", fmt.Errorf("nothing to preempt")
	}

	p.freePages = append(p.freePages, p.allocations[lowestID]...)
	delete(p.allocations, lowestID)
	return lowestID, nil
}
```

---
