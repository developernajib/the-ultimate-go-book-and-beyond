## 90K.6 Spirit Rover Flash Memory Bug (2004)

On January 3, 2004, NASA's Spirit rover landed on Mars. It transmitted spectacular
images for 18 sols (Martian days). Then, on Sol 18, Spirit stopped communicating. When
engineers managed to establish a low-bandwidth communication session, they discovered
the rover was trapped in an infinite reboot loop.

### What Happened

Spirit used a flash memory filesystem to persist data across reboots. Over the first 18
sols, the rover had been accumulating files in its flash filesystem: images, science data,
telemetry logs, and operational data. The filesystem was a FAT-like (File Allocation
Table) implementation designed for simplicity and reliability.

The problem was that the filesystem driver attempted to load a directory of all files in
flash memory into RAM during boot. After 18 sols of operations, the number of files had
grown to the point where loading the file directory consumed all available RAM. The boot
sequence ran out of memory, crashed, and triggered a reboot. The reboot attempted to load
the same file directory, ran out of memory, crashed, and rebooted. An infinite loop.

The root cause was two-fold:
1. **Unbounded accumulation.** The flight software did not enforce a maximum number of
   files. Files were created during normal operations but never cleaned up.
2. **Boot dependency on runtime data.** The boot sequence depended on reading all
   accumulated runtime data, creating a coupling between operational history and boot
   reliability.

### The Fix

NASA engineers uploaded a fix that bypassed the flash filesystem entirely during boot.
The rover booted into a minimal mode using only RAM, which allowed engineers to delete
the excess files from flash memory. Once the file count was reduced, normal boot resumed.
Spirit went on to operate for over six years - far exceeding its 90-sol planned mission.

### Bounded Resources in Go

The Spirit bug teaches a universal lesson: **any resource that grows without bound will
eventually exhaust its container.** In Go, this applies to goroutines, open files,
database connections, cache entries, log files, and channel buffers.

```go
package nasa

import (
    "context"
    "errors"
    "fmt"
    "os"
    "path/filepath"
    "sync"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, message string) {
    if !condition {
        panic("assertion failed: " + message)
    }
}

// === Bounded File Storage ===
// Inspired by the Spirit rover bug: never allow unbounded file accumulation.

// BoundedFileStore manages files with a hard upper limit.
// Unlike Spirit's flash filesystem, this store enforces the bound
// at write time, preventing the accumulation that caused the reboot loop.
type BoundedFileStore struct {
    mu       sync.Mutex
    dir      string
    maxFiles int
    maxBytes int64
    files    []fileEntry
}

type fileEntry struct {
    name      string
    size      int64
    createdAt time.Time
}

// NewBoundedFileStore creates a file store with bounded capacity.
func NewBoundedFileStore(dir string, maxFiles int, maxBytes int64) (*BoundedFileStore, error) {
    Assert(maxFiles > 0, "maxFiles must be positive")
    Assert(maxBytes > 0, "maxBytes must be positive")

    if err := os.MkdirAll(dir, 0750); err != nil {
        return nil, fmt.Errorf("failed to create directory: %w", err)
    }

    return &BoundedFileStore{
        dir:      dir,
        maxFiles: maxFiles,
        maxBytes: maxBytes,
        files:    make([]fileEntry, 0, maxFiles),
    }, nil
}

// Write creates a file, evicting the oldest file if necessary.
// This is the key difference from Spirit: the bound is enforced
// BEFORE writing, not discovered during boot.
func (fs *BoundedFileStore) Write(name string, data []byte) error {
    fs.mu.Lock()
    defer fs.mu.Unlock()

    if int64(len(data)) > fs.maxBytes {
        return fmt.Errorf("file size %d exceeds maximum %d", len(data), fs.maxBytes)
    }

    // Evict oldest files until we have room.
    for len(fs.files) >= fs.maxFiles {
        if err := fs.evictOldest(); err != nil {
            return fmt.Errorf("eviction failed: %w", err)
        }
    }

    // Ensure total bytes don't exceed limit.
    totalBytes := int64(len(data))
    for _, f := range fs.files {
        totalBytes += f.size
    }
    for totalBytes > fs.maxBytes && len(fs.files) > 0 {
        oldest := fs.files[0]
        totalBytes -= oldest.size
        if err := fs.evictOldest(); err != nil {
            return fmt.Errorf("byte-limit eviction failed: %w", err)
        }
    }

    path := filepath.Join(fs.dir, name)
    if err := os.WriteFile(path, data, 0640); err != nil {
        return fmt.Errorf("write failed: %w", err)
    }

    fs.files = append(fs.files, fileEntry{
        name:      name,
        size:      int64(len(data)),
        createdAt: time.Now().UTC(),
    })

    return nil
}

// evictOldest removes the oldest file.
func (fs *BoundedFileStore) evictOldest() error {
    if len(fs.files) == 0 {
        return errors.New("no files to evict")
    }

    oldest := fs.files[0]
    path := filepath.Join(fs.dir, oldest.name)
    if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
        return fmt.Errorf("failed to remove %s: %w", oldest.name, err)
    }

    fs.files = fs.files[1:]
    return nil
}

// Count returns the current number of files.
func (fs *BoundedFileStore) Count() int {
    fs.mu.Lock()
    defer fs.mu.Unlock()
    return len(fs.files)
}

// === Bounded Goroutine Pool ===
// Go equivalent of Spirit's unbounded file accumulation:
// unbounded goroutine creation that exhausts memory.

// BoundedWorkerPool limits concurrent goroutines to a fixed maximum.
// Prevents the Go equivalent of Spirit's unbounded resource growth.
type BoundedWorkerPool struct {
    sem    chan struct{}
    wg     sync.WaitGroup
    ctx    context.Context
    cancel context.CancelFunc
}

// NewBoundedWorkerPool creates a pool with a hard goroutine limit.
func NewBoundedWorkerPool(maxWorkers int) *BoundedWorkerPool {
    Assert(maxWorkers > 0, "maxWorkers must be positive")
    Assert(maxWorkers <= 10000, "maxWorkers exceeds safety limit")

    ctx, cancel := context.WithCancel(context.Background())
    return &BoundedWorkerPool{
        sem:    make(chan struct{}, maxWorkers),
        ctx:    ctx,
        cancel: cancel,
    }
}

// Submit submits work to the pool. Blocks if all workers are busy.
// Returns an error if the pool is shut down or the context expires.
func (p *BoundedWorkerPool) Submit(ctx context.Context, task func() error) error {
    select {
    case <-p.ctx.Done():
        return errors.New("worker pool is shut down")
    case <-ctx.Done():
        return ctx.Err()
    case p.sem <- struct{}{}:
    }

    p.wg.Add(1)
    go func() {
        defer p.wg.Done()
        defer func() { <-p.sem }()
        defer func() {
            if r := recover(); r != nil {
                // Log but don't crash - NASA never lets a subsystem
                // crash take down the whole spacecraft.
                fmt.Printf("worker panic recovered: %v\n", r)
            }
        }()

        _ = task() // Error handling is the task's responsibility.
    }()

    return nil
}

// Shutdown stops accepting new work and waits for existing work to finish.
func (p *BoundedWorkerPool) Shutdown(timeout time.Duration) error {
    p.cancel()

    done := make(chan struct{})
    go func() {
        p.wg.Wait()
        close(done)
    }()

    select {
    case <-done:
        return nil
    case <-time.After(timeout):
        return errors.New("worker pool shutdown timed out")
    }
}

// ActiveWorkers returns the number of currently running workers.
func (p *BoundedWorkerPool) ActiveWorkers() int {
    return len(p.sem)
}

// === Bounded Cache ===
// Another unbounded-growth pattern: caches that grow without limit.

// BoundedLRUCache is a fixed-size cache that evicts least-recently-used
// entries when full. Unlike a map that grows forever (Spirit-style),
// this cache has a hard upper bound on memory consumption.
type BoundedLRUCache[K comparable, V any] struct {
    mu       sync.Mutex
    items    map[K]*cacheEntry[K, V]
    order    []*cacheEntry[K, V] // LRU order: oldest at front.
    maxItems int
}

type cacheEntry[K comparable, V any] struct {
    key       K
    value     V
    accessedAt time.Time
}

// NewBoundedLRUCache creates a cache with a fixed maximum size.
func NewBoundedLRUCache[K comparable, V any](maxItems int) *BoundedLRUCache[K, V] {
    Assert(maxItems > 0, "maxItems must be positive")

    return &BoundedLRUCache[K, V]{
        items:    make(map[K]*cacheEntry[K, V], maxItems),
        order:    make([]*cacheEntry[K, V], 0, maxItems),
        maxItems: maxItems,
    }
}

// Get retrieves a value and marks it as recently used.
func (c *BoundedLRUCache[K, V]) Get(key K) (V, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    entry, ok := c.items[key]
    if !ok {
        var zero V
        return zero, false
    }

    entry.accessedAt = time.Now()
    c.moveToBack(entry)

    return entry.value, true
}

// Put adds or updates a value. Evicts LRU entry if at capacity.
func (c *BoundedLRUCache[K, V]) Put(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if existing, ok := c.items[key]; ok {
        existing.value = value
        existing.accessedAt = time.Now()
        c.moveToBack(existing)
        return
    }

    // Evict if at capacity.
    for len(c.items) >= c.maxItems && len(c.order) > 0 {
        oldest := c.order[0]
        c.order = c.order[1:]
        delete(c.items, oldest.key)
    }

    entry := &cacheEntry[K, V]{
        key:       key,
        value:     value,
        accessedAt: time.Now(),
    }
    c.items[key] = entry
    c.order = append(c.order, entry)
}

// moveToBack moves an entry to the end of the LRU order.
func (c *BoundedLRUCache[K, V]) moveToBack(target *cacheEntry[K, V]) {
    for i, entry := range c.order {
        if entry == target {
            c.order = append(c.order[:i], c.order[i+1:]...)
            c.order = append(c.order, target)
            return
        }
    }
}

// Size returns the current number of entries.
func (c *BoundedLRUCache[K, V]) Size() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return len(c.items)
}
```

---
