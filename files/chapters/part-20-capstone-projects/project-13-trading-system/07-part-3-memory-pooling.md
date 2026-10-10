## Part 3: Memory Pooling

Memory pooling is critical for reducing GC pressure in high-frequency trading. Every time you allocate a new object with `new` or `make`, Go's garbage collector eventually has to reclaim that memory, causing brief pauses that disrupt latency-sensitive operations. A memory pool pre-allocates a fixed number of objects at startup and recycles them instead of creating new ones. When you need an order object, you grab one from the pool, and when you are done, you return it. This keeps the garbage collector almost idle, which is essential for maintaining sub-millisecond GC pause times.

```go
// pkg/pool/pool.go
package pool

import (
	"sync"
	"github.com/yourusername/trading-system/pkg/types"
)

// OrderPool pools Order objects
type OrderPool struct {
	pool sync.Pool
}

// NewOrderPool creates a new order pool
func NewOrderPool() *OrderPool {
	return &OrderPool{
		pool: sync.Pool{
			New: func() any {
				return &types.Order{
					Tags: make(map[string]string),
				}
			},
		},
	}
}

// Get retrieves an order from pool
func (p *OrderPool) Get() *types.Order {
	return p.pool.Get().(*types.Order)
}

// Put returns an order to pool
func (p *OrderPool) Put(order *types.Order) {
	// Reset order state
	order.ID = ""
	order.ClientOrderID = ""
	order.AccountID = ""
	order.Symbol = ""
	order.Side = 0
	order.Type = 0
	order.Price = 0
	order.StopPrice = 0
	order.Quantity = 0
	order.FilledQuantity = 0
	order.RemainingQty = 0
	order.Status = 0
	order.StrategyID = ""

	// Clear map but reuse allocation
	for k := range order.Tags {
		delete(order.Tags, k)
	}

	p.pool.Put(order)
}

// FillPool pools Fill objects
type FillPool struct {
	pool sync.Pool
}

// NewFillPool creates a new fill pool
func NewFillPool() *FillPool {
	return &FillPool{
		pool: sync.Pool{
			New: func() any {
				return &types.Fill{}
			},
		},
	}
}

// Get retrieves a fill from pool
func (p *FillPool) Get() *types.Fill {
	return p.pool.Get().(*types.Fill)
}

// Put returns a fill to pool
func (p *FillPool) Put(fill *types.Fill) {
	// Reset state
	*fill = types.Fill{}
	p.pool.Put(fill)
}

// LevelPool pools order book levels
type LevelPool struct {
	pool sync.Pool
}

// NewLevelPool creates a new level pool
func NewLevelPool() *LevelPool {
	return &LevelPool{
		pool: sync.Pool{
			New: func() any {
				return &types.Level{}
			},
		},
	}
}

// Get retrieves a level from pool
func (p *LevelPool) Get() *types.Level {
	return p.pool.Get().(*types.Level)
}

// Put returns a level to pool
func (p *LevelPool) Put(level *types.Level) {
	*level = types.Level{}
	p.pool.Put(level)
}

// SlicePool pools slices to reduce allocations
type SlicePool[T any] struct {
	pool sync.Pool
}

// NewSlicePool creates a slice pool with initial capacity
func NewSlicePool[T any](capacity int) *SlicePool[T] {
	return &SlicePool[T]{
		pool: sync.Pool{
			New: func() any {
				s := make([]T, 0, capacity)
				return &s
			},
		},
	}
}

// Get retrieves a slice from pool
func (p *SlicePool[T]) Get() *[]T {
	slice := p.pool.Get().(*[]T)
	*slice = (*slice)[:0] // Reset length but keep capacity
	return slice
}

// Put returns a slice to pool
func (p *SlicePool[T]) Put(slice *[]T) {
	*slice = (*slice)[:0]
	p.pool.Put(slice)
}
```
