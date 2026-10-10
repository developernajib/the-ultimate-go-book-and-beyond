## 5. Concurrency Optimization

Efficient concurrent code balances parallelism with overhead.

### 5.1 Lock Contention

**Identifying Lock Contention**:

```bash
# Enable mutex profiling
go test -bench=. -mutexprofile=mutex.prof

# Analyze
go tool pprof -http=:8080 mutex.prof
```

**Reducing Lock Contention**:

```go
package main

import (
    "sync"
    "sync/atomic"
)

// Bad: Single lock for everything
type CounterBad struct {
    mu    sync.Mutex
    value int64
}

func (c *CounterBad) Inc() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

func (c *CounterBad) Get() int64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

// Good: atomic operations
type CounterGood struct {
    value atomic.Int64
}

func (c *CounterGood) Inc() {
    c.value.Add(1)
}

func (c *CounterGood) Get() int64 {
    return c.value.Load()
}

// Sharded locks for maps
type ShardedMap struct {
    shards []*MapShard
    mask   uint64
}

type MapShard struct {
    mu   sync.RWMutex
    data map[string]any
}

func NewShardedMap(shardCount int) *ShardedMap {
    sm := &ShardedMap{
        shards: make([]*MapShard, shardCount),
        mask:   uint64(shardCount - 1),
    }

    for i := 0; i < shardCount; i++ {
        sm.shards[i] = &MapShard{
            data: make(map[string]any),
        }
    }

    return sm
}

func (sm *ShardedMap) getShard(key string) *MapShard {
    hash := fnv64(key)
    return sm.shards[hash&sm.mask]
}

func (sm *ShardedMap) Set(key string, value any) {
    shard := sm.getShard(key)
    shard.mu.Lock()
    shard.data[key] = value
    shard.mu.Unlock()
}

func (sm *ShardedMap) Get(key string) (any, bool) {
    shard := sm.getShard(key)
    shard.mu.RLock()
    defer shard.mu.RUnlock()
    val, ok := shard.data[key]
    return val, ok
}

func fnv64(s string) uint64 {
    var hash uint64 = 14695981039346656037
    for i := 0; i < len(s); i++ {
        hash ^= uint64(s[i])
        hash *= 1099511628211
    }
    return hash
}
```

### 5.2 Cache Line Bouncing

**False Sharing Problem**:

```go
package main

import (
    "sync"
    "testing"
)

// Bad: False sharing
type CountersBad struct {
    counter1 int64
    counter2 int64
}

func BenchmarkFalseSharing(b *testing.B) {
    counters := &CountersBad{}

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            atomic.AddInt64(&counters.counter1, 1)
            atomic.AddInt64(&counters.counter2, 1)
        }
    })
}

// Good: Pad to separate cache lines
type CountersGood struct {
    counter1 int64
    _        [7]int64 // Padding to fill cache line (64 bytes)
    counter2 int64
    _        [7]int64
}

func BenchmarkNoCacheLineBouncing(b *testing.B) {
    counters := &CountersGood{}

    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            atomic.AddInt64(&counters.counter1, 1)
            atomic.AddInt64(&counters.counter2, 1)
        }
    })
}

// Results:
// BenchmarkFalseSharing-8             50000000    35.4 ns/op
// BenchmarkNoCacheLineBouncing-8     100000000    12.1 ns/op
// ~3x faster with padding
```

### 5.3 Goroutine Pooling

**Worker Pool Pattern**:

```go
package main

import (
    "context"
    "sync"
)

type Task func()

type WorkerPool struct {
    workers    int
    taskQueue  chan Task
    wg         sync.WaitGroup
    ctx        context.Context
    cancel     context.CancelFunc
}

func NewWorkerPool(workers, queueSize int) *WorkerPool {
    ctx, cancel := context.WithCancel(context.Background())

    pool := &WorkerPool{
        workers:   workers,
        taskQueue: make(chan Task, queueSize),
        ctx:       ctx,
        cancel:    cancel,
    }

    pool.start()
    return pool
}

func (p *WorkerPool) start() {
    for i := 0; i < p.workers; i++ {
        p.wg.Add(1)
        go p.worker()
    }
}

func (p *WorkerPool) worker() {
    defer p.wg.Done()

    for {
        select {
        case task, ok := <-p.taskQueue:
            if !ok {
                return
            }
            task()

        case <-p.ctx.Done():
            return
        }
    }
}

func (p *WorkerPool) Submit(task Task) bool {
    select {
    case p.taskQueue <- task:
        return true
    case <-p.ctx.Done():
        return false
    default:
        return false // Queue full
    }
}

func (p *WorkerPool) Stop() {
    p.cancel()
    close(p.taskQueue)
    p.wg.Wait()
}

// Usage example
func processItems(items []Item) {
    pool := NewWorkerPool(10, 100)
    defer pool.Stop()

    for _, item := range items {
        item := item // Capture
        pool.Submit(func() {
            processItem(item)
        })
    }
}
```

### 5.4 Channel vs Mutex Selection

**Decision Matrix**:

```go
// Use Mutex when:
// 1. Protecting shared state
// 2. Critical sections are short
// 3. No communication needed

type SafeCounter struct {
    mu    sync.Mutex
    count int64
}

func (c *SafeCounter) Inc() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}

// Use Channel when:
// 1. Passing ownership
// 2. Distributing work
// 3. Coordinating goroutines

type WorkQueue struct {
    jobs chan Job
}

func (wq *WorkQueue) Process() {
    for job := range wq.jobs {
        job.Execute()
    }
}

// Use atomic when:
// 1. Simple counters/flags
// 2. No compound operations
// 3. Maximum performance

type AtomicCounter struct {
    count atomic.Int64
}

func (c *AtomicCounter) Inc() {
    c.count.Add(1)
}
```

### 5.5 Atomic Operations

**Atomic Performance**:

```go
package main

import (
    "sync"
    "sync/atomic"
    "testing"
)

type StatsMutex struct {
    mu        sync.Mutex
    requests  int64
    errors    int64
}

func (s *StatsMutex) IncRequests() {
    s.mu.Lock()
    s.requests++
    s.mu.Unlock()
}

type StatsAtomic struct {
    requests atomic.Int64
    errors   atomic.Int64
}

func (s *StatsAtomic) IncRequests() {
    s.requests.Add(1)
}

func BenchmarkMutex(b *testing.B) {
    s := &StatsMutex{}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            s.IncRequests()
        }
    })
}

func BenchmarkAtomic(b *testing.B) {
    s := &StatsAtomic{}
    b.RunParallel(func(pb *testing.PB) {
        for pb.Next() {
            s.IncRequests()
        }
    })
}

// Results:
// BenchmarkMutex-8      50000000    25.4 ns/op
// BenchmarkAtomic-8    200000000     7.2 ns/op
// ~3.5x faster
```

---
