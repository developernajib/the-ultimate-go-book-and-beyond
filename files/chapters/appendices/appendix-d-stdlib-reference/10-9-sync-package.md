## 9. sync Package

### Mutex and RWMutex

`sync.Mutex` provides mutual exclusion: only one goroutine can hold the lock at a time. `sync.RWMutex` allows multiple concurrent readers but exclusive writers. Use `RWMutex` when reads vastly outnumber writes.

```go
package main

import (
    "fmt"
    "sync"
)

// Thread-safe counter
type Counter struct {
    mu    sync.Mutex
    value int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.value++
}

func (c *Counter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}

// Read-write mutex for read-heavy workloads
type Cache struct {
    mu    sync.RWMutex
    items map[string]string
}

func NewCache() *Cache {
    return &Cache{
        items: make(map[string]string),
    }
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    val, ok := c.items[key]
    return val, ok
}

func (c *Cache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.items[key] = value
}

func mutexExample() {
    counter := &Counter{}
    var wg sync.WaitGroup

    // 100 goroutines incrementing
    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := 0; j < 100; j++ {
                counter.Increment()
            }
        }()
    }

    wg.Wait()
    fmt.Println("Final value:", counter.Value()) // 10000
}
```

### WaitGroup

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func waitGroupExample() {
    var wg sync.WaitGroup

    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            fmt.Printf("Worker %d starting\n", id)
            time.Sleep(time.Second)
            fmt.Printf("Worker %d done\n", id)
        }(i)
    }

    wg.Wait()
    fmt.Println("All workers completed")
}

// Error handling with WaitGroup
func waitGroupWithErrors() error {
    var wg sync.WaitGroup
    errCh := make(chan error, 5)

    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            // Do work
            if id == 3 {
                errCh <- fmt.Errorf("worker %d failed", id)
            }
        }(i)
    }

    // Wait in goroutine
    go func() {
        wg.Wait()
        close(errCh)
    }()

    // Collect errors
    for err := range errCh {
        if err != nil {
            return err
        }
    }

    return nil
}
```

### Once

```go
package main

import (
    "fmt"
    "sync"
)

var (
    instance *Singleton
    once     sync.Once
)

type Singleton struct {
    data string
}

func GetInstance() *Singleton {
    once.Do(func() {
        fmt.Println("Creating singleton instance")
        instance = &Singleton{data: "singleton"}
    })
    return instance
}

func onceExample() {
    var wg sync.WaitGroup

    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            s := GetInstance()
            fmt.Printf("Instance: %p\n", s)
        }()
    }

    wg.Wait()
    // "Creating singleton instance" printed only once
}
```

### Pool

```go
package main

import (
    "bytes"
    "fmt"
    "sync"
)

func poolExample() {
    // Pool of bytes.Buffer
    bufferPool := sync.Pool{
        New: func() any {
            fmt.Println("Creating new buffer")
            return new(bytes.Buffer)
        },
    }

    // Get buffer from pool
    buf := bufferPool.Get().(*bytes.Buffer)
    buf.WriteString("Hello, World!")
    fmt.Println(buf.String())

    // Return to pool (must reset first!)
    buf.Reset()
    bufferPool.Put(buf)

    // Get again (might reuse)
    buf2 := bufferPool.Get().(*bytes.Buffer)
    fmt.Printf("Buffer reused: %p == %p\n", buf, buf2)
}

// Real-world usage: HTTP handler with buffer pool
var httpBufferPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

func handler(w http.ResponseWriter, r *http.Request) {
    buf := httpBufferPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        httpBufferPool.Put(buf)
    }()

    // Use buffer
    buf.WriteString("Response data")
    w.Write(buf.Bytes())
}
```

### Map (Concurrent Map)

```go
package main

import (
    "fmt"
    "sync"
)

func syncMapExample() {
    var m sync.Map

    // Store
    m.Store("key1", "value1")
    m.Store("key2", "value2")

    // Load
    if val, ok := m.Load("key1"); ok {
        fmt.Println("key1:", val)
    }

    // LoadOrStore
    actual, loaded := m.LoadOrStore("key3", "value3")
    fmt.Printf("key3: %v, was loaded: %v\n", actual, loaded)

    // LoadAndDelete
    val, loaded := m.LoadAndDelete("key1")
    fmt.Printf("Deleted key1: %v, existed: %v\n", val, loaded)

    // Range
    m.Range(func(key, value any) bool {
        fmt.Printf("%v: %v\n", key, value)
        return true // continue iteration
    })

    // Delete
    m.Delete("key2")
}

// When to use sync.Map:
// 1. Key set is stable (few writes, many reads)
// 2. Multiple goroutines read/write disjoint key sets
//
// When NOT to use:
// - Heavy write workload: Use map + sync.RWMutex instead
```

### Cond

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func condExample() {
    var mu sync.Mutex
    cond := sync.NewCond(&mu)
    ready := false

    // Waiter goroutines
    for i := 0; i < 3; i++ {
        go func(id int) {
            mu.Lock()
            for !ready {
                cond.Wait() // Releases lock and waits
            }
            fmt.Printf("Worker %d proceeding\n", id)
            mu.Unlock()
        }(i)
    }

    time.Sleep(time.Second)

    // Signal workers
    mu.Lock()
    ready = true
    mu.Unlock()
    cond.Broadcast() // Wake all waiters

    time.Sleep(time.Second)
}

// Practical use: Queue with limited capacity
type Queue struct {
    mu    sync.Mutex
    cond  *sync.Cond
    items []any
    cap   int
}

func NewQueue(capacity int) *Queue {
    q := &Queue{
        items: make([]any, 0),
        cap:   capacity,
    }
    q.cond = sync.NewCond(&q.mu)
    return q
}

func (q *Queue) Enqueue(item any) {
    q.mu.Lock()
    defer q.mu.Unlock()

    // Wait if full
    for len(q.items) >= q.cap {
        q.cond.Wait()
    }

    q.items = append(q.items, item)
    q.cond.Signal() // Wake dequeue waiter
}

func (q *Queue) Dequeue() any {
    q.mu.Lock()
    defer q.mu.Unlock()

    // Wait if empty
    for len(q.items) == 0 {
        q.cond.Wait()
    }

    item := q.items[0]
    q.items = q.items[1:]
    q.cond.Signal() // Wake enqueue waiter
    return item
}
```

---
